import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceChunks, rerankEvents } from '../lib/retrieval.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';
import { renderMemoryEvidence } from '../lib/evidence.js';
import { Neo4jStore } from '../lib/store.js';

const event = (id, content = id) => ({ id, summary: '事实尚待核实', content, contentLength: [...content].length, vector: [1, 0] });
test('source chunks cover Unicode content with overlap and no missing suffix', () => {
  const content = '😀甲'.repeat(1100), parts = sourceChunks(content), points = [...content];
  assert.equal(parts[0].start, 0); assert.equal(parts.at(-1).end, points.length);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(parts[i].text, points.slice(parts[i].start, parts[i].end).join(''));
    assert(parts[i].end - parts[i].start <= 800);
    if (i) assert.equal(parts[i - 1].end - parts[i].start, 120);
  }
  assert.deepEqual(sourceChunks(''), []);
});
test('source-only candidates survive fusion; exact duplicate sources do not crowd out alternatives', () => {
  const a = event('a', '完全重复'), b = event('b', '完全重复'), c = event('c', '地下暗号实际原文');
  const rows = rerankEvents([[a, b], [c, a, b]], '地下暗号', 4);
  assert(rows.some(e => e.id === 'c'));
  assert.equal(rows.filter(e => ['a', 'b'].includes(e.id)).length, 1);
});
test('MMR trades a redundant summary for a different source, with stable ties', () => {
  const a = event('a'), b = event('b'), c = { ...event('c'), vector: [0, 1] };
  assert.deepEqual(rerankEvents([[a, b, c], [a, b, c]], '', 2).map(e => e.id), ['a', 'c']);
});
test('truncated content windows do not prove two full sources are identical', () => {
  const a={...event('a','共同前缀'),contentLength:40000},b={...event('b','共同前缀'),contentLength:40000};
  assert.equal(rerankEvents([[a,b]],'',4).length,2);
});
test('a chapter field or 第N章 query no longer changes the ranking', () => {
  const plain = [event('x'), event('y')], tagged = [{ ...event('x') }, { ...event('y'), chapter: 1 }];
  const base = rerankEvents([plain, plain], '第1章', 2).map(e => e.id);
  assert.deepEqual(base, ['x', 'y']);
  assert.deepEqual(rerankEvents([tagged, tagged], '第1章', 2).map(e => e.id), base);
});
test('candidate fusion refuses duplicate IDs or records changed between routes', async () => {
  const store=new Neo4jStore({embeddingModel:'fixture',dimensions:2},{close:async()=>{}});
  store.run=async()=>[event('a'),event('a')];
  await assert.rejects(store.searchEvidence([1,0],{}),/ambiguous/);
  store.run=async q=>[event('a',q.includes('summary-candidates')?'before':'after')];
  await assert.rejects(store.searchEvidence([1,0],{}),/changed during retrieval/);
});
test('reembedding waits for a pending save and blocks following saves until its snapshot commits', async () => {
  const store=new Neo4jStore({}, {close:async()=>{}}), order=[];
  let finish;const gate=new Promise(resolve=>{finish=resolve;});
  store.saveMemory=async content=>{order.push(content);if(content==='first')await gate;};
  store.reembedMemory=async()=>{order.push('reembed');return {nodes:1};};
  const first=store.save('first'),reembed=store.reembed({}),last=store.save('last');
  await Promise.resolve();assert.deepEqual(order,['first']);finish();
  await Promise.all([first,reembed,last]);assert.deepEqual(order,['first','reembed','last']);
});
test('delivery is serialized per owner, caps all responses, shares quote references, and commits only successes', async t => {
  const cfg = MemoryConfig.fromEnvironment({ neo4jMode: 'external', neo4jPassword: 'fixture' }, {});
  let fail = true;
  const rows = Array.from({ length: 24 }, (_, i) => event(`event_ch01_e${i + 1}`, '相同原文，仅为计划'));
  const store = {
    close: async () => {},
    searchEvidence: async (_v, _f, _s, options) => rows.filter(e => !options.exclude.includes(e.id)),
    evidenceLinks: async ids => { if (fail) throw Error('database unavailable'); return { links: ids.map(eventId => ({eventId, conceptId:'concept_1',name:'计划',degree:30,score:1})), limited:false }; },
    evidenceExisting: async () => {},
    nearbyEvidence: async (_id, seen) => rows.filter(e => !seen.includes(e.id)),
    expandEvidence: async (_concept, seen, _vector, _filter, limit) => rows.filter(e => !seen.includes(e.id)).slice(0,limit),
  };
  const service = new MemoryService(cfg, undefined, store); t.after(() => service.close());
  await assert.rejects(service.call('memory_database_search', { entity_filter: '甲' }), /unavailable/);
  fail = false;
  const [a, b] = await Promise.all([service.call('memory_database_search', { entity_filter:'甲' }), service.call('memory_database_search', { entity_filter:'甲' })]);
  assert.equal(a.data.events.length, 4); assert.equal(b.data.events.length, 4);
  assert.deepEqual(a.data.events.map(e => e.id), rows.slice(0,4).map(e=>e.id));
  assert.deepEqual(b.data.events.map(e => e.id), rows.slice(4,8).map(e=>e.id));
  assert(b.data.events.every(e => e.quoteRef?.id === rows[0].id));
  assert(renderMemoryEvidence(b.data).includes('此前已交付'));
  const other = await service.call('memory_database_search', {entity_filter:'甲',session_id:'other'});
  assert.equal(other.data.events[0].id, rows[0].id);
  let current = a;
  for (let i=0;i<4;i++) current=await service.call('memory_database_search',{operation:'nearby',cursor:current.data.cursor,event_id:rows[0].id});
  assert.equal(current.data.seen,20); assert.equal(current.data.events.length,4);
  assert(service.evidenceCursors.get(current.data.cursor).ids.every(id => !rows.slice(4,8).some(e=>e.id===id)));
  const reset = await service.call('memory_database_search', {entity_filter:'甲',reset_seen:true});
  assert.equal(reset.data.events[0].id,rows[0].id);
  await assert.rejects(service.call('memory_database_search',{operation:'nearby',cursor:a.data.cursor,event_id:rows[0].id}), /cursor expired/);
  current=reset;
  for(let i=0;i<5;i++)current=await service.call('memory_database_search',{operation:'expand',cursor:current.data.cursor,concept_id:'concept_1',limit:3});
  assert.equal(current.data.seen,19);
  const last=await service.call('memory_database_search',{operation:'expand',cursor:current.data.cursor,concept_id:'concept_1',limit:8});
  assert.equal(last.data.events.length,1);assert.equal(last.data.seen,20);
  assert.equal(service.evidenceCursors.get(last.data.cursor).ids.length,20);
});
