import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildEvidence, dateRange, evidenceExcerpt, renderMemoryEvidence, sessionDiverse, sourcePosition, resolveEventReference, AGENT_EVENT_FIELDS } from '../lib/evidence.js';
import { Neo4jStore } from '../lib/store.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';

const event = id => ({ id, summary: '甲只是计划部署 Neo4j，尚未完成。', content: '😀'.repeat(150) + '甲只是计划部署 Neo4j，尚未完成。', contentLength: 170 });
test('source match retains Unicode offsets and points reads at the matching part of a long event', () => {
  const prefix='😀'.repeat(1400), text='USER: I have been living in Harajuku for 3 months.\nASSISTANT: Thanks for the update.';
  const content=prefix+text+' irrelevant'.repeat(400), start=Array.from(prefix).length;
  const rows=Array.from({length:4},(_,i)=>({id:`event_${i+1}`,summary:'A long conversation about sightseeing.',content,contentLength:Array.from(content).length,matchedSource:{range:[start,start+Array.from(text).length],text}}));
  const data=buildEvidence(rows,[],rows.map(e=>e.id),'How long living in Harajuku?','initial');
  for(const row of data.events){assert(row.quote.text.includes('3 months'));assert.equal(Array.from(content).slice(...row.quote.range).join(''),row.quote.text);assert(row.read.start<=start);assert(row.read.start+row.read.limit>start+text.length);}
  assert(data.events.reduce((n,e)=>n+Array.from(e.quote.text).length,0)<=1000);
  assert(renderMemoryEvidence(data).includes('read event_id=event_1 limit='));
});

test('numeric IDs are scoped to delivered events and read responses expose total and continuation', async () => {
  assert.equal(resolveEventReference('7',['event_7']),'event_7');assert.equal(resolveEventReference('Event:7',['event_7']),'event_7');
  assert.equal(resolveEventReference('event_7',[]),'event_7');assert.throws(()=>resolveEventReference('7',['event_8']),/complete event_id/);
  const cfg=MemoryConfig.fromEnvironment({neo4jMode:'external',neo4jPassword:'test'},{});let reads=0;
  const service=new MemoryService(cfg,undefined,{close:async()=>{},searchEvidence:async()=>[event('event_7')],evidenceLinks:async()=>({links:[],limited:false}),readEvidence:async(id,start,limit)=>{reads++;assert.equal(id,'event_7');return{kind:'source',id,range:[start,start+limit],text:'exact source',total:500,next:start+limit};}});
  try{
    await service.call('memory_database_search',{entity_filter:'test',session_id:'owner'});
    const read=await service.call('memory_database_search',{operation:'read',event_id:'7',session_id:'owner',limit:20});
    assert.equal(reads,1);assert(renderMemoryEvidence(read.data).includes('原文共500字符'));assert(renderMemoryEvidence(read.data).includes('start=20 limit=1600'));
    await assert.rejects(service.call('memory_database_search',{operation:'read',event_id:'7',session_id:'other'}),/complete event_id/);assert.equal(reads,1);
  }finally{await service.close();}
});
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

test('agent-facing rows are whitelisted and provenance stays compact', () => {
  const base = { ...event('event_ch0053_e09'), chapter: 53, chapterTitle: '魔网', session: 'dawn-ch0053', embedding: [0.1, 0.2], embedding_model: 'model-x', embedding_dim: 768, raw_session: 'dawn-ch0053', source_scenes: ['ch0053_s013'], sourceHashes: ['abc'] };
  const related = { ...base, id: 'event_ch0053_e03', summary: '高文提出拆分法阵' };
  const data = buildEvidence([base], [], [base.id], '', 'initial', [], [related]);
  const text = renderMemoryEvidence(data);
  assert(text.includes('event_ch0053_e09 [第53章 魔网] session="dawn-ch0053" |'));
  assert(text.includes('event_ch0053_e03 [第53章] session="dawn-ch0053" |'));
  assert.equal(data.events[0].session,'dawn-ch0053');assert.equal(data.related[0].session,'dawn-ch0053');
  assert(text.includes('read event_id=event_ch0053_e09 limit='));
  assert(!text.includes('事件内定位'));
  assert(!text.includes('核对原文'));
  for (const banned of ['embedding', 'raw_session', 'source_scenes', 'sourceHashes', 'model-x']) {
    assert(!JSON.stringify(data).includes(banned), banned);
    assert(!text.includes(banned), banned);
  }
  for (const row of data.events) for (const key of Object.keys(row)) assert(AGENT_EVENT_FIELDS.includes(key), key);
  for (const row of data.related) for (const key of Object.keys(row)) assert(['id', 'summary', 'chapter', 'session'].includes(key), key);
  const missing=buildEvidence([event('event_1')],[],['event_1'],'','initial',[],[{...event('event_2'),session:'   '}]);
  assert(!('session' in missing.events[0]));assert(!('session' in missing.related[0]));assert(!renderMemoryEvidence(missing).includes('session='));
  const special='conversation "quoted"\nnext';
  const escaped=buildEvidence([{...event('event_1'),session:special}],[],['event_1'],'','added');
  assert.equal(escaped.events[0].session,special);assert(renderMemoryEvidence(escaped).includes(`session=${JSON.stringify(special)}`));
});
test('chapter is an exact Event scope and is rejected for other labels', async () => {
  const cfg=MemoryConfig.fromEnvironment({neo4jMode:'external',neo4jPassword:'test'},{});let filter;
  const store={close:async()=>{},searchEvidence:async(v,f)=>{filter=f;return [];},evidenceLinks:async()=>({links:[],limited:false})};
  const service=new MemoryService(cfg,undefined,store);
  try{
    await service.call('memory_database_search',{chapter:81});
    assert.deepEqual(filter,{entity:undefined,date:undefined,chapter:81});
    await assert.rejects(service.call('memory_database_search',{chapter:81,target_label:'Person'}),/only supported for Event/);
    await assert.rejects(service.call('memory_database_search',{chapter:0}),/Invalid chapter/);
  }finally{await service.close();}
});
test('source session scopes are independent of caller sessions and persist through continuation', async () => {
  const cfg=MemoryConfig.fromEnvironment({neo4jMode:'external',neo4jPassword:'test'},{}), filters=[];
  const store={close:async()=>{},searchEvidence:async(v,f)=>{assert.equal(v,undefined);filters.push(f);return [event('event_1')];},
    evidenceExisting:async()=>{},evidenceLinks:async ids=>({links:ids.map(id=>({eventId:id,conceptId:'concept_1',name:'部署',degree:4,score:1})),limited:false}),
    expandEvidence:async(id,seen,v,f)=>{filters.push(f);return [event('event_2')];},
    nearbyEvidence:async(id,seen,f)=>{filters.push(f);return [event('event_3')];}};
  const service=new MemoryService(cfg,undefined,store);
  try{
    const initial=await service.call('memory_database_search',{source_session:' source-123 ',session_id:'caller'});
    assert.equal(initial.data.events.length,1);
    assert.deepEqual(filters[0],{entity:undefined,date:undefined,sourceSession:'source-123'});
    await assert.rejects(service.call('memory_database_search',{operation:'expand',cursor:initial.data.cursor,concept_id:'concept_1',session_id:'source-123'}),/cursor expired/);
    const expanded=await service.call('memory_database_search',{operation:'expand',cursor:initial.data.cursor,concept_id:'concept_1',session_id:'caller'});
    await service.call('memory_database_search',{operation:'nearby',cursor:expanded.data.cursor,event_id:'event_2',session_id:'caller'});
    assert.deepEqual(filters[1],filters[0]);assert.deepEqual(filters[2],filters[0]);
    await service.call('memory_database_search',{source_session:'source-123',chapter:81,time_hint:'2026-11',entity_filter:'部署',session_id:'combined'});
    assert.deepEqual(filters[3],{entity:'部署',date:'2026-11',chapter:81,sourceSession:'source-123'});
    for(const source_session of ['', ' ', 123, null, 'x'.repeat(201)])
      await assert.rejects(service.call('memory_database_search',{source_session}),/source_session/);
    for(const target_label of ['Person','Concept'])
      await assert.rejects(service.call('memory_database_search',{source_session:'source-123',target_label}),/only supported for Event/);
    for(const operation of ['read','expand','nearby'])
      await assert.rejects(service.call('memory_database_search',{operation,source_session:'source-123'}),/original search conditions/);
  }finally{await service.close();}
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

test('time_hint accepts years, months, days and inclusive ranges and ignores a trailing time', () => {
  assert.deepEqual(dateRange('2026-10-27'),{start:'2026-10-27',end:'2026-10-28'});
  assert.deepEqual(dateRange('2026-10'),{start:'2026-10-01',end:'2026-11-01'});
  assert.deepEqual(dateRange('2026-12'),{start:'2026-12-01',end:'2027-01-01'});
  assert.deepEqual(dateRange('2026'),{start:'2026-01-01',end:'2027-01-01'});
  assert.deepEqual(dateRange('2023-05-20..2023-05-27'),{start:'2023-05-20',end:'2023-05-28'});
  assert.deepEqual(dateRange('2023-05-20..2023-05-20'),{start:'2023-05-20',end:'2023-05-21'});
  assert.deepEqual(dateRange('2023-05-25T13:47:00'),{start:'2023-05-25',end:'2023-05-26'});
  for (const bad of ['', 'yesterday', '2023-13-01', '2023-02-30', '2023-05-20..2023-05-01', '2023..2024..2025']) assert.equal(dateRange(bad), undefined, bad);
});

test('per-session diversity cap only limits the primary slots and keeps relevance order', () => {
  const rows=[];
  for (const session of ['a','b','c','d','e']) for (let i=1;i<=3;i++) rows.push({ ...event(`${session}${i}`), session });
  assert.deepEqual(sessionDiverse(rows,8,2).map(e=>e.id),['a1','a2','b1','b2','c1','c2','d1','d2']);
  assert.deepEqual(sessionDiverse(rows,8,0).map(e=>e.id),['a1','a2','a3','b1','b2','b3','c1','c2']);
  assert.deepEqual(sessionDiverse(rows.filter(e=>e.session==='a'),8,2).map(e=>e.id),['a1','a2','a3']);
  assert.deepEqual(sessionDiverse([],8,2),[]);
});

test('nearby falls back to session order when an event has no chapter/record id', async () => {
  const cfg=MemoryConfig.fromEnvironment({neo4jMode:'external',neo4jPassword:'test'},{});
  const store=new Neo4jStore(cfg), calls=[];
  store.run=async (query,params)=>{calls.push({query,params});
    if(query.includes('evidence:anchor'))return [{session:'sharegpt_1',time:'2023-05-20T02:21:03+00:00'}];
    return [{id:query.includes('create_time < $time')?'event_2':'event_4'}];};
  try{
    assert.deepEqual((await store.nearbyEvidence('event_3',[],{},2,2,8)).map(e=>e.id),['event_2','event_4']);
    assert.equal(calls.length,3);
    assert(calls[1].params.session==='sharegpt_1');assert(calls[1].params.time==='2023-05-20T02:21:03+00:00');
    assert(calls[1].query.includes('e.create_time < $time')&&calls[1].query.includes('ORDER BY e.create_time DESC'));
    assert(calls[2].query.includes('e.create_time > $time')&&calls[2].query.includes('ORDER BY e.create_time ASC'));
    store.run=async query=>query.includes('evidence:anchor')?[{session:null,time:null}]:[];
    await assert.rejects(store.nearbyEvidence('event_3',[],{},2,2,8),/no reliable chapter\/record or session position/);
  }finally{await store.close();}
});
