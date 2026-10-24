import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import neo4j from 'neo4j-driver';
import { LocalNeo4j, portOpen } from '../lib/runtime.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';

test('real Neo4j: legacy data, model HTTP, aligned writes, filtered/vector search, rollback, restart and host crash', { skip: process.env.DSH_NEO4J_MEMORY_INTEGRATION !== '1', timeout: 300_000 }, async t => {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp', 'integration-'));
  console.log(`Integration database: ${root}`);
  const runtime = new LocalNeo4j(root);
  let service;
  t.after(async () => { await service?.close(); await runtime.stop(); });
  const info = await runtime.ensure();
  console.log('Managed runtime ready');
  const attached = new LocalNeo4j(root);
  assert.equal((await attached.ensure()).port, info.port);
  assert.equal(attached.startedHere, false);
  await attached.stop(); assert.equal(await portOpen(info.port), true, 'attached instance must not stop the owning instance');
  const cfg = MemoryConfig.fromEnvironment({ neo4jMode: 'external', neo4jPassword: info.password, apiKey: 'fixture', embeddingApiKey: 'fixture', alignmentApiKey: 'fixture', conceptAlignment: true }, { DSH_NEO4J_MEMORY_NEO4J_URI: info.uri, DSH_NEO4J_MEMORY_EMBEDDING_DIMENSIONS: '2' });
  let mention = 'TS', event = '学习 TypeScript', malformed = false;
  const http = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/embeddings') res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0.1] })) }));
    else if (req.url === '/chat/completions') res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      event: { type: 'study', summary: event }, entities: { persons: ['兼容用户'], concepts: [mention], locations: [] },
      relationships: [{ source: '兼容用户', target: 'CURRENT_EVENT', type: 'PARTICIPATED_IN' }, { source: 'CURRENT_EVENT', target: mention, type: 'MENTIONS' }],
    }) } }] }));
    else if (req.url === '/systemone') res.end(JSON.stringify({ model: 'jev-fixture', answers: malformed ? {} : Object.fromEntries(body.state.candidates.map((_, i) => [`pair_${i}`, { type: 'score', score: 1.98, probabilities: { '0': 0.01, '1': 0, '2': 0.99 }, confidence: 1 }])) }));
    else res.writeHead(404).end();
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  cfg.extractionUrl = cfg.embeddingUrl = `http://127.0.0.1:${http.address().port}`;
  cfg.alignmentUrl = `http://127.0.0.1:${http.address().port}/systemone`;
  service = new MemoryService(cfg);
  // Seed records with the exact schema/IDs used by the former Python implementation.
  await service.store.run("CREATE (:Concept {id:'concept_legacy',name:'TypeScript',embedding:[1.0,0.1],first_context:'programming language'}), (:Person {id:'person_legacy',name:'兼容用户',embedding:[1.0,0.1]})");
  const saved = await service.call('memory_database_save', { content: '兼容用户学习 TS 编程语言', session_id: 'integration' });
  assert.equal(saved.status, 'ok'); assert.equal(saved.concept_alignment[0].target_id, 'concept_legacy'); assert.equal(saved.concept_alignment[0].action, 'reuse');
  const entities = await service.store.run('MATCH (n:Concept) RETURN n.id AS id,n.aliases AS aliases');
  assert.equal(entities.length, 1); assert.deepEqual(entities[0].aliases, ['TS']);
  const savedId = saved.event_id;
  await service.store.run("MATCH (e:Event {id:$id}) SET e.create_time='2026-10-24T10:30:00.123456'", { id: savedId });
  const vector = await service.call('memory_database_search', { query_text: '编程学习' });
  assert.equal(vector.data.primary_match.node.id, savedId); assert.ok(vector.data.primary_match.context.persons.some(p => p.name === '兼容用户'));
  const filtered = await service.call('memory_database_search', { entity_filter: 'TS', time_hint: '2026-10-24' });
  assert.equal(filtered.data.primary_match.node.id, savedId);
  const empty = await service.call('memory_database_search', { entity_filter: 'missing' }); assert.equal(empty.data.primary_match, null);
  const graph = await service.call('memory_database_graph', { labels: ['Event', 'Concept'] });
  assert.ok(graph.nodes.some(n => n.id === 'Concept:concept_legacy')); assert.equal(graph.relationships.length, 1);
  // Ambiguous entity identity must roll back the whole transaction, including newly created concepts.
  await service.store.run("CREATE (:Person {id:'duplicate_person',name:'兼容用户'})");
  await assert.rejects(service.call('memory_database_save', { content: '失败事务' }), /ambiguous/);
  const count = await service.store.run('MATCH (e:Event) RETURN count(e) AS total'); assert.equal(count[0].total, 1);
  await service.store.run("MATCH (p:Person {id:'duplicate_person'}) DELETE p");
  // Incomplete alignment answers create a distinct node instead of forcing a name merge.
  malformed = true; mention = 'New uncertain'; event = '新概念';
  const pending = await service.call('memory_database_save', { content: '新概念' });
  assert.equal(pending.concept_alignment[0].action, 'create'); assert.equal(pending.concept_alignment[0].reason, 'jev_error');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.call('memory_database_save', { content: '已取消' }, controller.signal));
  await service.close(); service = undefined;
  await runtime.stop(); assert.equal(await portOpen(info.port), false);
  console.log('Write/search/graph/rollback passed; restart next');
  const restarted = new LocalNeo4j(root);
  t.after(() => restarted.stop());
  const again = await restarted.ensure();
  const driver = neo4j.driver(again.uri, neo4j.auth.basic('neo4j', again.password));
  const session = driver.session({ database: 'neo4j' });
  try { const result = await session.run('MATCH (e:Event {id:$id}) RETURN e.id AS id', { id: savedId }); assert.equal(result.records[0].get('id'), savedId); }
  finally { await session.close(); await driver.close(); }
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).password, info.password);
  await restarted.stop();
  const persistent = new LocalNeo4j(root);
  await persistent.startPersistent();
  assert.equal((await persistent.status()).running, true);
  await new LocalNeo4j(root).stopPersistent();
  assert.equal(await portOpen(again.port), false);
  const host = spawn(process.execPath, ['tests/fixtures/runtime-host.mjs', root], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (host.exitCode === null) host.kill(); });
  const port = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Watchdog fixture startup timed out')), 90_000);
    host.once('error', e => { clearTimeout(timer); reject(e); });
    host.once('exit', code => { clearTimeout(timer); reject(new Error(`Watchdog fixture exited: ${code}`)); });
    host.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).port); } });
  });
  assert.equal(await portOpen(port), true); host.kill('SIGKILL');
  for (let i = 0; i < 100 && await portOpen(port); i++) await delay(200);
  assert.equal(await portOpen(port), false, 'watchdog stops Java when host is killed');
  console.log('Restart, state compatibility and crash cleanup passed');
});
