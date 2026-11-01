import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptNameKey, conceptGroups } from '../lib/concepts.js';
import { alignConcepts } from '../lib/alignment.js';
import { ModelClient } from '../lib/api.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';
import { Neo4jStore } from '../lib/store.js';

const member = (id, name, group_id = id) => ({ id, name, group_id, aliases: [], first_context: `${name} context`, events: [`${id} evidence`] });
const answer = { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 }, confidence: 1 };

test('spelling normalization preserves meaningful casing, punctuation and compatibility symbols', () => {
  assert.equal(conceptNameKey('　Ｎｅｏ４ｊ '), 'neo4j');
  assert.equal(conceptNameKey('TypeScript'), conceptNameKey('typescript'));
  assert.notEqual(conceptNameKey('US'), conceptNameKey('us'));
  assert.notEqual(conceptNameKey('C++'), conceptNameKey('C'));
  assert.notEqual(conceptNameKey('①'), conceptNameKey('1'));
});

test('group recall deduplicates hits while retaining member-specific context', () => {
  const groups = conceptGroups([member('a', '知识图谱', 'g'), member('b', 'Knowledge Graph', 'g'), member('c', '其他')]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].members.map(m => m.name), ['知识图谱', 'Knowledge Graph']);
  assert.equal(groups[0].members[1].first_context, 'Knowledge Graph context');
});

test('many spellings in one group do not consume all alignment recall slots', async () => {
  const store = new Neo4jStore(MemoryConfig.fromEnvironment({}, {}), { close: async () => {} });
  const all = [...Array.from({ length: 6 }, (_, i) => member(`a${i}`, `alias${i}`, 'g')), member('b', 'B'), member('c', 'C'), member('d', 'D')];
  const widths = [];
  store.run = async (query, params) => {
    if (query.includes('queryNodes')) { widths.push(Number(params.top_k)); return all.slice(0, Number(params.top_k)); }
    if (query.startsWith('UNWIND')) {
      const groups = new Set(all.filter(m => params.ids.includes(m.id)).map(m => m.group_id));
      return all.filter(m => groups.has(m.group_id));
    }
    return [];
  };
  const groups = await store.recallConcepts('incoming', [1, 0], 3);
  assert.equal(groups.length, 3); assert.equal(groups[0].members.length, 6);
  assert.deepEqual(widths, [3, 6, 12]);
});

test('alignment compares a whole group once and retains new names for reversible membership', async () => {
  const cfg = MemoryConfig.fromEnvironment({}, {});
  const incoming = [{ id: 'c', name: 'KG', label: 'Concept', embedding: [1, 0] }];
  const originalPost = ModelClient.prototype.post;
  let calls = 0;
  ModelClient.prototype.post = async function (_base, _path, _key, body) {
    calls++;
    assert.equal(body.state.candidates.length, 1);
    assert.equal(body.state.candidates[0].members.length, 2);
    return { model: 'fixture', answers: { pair_0: answer } };
  };
  try {
    const [decision] = await alignConcepts(new ModelClient(cfg), incoming, 'knowledge graph', '', async () => [member('a', '知识图谱', 'g'), member('b', 'Knowledge Graph', 'g')]);
    assert.equal(decision.action, 'join'); assert.equal(decision.group_id, 'g');
    assert.equal(calls, 1);
    const [spelling] = await alignConcepts(new ModelClient(cfg), [{ ...incoming[0], name: 'Ｎｅｏ４ｊ' }], '', '', async () => [member('neo', 'Neo4j')]);
    assert.equal(spelling.action, 'reuse'); assert.equal(calls, 1, 'safe spelling reuse needs no identity model');
  } finally { ModelClient.prototype.post = originalPost; }
});

test('detaching a concept needs no model keys and invalidates old expansion cursors', async () => {
  const cfg = MemoryConfig.fromEnvironment({}, {});
  const calls = [];
  const service = new MemoryService(cfg, undefined, { detachConcept: async id => { calls.push(id); return { id, group_id: 'isolated' }; } });
  service.evidenceCursors.set('old', {});
  const result = await service.call('memory_database_concept_detach', { concept_id: 'Concept:c' });
  assert.equal(result.data.group_id, 'isolated'); assert.deepEqual(calls, ['c']);
  assert.equal(service.evidenceCursors.size, 0);
  await assert.rejects(service.call('memory_database_concept_detach', {}), /concept_id/);
});
