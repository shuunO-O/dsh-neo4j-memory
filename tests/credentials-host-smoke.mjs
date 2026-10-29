// Run with the desktop Electron executable in ELECTRON_RUN_AS_NODE mode.
// argv[2] is that installation's app.asar/dsh/package.json. All data is isolated.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { MemoryCredentials, SECRET_SPECS } from '../lib/credentials.js';

const requireHost = createRequire(resolve(process.argv[2]));
const { Context } = requireHost('@deepseek-ai/cordis');
const { LocalCredentialProvider } = requireHost('@deepseek-ai/dsh-credentials-local');
const root = await mkdtemp(resolve('credentials-host-'));
const path = join(root, '.credentials.yaml');
const legacyFile = join(root, 'legacy-config.json');
const config = { apiKey: 'isolated-extraction', embeddingApiKey: 'isolated-embedding' };
await writeFile(legacyFile, JSON.stringify(config));
const ctx = new Context();
const provider = new LocalCredentialProvider(ctx, { path, dshHome: root, watch: false });
await provider.loadInitial();
const env = { DEEPSEEK_API_KEY: 'isolated-env' };
const manager = new MemoryCredentials(config, () => provider, async values => {
  for (const [field, value] of Object.entries(values)) {
    assert.equal((await provider.resolve(SECRET_SPECS[field].ref))?.value, value);
    config[field] = '';
  }
  await writeFile(legacyFile, JSON.stringify(config));
}, env);
assert.equal((await manager.resolve()).apiKey, 'isolated-env');
assert.ok((await readFile(path, 'utf8')).includes('isolated-extraction'));
assert.ok(!(await readFile(path, 'utf8')).includes('isolated-env'));
assert.ok(!(await readFile(legacyFile, 'utf8')).includes('isolated-extraction'));
await manager.update({ embeddingApiKey: 'isolated-rotated' });
assert.equal((await manager.resolve()).embeddingApiKey, 'isolated-rotated');
await manager.update({ apiKey: null });
delete env.DEEPSEEK_API_KEY;
assert.equal((await manager.resolve()).apiKey, '');
assert.ok(!(await readFile(path, 'utf8')).includes('isolated-extraction'));
assert.ok(!JSON.stringify(await manager.status()).includes('isolated-rotated'));

// Loading the real schema catches host dependency resolution/schema drift.
process.env.DSH_HOST_MODULES = join(dirname(resolve(process.argv[2])), 'node_modules', '@deepseek-ai');
const plugin = await import('../index.js');
assert.ok(plugin.Config);
const schema = plugin.Config.toJSON();
assert.equal(Object.values(schema.refs).filter(node => node.meta?.role === 'secret').length, 4);
console.log('Installed DSH provider and schema: migration, env precedence, rotation, clearing and redaction passed.');
