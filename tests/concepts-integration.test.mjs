import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalNeo4j } from '../lib/runtime.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';

test('isolated Neo4j: group alignment, event ownership, grouped expansion and reversible detach', { skip: process.env.DSH_NEO4J_MEMORY_INTEGRATION !== '1', timeout: 180000 }, async t => {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp', 'concept-groups-'));
  const runtime = new LocalNeo4j(root);
  let service;
  t.after(async () => { await service?.close(); await runtime.stop(); });
  const info = await runtime.ensure();
  const cfg = MemoryConfig.fromEnvironment({ neo4jMode: 'external', neo4jPassword: info.password, embeddingDimensions: 2, conceptAlignment: false }, { DSH_NEO4J_MEMORY_NEO4J_URI: info.uri });
  service = new MemoryService(cfg);
  const store = service.store;
  const client = { config: cfg, embed: async texts => texts.map(() => [1, 0]) };
  const extraction = name => ({ event: { type: 'study', summary: `${name} study` }, entities: { concepts: [name], persons: [], locations: [] }, relationships: [{ source: 'CURRENT_EVENT', target: name, type: 'MENTIONS' }] });
  const a = await store.save('first KG event', 'fixture', extraction('知识图谱'), client);
  const original = (await store.run('MATCH (e:Event {id:$id})-[:MENTIONS]->(c:Concept) RETURN c.id AS id', { id: a.event_id }))[0].id;
  // Stub only the model decision: all writes, recall, filters and expansion use real Neo4j.
  store.config.conceptAlignment = true;
  const { ModelClient } = await import('../lib/api.js');
  const originalPost = ModelClient.prototype.post;
  ModelClient.prototype.post = async function (_base, _path, _key, body) {
    assert.equal(body.state.candidates.length, 1);
    return { model: 'fixture', answers: { pair_0: { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 }, confidence: 1 } } };
  };
  t.after(() => { ModelClient.prototype.post = originalPost; });
  const b = await store.save('second KG event', 'fixture', extraction('Knowledge Graph'), client);
  assert.equal(b.decisions[0].action, 'join');
  const owner = (await store.run('MATCH (e:Event {id:$id})-[:MENTIONS]->(c:Concept) RETURN c.id AS id,c.equivalence_group AS group_id', { id: b.event_id }))[0];
  assert.notEqual(owner.id, original); assert.equal(owner.group_id, original);
  const c = await store.save('third KG event', 'fixture', extraction('KG'), client);
  const recalled = await store.recallConcepts('KG', [1, 0], 5);
  assert.equal(recalled.length, 1); assert.equal(recalled[0].members.length, 3);
  const links = await store.evidenceLinks([a.event_id, b.event_id], [1, 0]);
  assert.equal(links.links.length, 2); assert(links.links.every(l => l.degree === 3));
  const ids = [a.event_id, b.event_id, c.event_id].sort();
  assert.deepEqual((await store.searchEvidence(undefined, { entity: 'Knowledge Graph' })).map(e => e.id).sort(), ids);
  const expanded = await store.expandEvidence(owner.id, [a.event_id], undefined, {}, 4);
  assert.deepEqual(expanded.map(e => e.id).sort(), [b.event_id, c.event_id].sort());
  const vectorExpanded = await store.expandEvidence(owner.id, [a.event_id], [1, 0], {}, 4);
  assert.deepEqual(vectorExpanded.map(e => e.id).sort(), [b.event_id, c.event_id].sort());
  // Multiple mentions in the same group must not inflate degree or duplicate candidates.
  await store.run('MATCH (e:Event {id:$event}),(c:Concept {id:$concept}) MERGE (e)-[:MENTIONS]->(c)', { event: a.event_id, concept: owner.id });
  assert((await store.evidenceLinks([a.event_id], undefined)).links.every(l => l.degree === 3));
  await store.run('MATCH (e:Event {id:$event})-[r:MENTIONS]->(c:Concept {id:$concept}) DELETE r', { event: a.event_id, concept: owner.id });
  const before = await store.run('MATCH (e:Event)-[:MENTIONS]->(c:Concept) RETURN e.id AS event,c.id AS concept ORDER BY event,concept');
  // Detach the original representative too: its implicit singleton ID must not rejoin the old group.
  await service.call('memory_database_concept_detach', { concept_id: original });
  assert.deepEqual((await store.searchEvidence(undefined, { entity: '知识图谱' })).map(e => e.id), [a.event_id]);
  assert.deepEqual((await store.searchEvidence(undefined, { entity: 'KG' })).map(e => e.id).sort(), [b.event_id, c.event_id].sort());
  assert.deepEqual(await store.expandEvidence(original, [a.event_id], undefined, {}, 4), []);
  assert.deepEqual(await store.run('MATCH (e:Event)-[:MENTIONS]->(c:Concept) RETURN e.id AS event,c.id AS concept ORDER BY event,concept'), before);
  await assert.rejects(store.detachConcept('missing'), /not found/);
  // Deterministic spelling reuse works with alignment disabled, while punctuation stays significant.
  cfg.conceptAlignment = false;
  const neo = await store.save('neo event', 'fixture', extraction('Neo4j'), client);
  const folded = await store.save('neo full width event', 'fixture', extraction('Ｎｅｏ４ｊ'), client);
  const names = await store.run('MATCH (e:Event)-[:MENTIONS]->(c:Concept) WHERE e.id IN $ids RETURN DISTINCT c.id AS id', { ids: [neo.event_id, folded.event_id] });
  assert.equal(names.length, 1);
  assert.equal((await store.searchEvidence(undefined, { entity: 'neo4j' })).length, 2);
});
