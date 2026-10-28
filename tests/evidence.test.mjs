import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildEvidence, evidenceExcerpt, renderMemoryEvidence, sourcePosition } from '../lib/evidence.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';

const event = id => ({ id, summary: '甲只是计划部署 Neo4j，尚未完成。', content: '😀'.repeat(150) + '甲只是计划部署 Neo4j，尚未完成。', contentLength: 170 });
test('evidence compression preserves exact Unicode ranges, qualifiers and real shared concepts', () => {
  const e = event('event_1'), quote = evidenceExcerpt(e.content, 'Neo4j 部署', e.summary, 120);
  assert.equal(Array.from(e.content).slice(...quote.range).join(''), quote.text);assert(Array.from(quote.text).length <= 120);assert(quote.text.includes('尚未完成'));
  assert(evidenceExcerpt('x'.repeat(180)+'Neo4j'+'x'.repeat(180),'neo4j','',120).text.includes('Neo4j'));
  const links = [{ eventId: 'event_1', conceptId: 'concept_1', name: 'Neo4j', degree: 4, score: .8 }, { eventId: 'event_2', conceptId: 'concept_1', name: 'Neo4j', degree: 4, score: .8 }, { eventId: 'event_1', conceptId: 'concept_leaf', name: '叶子', degree: 1, score: 1 }];
  const data = buildEvidence([e], links, ['event_1','event_2'], '部署', 'added');
  assert.equal(data.events[0].summary,e.summary);assert.equal(data.events.length,1);assert.deepEqual(data.shared[0].events,['event_1','event_2']);assert.equal(data.next.concepts.length,1);
  assert.equal(data.next.concepts[0].remaining,2);assert(!JSON.stringify(data).includes('embedding'));
  const text = renderMemoryEvidence(data);assert(text.includes('不代表因果'));assert(text.includes('原文['));assert(!text.includes('Event:'));assert(!text.includes('Concept:'));assert(!text.includes('@'));
  assert.equal(sourcePosition('event_123'),undefined);assert.deepEqual(sourcePosition('event_ch33_e06'),{prefix:'event_ch33_e',record:6});
});

test('date/entity search and source reading require no model key; unsupported follow-ups fail before lookup', async () => {
  const cfg=MemoryConfig.fromEnvironment({neo4jMode:'external',neo4jPassword:'test'},{});let filter;
  const store={close:async()=>{},searchEvidence:async(v,f)=>{assert.equal(v,undefined);filter=f;return [event('event_1')];},evidenceLinks:async()=>({links:[],limited:false}),readEvidence:async(id,start,limit)=>({kind:'source',id,range:[start,start+limit],text:'原文',total:50,next:start+limit})};
  const service=new MemoryService(cfg,undefined,store);
  try{
    const result=await service.call('memory_database_search',{entity_filter:'部署',time_hint:'2026-10-27'});assert.equal(result.data.events.length,1);assert.deepEqual(filter,{entity:'部署',date:'2026-10-27'});
    const source=await service.call('memory_database_search',{operation:'read',event_id:'event_1',start:4,limit:2});assert.deepEqual(source.data.range,[4,6]);
    await assert.rejects(service.call('memory_database_search',{operation:'read',event_id:'event_1',limit:1.5}),/Invalid limit/);
    await assert.rejects(service.call('memory_database_search',{operation:'expand',cursor:result.data.cursor,concept_id:'missing'}),/Choose concept_id/);
    await assert.rejects(service.call('memory_database_search',{operation:'nearby',cursor:result.data.cursor,event_id:'unknown'}),/Choose event_id/);
    await assert.rejects(service.call('memory_database_search',{operation:'expand',cursor:result.data.cursor,session_id:'another'}),/cursor expired/);
  }finally{await service.close();}
});

test('graph expansion reuses the initial vector and filters, returns a delta, and validates cursor/model changes', async t => {
  let modelCalls=0;const http=createServer(async(req,res)=>{for await(const chunk of req){};modelCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{index:0,embedding:[1,0]}]}));});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>{http.closeAllConnections();return new Promise(resolve=>http.close(resolve));});
  const cfg=MemoryConfig.fromEnvironment({neo4jMode:'external',neo4jPassword:'test',embeddingApiKey:'fixture',embeddingDimensions:2},{});cfg.embeddingUrl=`http://127.0.0.1:${http.address().port}`;
  const store={close:async()=>{},ensureIndexes:async()=>{},searchEvidence:async()=>[event('event_1')],evidenceExisting:async()=>{},
    evidenceLinks:async ids=>({links:ids.map(id=>({eventId:id,conceptId:'concept_1',name:'部署',degree:4,score:1})),limited:false}),
    expandEvidence:async(id,seen,vector,filter,limit)=>{assert.equal(id,'concept_1');assert.deepEqual(seen,['event_1']);assert.deepEqual(vector,[1,0]);assert.equal(filter.entity,'部署');assert.equal(limit,3);return [event('event_2')];}};
  const service=new MemoryService(cfg,undefined,store);t.after(()=>service.close());
  const initial=await service.call('memory_database_search',{query_text:'部署',entity_filter:'部署'});assert.equal(modelCalls,1);
  cfg.embeddingApiKey='';
  const more=await service.call('memory_database_search',{operation:'expand',cursor:initial.data.cursor,concept_id:'concept_1'});
  assert.deepEqual(more.data.events.map(e=>e.id),['event_2']);assert.equal(more.data.scope,'added');assert.equal(more.data.seen,2);assert.equal(modelCalls,1);assert.notEqual(more.data.cursor,initial.data.cursor);
  cfg.embeddingModel='another-model';await assert.rejects(service.call('memory_database_search',{operation:'expand',cursor:more.data.cursor,concept_id:'concept_1'}),/settings changed/);
  const cached=service.evidenceCursors.get(initial.data.cursor);cached.expires=0;
  await assert.rejects(service.call('memory_database_search',{operation:'expand',cursor:initial.data.cursor,concept_id:'concept_1'}),/cursor expired/);
});
