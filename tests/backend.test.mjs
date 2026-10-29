import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryConfig, parseBoolean } from '../lib/config.js';
import { ModelClient, validateExtraction } from '../lib/api.js';
import { alignConcepts, validateAnswer } from '../lib/alignment.js';
import { MemoryService, MemoryBackend } from '../lib/service.js';
import { Neo4jStore } from '../lib/store.js';
import { guardArchivePath, extractZip } from '../lib/runtime.js';

const extraction = () => ({ event: { type: 'study', summary: '学习 TypeScript' }, entities: { persons: ['测试用户'], locations: [], concepts: ['TypeScript'] }, relationships: [
  { source: '测试用户', target: 'CURRENT_EVENT', type: 'PARTICIPATED_IN' }, { source: 'CURRENT_EVENT', target: 'TypeScript', type: 'MENTIONS' },
] });
const config = () => MemoryConfig.fromEnvironment({ neo4jMode: 'external', neo4jPassword: 'test', apiKey: 'test', embeddingApiKey: 'test', conceptAlignment: false }, {});
async function server(t, handle) {
  const http = createServer(async (req, res) => {
    try { let body = ''; for await (const chunk of req) body += chunk; await handle(req, res, body ? JSON.parse(body) : undefined); }
    catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  return `http://127.0.0.1:${http.address().port}`;
}

test('configuration keeps secrets env-first and every other field Config-first', () => {
  const cfg = MemoryConfig.fromEnvironment({}, { EMBEDDING_API_KEY: ' new-key ', QWEN_EMBEDDING_API_KEY: 'old-key' });
  assert.equal(cfg.embeddingApiKey, 'new-key'); assert.equal(cfg.neo4jManaged, true);
  // A non-empty environment variable wins for secrets, so the key can stay off disk.
  assert.equal(MemoryConfig.fromEnvironment({ embeddingApiKey: 'UI' }, { EMBEDDING_API_KEY: 'env' }).embeddingApiKey, 'env');
  assert.equal(MemoryConfig.fromEnvironment({ embeddingApiKey: 'UI' }, { EMBEDDING_API_KEY: '   ' }).embeddingApiKey, 'UI');
  assert.equal(MemoryConfig.fromEnvironment({ embeddingApiKey: 'UI' }, {}).embeddingApiKey, 'UI');
  assert.equal(MemoryConfig.fromEnvironment({ neo4jMode: 'external', neo4jPassword: 'ui' }, { NEO4J_PASSWORD: 'env' }).neo4jPassword, 'env');
  // Non-secret settings are still Config-first.
  assert.equal(MemoryConfig.fromEnvironment({ embeddingModel: 'ui-model' }, { DSH_NEO4J_MEMORY_EMBEDDING_MODEL: 'env-model' }).embeddingModel, 'ui-model');
  assert.equal(MemoryConfig.fromEnvironment({}, { QWEN_EMBEDDING_API_KEY: 'old' }).embeddingApiKey, '');
  assert.throws(() => MemoryConfig.fromEnvironment({}, {}).requireModelKeys(), /EMBEDDING_API_KEY/);
  assert.throws(() => MemoryConfig.fromEnvironment({ neo4jMode: 'external' }, {}), /NEO4J_PASSWORD/);
  assert.throws(() => MemoryConfig.fromEnvironment({}, { DSH_NEO4J_MEMORY_EMBEDDING_DIMENSIONS: '1.5' }));
  assert.throws(() => MemoryConfig.fromEnvironment({}, { DSH_NEO4J_MEMORY_EXTRACTION_URL: 'https://user:secret@example.com' }));
  assert.equal(parseBoolean('"false"', true), false); assert.equal(parseBoolean(1, false), true);
});
test('embedding dimensions come from the host config and are validated', () => {
  assert.equal(MemoryConfig.fromEnvironment({ embeddingDimensions: 768 }, {}).dimensions, 768);
  assert.equal(MemoryConfig.fromEnvironment({}, { DSH_NEO4J_MEMORY_EMBEDDING_DIMENSIONS: '512' }).dimensions, 512);
  assert.equal(MemoryConfig.fromEnvironment({ embeddingDimensions: 768 }, { DSH_NEO4J_MEMORY_EMBEDDING_DIMENSIONS: '512' }).dimensions, 768);
  assert.throws(() => MemoryConfig.fromEnvironment({ embeddingDimensions: 1.5 }, {}), /embeddingDimensions/);
  assert.throws(() => MemoryConfig.fromEnvironment({ embeddingDimensions: 5000 }, {}), /embeddingDimensions/);
});
test('extractor preserves schema, sentiment and endpoint validation', () => {
  validateExtraction(extraction());
  const bad = extraction(); bad.relationships[0].target = 'unknown'; assert.throws(() => validateExtraction(bad));
  bad.relationships = [{ source: 'TypeScript', target: 'CURRENT_EVENT', type: 'HAS_ATTITUDE', properties: {} }]; assert.throws(() => validateExtraction(bad));
  bad.relationships[0].properties = { sentiment: '喜欢' }; validateExtraction(bad);
  bad.relationships[0].properties.extra = 'bad'; assert.throws(() => validateExtraction(bad));
});
test('HTTP extraction and embeddings deduplicate, batch, reorder and validate vectors', async t => {
  let calls = 0;
  const url = await server(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/chat/completions') { assert.ok(body.messages[0].content.length > 100); res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(extraction()) + '\n```' } }] })); return; }
    calls++; res.end(JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: [i + 1, 1] })).reverse() }));
  });
  const cfg = config(); cfg.extractionUrl = cfg.embeddingUrl = url; cfg.dimensions = 2;
  const client = new ModelClient(cfg);
  assert.deepEqual(await client.extract('学习'), extraction());
  const vectors = await client.embed(['a', ' b ', 'a', ...Array.from({ length: 21 }, (_, i) => `item${i}`)]);
  assert.equal(calls, 2); assert.deepEqual(vectors[0], vectors[2]); assert.deepEqual(vectors[1], [2, 1]);
});
test('HTTP errors and cancellation do not leak vendor bodies or secrets', async t => {
  const url = await server(t, (_req, res) => res.writeHead(401).end('private user content secret'));
  const client = new ModelClient(config());
  await assert.rejects(client.post(url, '/x', 'private-key', {}), e => e.message === 'Model API returned HTTP 401');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(new ModelClient(config(), aborted.signal).post(url, '/x', 'secret', {}));
});
const answer = p => ({ type: 'score', probabilities: { '0': p[0], '1': p[1], '2': p[2] }, confidence: 1, score: p[1] + 2 * p[2] });
test('alignment reuses only one confident identity and falls back on incomplete responses', async t => {
  assert.throws(() => validateAnswer({ ...answer([0, 0, 1]), score: 0 }));
  let incomplete = false;
  const url = await server(t, (_req, res, body) => {
    assert.equal(body.questions.pair_0.type, 'score');
    assert.match(body.questions.pair_0.instructions, /incoming\.name/);
    assert.match(body.questions.pair_0.instructions, /candidates\[0\]\.name/);
    res.end(JSON.stringify({ model: 'jev-test', answers: incomplete ? {} : { pair_0: answer([0.01, 0.02, 0.97]) } }));
  });
  const cfg = config(); cfg.alignmentUrl = url; cfg.alignmentApiKey = 'test';
  const records = [{ id: 'concept_new', name: 'TS', label: 'Concept', embedding: [1, 0] }];
  const recall = async () => [{ id: 'concept_old', name: 'TypeScript', aliases: [], events: [], first_context: 'language' }];
  const [aligned] = await alignConcepts(new ModelClient(cfg), records, 'TypeScript language', '学习', recall);
  assert.equal(aligned.action, 'reuse'); assert.equal(aligned.target_id, 'concept_old');
  incomplete = true;
  const [pending] = await alignConcepts(new ModelClient(cfg), records, 'TS', '学习', recall);
  assert.equal(pending.action, 'create'); assert.equal(pending.reason, 'jev_error');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(alignConcepts(new ModelClient(cfg, controller.signal), records, '', '', recall));
});
test('alignment checks local candidates, rejects ambiguity and preserves cancellation', async t => {
  const cfg = config();
  cfg.alignmentUrl = await server(t, (_req, res) => res.end(JSON.stringify({ model: 'test', answers: { pair_0: answer([0, 0, 1]), pair_1: answer([0, 0, 1]) } })));
  const client = new ModelClient(cfg);
  const records = [{ id: 'a', name: 'A', label: 'Concept', embedding: [1] }, { id: 'b', name: 'B', label: 'Concept', embedding: [1] }];
  const result = await alignConcepts(client, records, '', 'summary', async () => []);
  assert.equal(result[0].reason, 'no_candidates'); assert.equal(result[1].target_id, 'a');
  const ambiguous = await alignConcepts(client, [records[0]], '', '', async () => [{ id: 'c', name: 'C' }, { id: 'd', name: 'D' }]);
  assert.equal(ambiguous[0].action, 'create'); assert.equal(ambiguous[0].reason, 'conflicting_candidates');
});
test('alignment threshold is configurable and records the decision bounds', async t => {
  const cfg = config();
  cfg.alignmentThreshold = 0.98;
  cfg.alignmentUrl = await server(t, (_req, res) => res.end(JSON.stringify({ model: 'jev-test', answers: { pair_0: answer([0.01, 0.02, 0.97]) } })));
  const records = [{ id: 'concept_new', name: 'TS', label: 'Concept', embedding: [1, 0] }];
  const recall = async () => [{ id: 'concept_old', name: 'TypeScript', aliases: [], events: [], first_context: 'language' }];
  const [strict] = await alignConcepts(new ModelClient(cfg), records, 'TypeScript language', '学习', recall);
  assert.equal(strict.action, 'create');
  assert.equal(strict.reason, 'uncertain');
  assert.equal(strict.same_probability, 0.98);
  assert.equal(strict.different_probability, 0.93);
  cfg.alignmentThreshold = 0.96;
  const [loose] = await alignConcepts(new ModelClient(cfg), records, 'TypeScript language', '学习', recall);
  assert.equal(loose.action, 'reuse');
  assert.equal(loose.target_id, 'concept_old');
});
test('live config refresh updates a running service without restarting it', () => {
  const cfg = config();
  const service = new MemoryService(cfg, undefined, { graph: async () => ({ nodes: [], relationships: [] }), close: async () => {} });
  service.applyLiveConfig({
    neo4jMode: 'external', neo4jPassword: 'test',
    apiKey: 'new-extraction-key', embeddingApiKey: 'new-embedding-key', alignmentApiKey: 'new-alignment-key',
    conceptAlignment: true,
    extractionBaseUrl: 'https://example.test/v1', extractionModel: 'extract-new',
    embeddingBaseUrl: 'https://example.test/v1', embeddingModel: 'embed-new',
    embeddingDimensions: 1536,
    alignmentBaseUrl: 'https://example.test/decisions', alignmentModel: 'jev-new',
    alignmentThreshold: 0.9,
  });
  assert.equal(service.config.apiKey, 'new-extraction-key');
  assert.equal(service.config.embeddingApiKey, 'new-embedding-key');
  assert.equal(service.config.alignmentApiKey, 'new-alignment-key');
  assert.equal(service.config.extractionModel, 'extract-new');
  assert.equal(service.config.embeddingModel, 'embed-new');
  assert.equal(service.config.dimensions, 1536);
  assert.equal(service.config.alignmentModel, 'jev-new');
  assert.equal(service.config.alignmentUrl, 'https://example.test/decisions');
  assert.equal(service.config.alignmentThreshold, 0.9);
  assert.equal(service.config.conceptAlignment, true);
});
test('service validates graph/search and graph works without model credentials', async () => {
  const cfg = config(); cfg.apiKey = cfg.embeddingApiKey = '';
  const store = { graph: async selected => ({ nodes: selected, relationships: [] }), close: async () => {} };
  const service = new MemoryService(cfg, undefined, store);
  assert.deepEqual(await service.call('memory_database_graph', { labels: ['Concept'] }), { nodes: ['Concept'], relationships: [] });
  await assert.rejects(service.call('memory_database_graph', { labels: ['Evil'] }));
  await assert.rejects(service.call('memory_database_search', { time_hint: '2026-02-30' }));
  await assert.rejects(service.call('memory_database_search', { query_text: 'test', target_label: 'Evil' }));
});
test('transaction reuses actual entity ID and rolls back missing relationship endpoint', async () => {
  let committed = 0, rolledBack = 0, written = 1, sequence = 0; const queries = [];
  const record = object => ({ get: key => object[key], toObject: () => object });
  const tx = { run: async (q, p) => {
    queries.push([q, p]);
    if (q.startsWith('MERGE (n:Person')) return { records: [record({ id: 'person_existing' })] };
    if (q.includes('RETURN count(r)')) return { records: [record({ written })] };
    if (q.includes('RETURN n.id AS id')) return { records: [record({ id: 'concept_existing' })] };
    return { records: [] };
  }, commit: async () => { committed++; }, rollback: async () => { rolledBack++; } };
  const driver = { session: () => ({
    beginTransaction: () => tx,
    run: async (q) => q.includes('MemorySequence') ? { records: [record({ value: ++sequence })] } : { records: [] },
    close: async () => {},
  }), close: async () => {} };
  const store = new Neo4jStore(config(), driver); store.ensureIndexes = async () => {};
  const client = new ModelClient(config()); client.embed = async texts => texts.map(() => [1, 0]);
  const result = await store.save('学习', 'test', extraction(), client);
  assert.match(result.event_id, /^event_\d+$/); assert.equal(committed, 1);
  assert.ok(queries.some(([q, p]) => q.includes('RETURN count(r)') && p.source_value === 'person_existing'));
  written = 0;
  await assert.rejects(store.save('学习', 'test', extraction(), client), /endpoint/);
  assert.equal(committed, 1); assert.equal(rolledBack, 1);
});
test('embedding mismatch blocks writes until re-vectorization rebuilds the index', async () => {
  const cfg = config(); cfg.dimensions = 3; cfg.embeddingModel = 'new-model';
  const store = new Neo4jStore(cfg, { close: async () => {} });
  const queries = []; let meta = { model: 'old-model', dimensions: 2 };
  store.readEmbeddingMeta = async () => meta;
  store.run = async (q, p) => {
    queries.push([q, p]);
    if (typeof q === 'string' && q.includes('MERGE (m:MemoryMeta')) { meta = { model: p.model, dimensions: p.dimensions?.toNumber?.() ?? Number(p.dimensions) }; return []; }
    if (typeof q === 'string' && q.includes('MATCH (n) WHERE any(l IN labels(n) WHERE l IN $labels)') && q.includes('RETURN n.id AS id')) return [
      { id: 'event_1', labels: ['Event'], summary: '学习 TypeScript', name: null },
      { id: 'concept_1', labels: ['Concept'], summary: null, name: 'TypeScript' },
    ];
    return [];
  };
  store.createVectorIndexes = async (dimensions) => { queries.push(['create-indexes', dimensions]); };
  await assert.rejects(store.ensureIndexes(), /Re-vectorize/);
  const client = new ModelClient(cfg); client.embed = async texts => texts.map(() => [1, 2, 3]);
  const result = await store.reembed(client);
  assert.equal(result.nodes, 2); assert.equal(result.dimensions, 3); assert.equal(result.model, 'new-model');
  assert.ok(queries.some(([q]) => typeof q === 'string' && q.includes('embedding_next=row.vector')));
  assert.ok(queries.some(([q]) => typeof q === 'string' && q.startsWith('DROP INDEX')));
  assert.ok(queries.some(([q]) => typeof q === 'string' && q.includes('MERGE (m:MemoryMeta')));
  assert.deepEqual(queries.find(([q]) => q === 'create-indexes'), ['create-indexes', 3]);
});
test('pre-cancelled backend never initializes and disposal rejects future calls', async () => {
  const backend = new MemoryBackend(); const c = new AbortController(); c.abort();
  await assert.rejects(backend.call('memory_database_graph', {}, c.signal));
  assert.equal(backend.starting, undefined); await backend.close();
  await assert.rejects(backend.call('memory_database_graph', {}), /disposed|cancelled/);
});
test('ZIP paths cannot escape staging, and valid ZIP is extracted without PowerShell or Python', async () => {
  const root = join(process.cwd(), 'tmp', 'zip-guard');
  for (const name of ['../evil', '/absolute', 'C:/evil', 'a/../../evil', 'a/../evil', 'a:stream', '\\server\\share']) assert.throws(() => guardArchivePath(root, name));
  assert.equal(guardArchivePath(root, 'folder/file.txt'), join(root, 'folder', 'file.txt'));
  const dir = await mkdtemp(join(await import('node:fs/promises').then(fs => fs.mkdir(join(process.cwd(), 'tmp'), { recursive: true }).then(() => join(process.cwd(), 'tmp'))), 'zip-'));
  // A tiny, valid stored ZIP fixture (no external compressor dependency).
  const name = Buffer.from('bundle/file.txt'), data = Buffer.from('ok');
  const crc32 = buffer => { let crc = 0xffffffff; for (const b of buffer) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  const archive = join(dir, 'fixture.zip'); await writeFile(archive, Buffer.concat([local, name, data, central, name, end]));
  await extractZip(archive, join(dir, 'runtime')); assert.equal(await readFile(join(dir, 'runtime', 'file.txt'), 'utf8'), 'ok');
  await assert.rejects(extractZip(archive, join(dir, 'runtime')), /Incomplete runtime/);
});
