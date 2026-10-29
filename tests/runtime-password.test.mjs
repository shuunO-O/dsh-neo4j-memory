import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalNeo4j } from '../lib/runtime.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryService } from '../lib/service.js';

test('real Neo4j accepts a stored password beginning with a dash and serves an empty search', {
  skip: process.env.DSH_NEO4J_MEMORY_PASSWORD_INTEGRATION !== '1', timeout: 120000,
}, async t => {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp', 'runtime-password-'));
  const password = '-regression-fixture-never-a-real-password';
  await writeFile(join(root, 'state.json'), JSON.stringify({ password }));
  const runtime = new LocalNeo4j(root);
  let service;
  t.after(async () => { await service?.close(); await runtime.stop(); });
  const info = await runtime.ensure();
  assert.equal(info.password, password);
  assert.equal(await runtime.probe(), 'ready');
  const config = MemoryConfig.fromEnvironment({ neo4jMode: 'external', neo4jPassword: password }, {
    DSH_NEO4J_MEMORY_NEO4J_URI: info.uri,
  });
  service = new MemoryService(config);
  const result = await service.call('memory_database_search', { entity_filter: 'nonexistent-regression-entity' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data.events, []);
});
