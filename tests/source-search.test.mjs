import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { uniqueSourceMatches, sourceMatchResult } from '../lib/source-search.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';
import { ModelClient } from '../lib/api.js';
import { renderMemoryEvidence } from '../lib/evidence.js';
const match=(id,start,text,score)=>({id,range:[start,start+Array.from(text).length],text,vectorScore:score,score});

test('source matches deduplicate identical text, merge Unicode overlaps, retain separate facts and filter before top-k',()=>{
  const rows=[match('a',0,'甲😀乙丙',.8),match('b',2,'乙丙丁戊',.9),match('c',50,'独立日期',.7),match('d',100,'无关',.01)];
  assert.equal(uniqueSourceMatches([...rows,match('copy',200,'甲😀乙丙',.6)]).length,4);
  const result=sourceMatchResult('event_1',200,rows,'rerank',4,.1);
  assert.deepEqual(result.passages.map(p=>p.range),[[0,6],[50,54]]);assert.equal(result.passages[0].text,'甲😀乙丙丁戊');assert.equal(result.passages[0].matches.length,2);
  assert.equal(sourceMatchResult('x',200,rows,'rerank',4,.99).passages.length,0);
  assert(renderMemoryEvidence(result).includes('不代表置信概率'));
  assert.throws(()=>sourceMatchResult('x',200,[rows[0],match('bad',2,'错丙丁戊',.9)],'vector',4),/inconsistent/);
});

test('semantic read searches same event repeatedly, reranks full chunks, honors threshold and retains positional read',async t=>{
  let embed=0,rerank=0,lookups=0,invalid=false;
  const rows=[match('price',700,'USER: helmet cost $120.',.9),match('date',9000,'USER: bought helmet April 10.',.8),match('other',11000,'ASSISTANT: generic suggestions.',.7)];
  const http=createServer(async(req,res)=>{
    let text='';for await(const c of req)text+=c;const body=JSON.parse(text);res.setHeader('Content-Type','application/json');
    if(req.url==='/embeddings'){embed++;res.end(JSON.stringify({data:[{index:0,embedding:[1,0]}]}));}
    else {rerank++;assert.deepEqual(body.documents,rows.map(r=>r.text));res.end(JSON.stringify({output:{results:invalid?[{index:0,relevance_score:.5},{index:0,relevance_score:.4},{index:2,relevance_score:.2}]:[{index:1,relevance_score:.99},{index:0,relevance_score:.85},{index:2,relevance_score:.01}]}}));}
  });
  await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(()=>{http.closeAllConnections();return new Promise(r=>http.close(r));});
  const base=`http://127.0.0.1:${http.address().port}`;
  const cfg=MemoryConfig.fromEnvironment({neo4jMode:'external',neo4jPassword:'test',embeddingApiKey:'test',embeddingDimensions:2,embeddingBaseUrl:base,sourceRerankUrl:base+'/reranks'},{});
  assert.equal(cfg.sourceRerankApiKey,'test');
  const service=new MemoryService(cfg,undefined,{close:async()=>{},searchEventSource:async(id,v)=>{lookups++;assert.equal(id,'event_1');assert.deepEqual(v,[1,0]);return{total:12000,rows};},readEvidence:async()=>({kind:'source',id:'event_1',range:[0,2],text:'原文',total:12000})});t.after(()=>service.close());
  for(const query of ['helmet price','helmet date']){
    const result=await service.call('memory_database_search',{operation:'read',event_id:'event_1',query_text:query,top_k:4,min_score:.1});
    assert.equal(result.data.ranking,'rerank');assert.deepEqual(result.data.passages.map(p=>p.range[0]),[700,9000]);
  }
  assert.equal(embed,2);assert.equal(rerank,2);assert.equal(lookups,2);
  assert.equal((await service.call('memory_database_search',{operation:'read',event_id:'event_1'})).data.kind,'source');assert.equal(embed,2);
  for(const bad of [{start:0},{limit:100},{top_k:5},{min_score:NaN}])await assert.rejects(service.call('memory_database_search',{operation:'read',event_id:'event_1',query_text:'test',...bad}));
  assert.equal(embed,2,'invalid arguments must fail before paid calls');
  invalid=true;await assert.rejects(new ModelClient(cfg).rerankSource('test',rows),/score\/index/);
});
