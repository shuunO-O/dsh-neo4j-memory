import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { MemoryCredentials, SECRET_SPECS } from '../lib/credentials.js';
import { MemoryConfig } from '../lib/config.js';
import { MemoryBackend, MemoryService } from '../lib/service.js';
import { registerCredentialRoutes } from '../credential-server.js';

function fixture(config = {}, env = {}) {
  const disk = new Map();
  const writes = [];
  const service = {
    resolve: async ref => disk.has(ref) ? { value: disk.get(ref), source: 'file' } : undefined,
    set: async (ref, value) => { writes.push([ref, value]); disk.set(ref, value); },
    unset: async ref => { disk.delete(ref); },
  };
  const cleanup = async values => {
    for (const [field, expected] of Object.entries(values)) {
      assert.equal(config[field], expected);
      assert.equal(disk.get(SECRET_SPECS[field].ref), expected);
      config[field] = '';
    }
  };
  return { config, env, disk, writes, service, cleanup,
    manager: new MemoryCredentials(config, () => service, cleanup, env) };
}

test('all four secrets prefer environment over DSH and Config, without persisting environment values', async () => {
  const config = { neo4jMode: 'external' }, env = {};
  for (const [field, spec] of Object.entries(SECRET_SPECS)) {
    config[field] = `legacy-${field}`;
    env[spec.env] = ` env-${field} `;
  }
  const f = fixture(config, env);
  const resolved = await f.manager.resolve();
  const cfg = MemoryConfig.fromEnvironment(resolved, env);
  for (const [field, spec] of Object.entries(SECRET_SPECS)) {
    assert.equal(cfg[field], `env-${field}`);
    assert.equal(f.disk.get(spec.ref), `legacy-${field}`);
    assert.equal(config[field], '');
  }
  assert.ok(f.writes.every(([, value]) => value.startsWith('legacy-')));
  delete env.EMBEDDING_API_KEY;
  assert.equal((await f.manager.resolve()).embeddingApiKey, 'legacy-embeddingApiKey');
  env.EMBEDDING_API_KEY = '  ';
  assert.equal((await f.manager.resolve()).embeddingApiKey, 'legacy-embeddingApiKey');
  env[SECRET_SPECS.embeddingApiKey.ref] = 'private-env';
  assert.equal((await f.manager.resolve()).embeddingApiKey, 'private-env');
});

test('a failed credential write retains legacy Config and does not leak provider error details', async () => {
  const f = fixture({ apiKey: 'legacy-extraction' });
  f.service.set = async () => { throw new Error('vendor leaked legacy-extraction'); };
  await assert.rejects(f.manager.migrate(), error => !error.message.includes('legacy-extraction'));
  assert.equal(f.config.apiKey, 'legacy-extraction');
  assert.equal((await f.manager.resolve()).apiKey, 'legacy-extraction');
  const status = await f.manager.status();
  assert.equal(status.migrationPending, true);
  assert.equal(status.secrets.apiKey.source, 'legacy');
  assert.ok(!JSON.stringify(status).includes('legacy-extraction'));
});

test('migration never clears Config until the persisted value has been read back', async () => {
  const f = fixture({ apiKey: 'legacy' });
  f.service.set = async () => {};
  await assert.rejects(f.manager.migrate());
  assert.equal(f.config.apiKey, 'legacy');
});

test('migration retries Config cleanup after a successful credential write and refreshes keys live', async () => {
  const f = fixture({ embeddingApiKey: 'old-embedding' });
  let fail = true;
  const manager = new MemoryCredentials(f.config, () => f.service, async values => {
    if (fail) throw new Error('Config locked');
    await f.cleanup(values);
  }, {});
  await assert.rejects(manager.migrate());
  assert.equal(f.disk.get(SECRET_SPECS.embeddingApiKey.ref), 'old-embedding');
  assert.equal(f.config.embeddingApiKey, 'old-embedding');
  fail = false;
  await manager.migrate();
  assert.equal(f.config.embeddingApiKey, '');
  assert.equal(f.writes.length, 1);
  f.disk.set(SECRET_SPECS.embeddingApiKey.ref, 'rotated');
  assert.equal((await manager.resolve()).embeddingApiKey, 'rotated');
});

test('existing different DSH credentials win without silently discarding old Config', async () => {
  const f = fixture({ apiKey: 'legacy' });
  f.disk.set(SECRET_SPECS.apiKey.ref, 'managed');
  assert.equal((await f.manager.resolve()).apiKey, 'managed');
  assert.equal(f.config.apiKey, 'legacy');
  assert.equal((await f.manager.status()).migrationPending, true);
});

test('clearing removes legacy Config and DSH values, but environment overrides stay effective', async () => {
  const f = fixture({ apiKey: 'legacy' }, { DEEPSEEK_API_KEY: 'env-key' });
  // The saved key and legacy key may differ after a previous migration conflict.
  f.disk.set(SECRET_SPECS.apiKey.ref, 'legacy');
  await f.manager.update({ apiKey: null });
  assert.equal(f.config.apiKey, '');
  assert.equal(f.disk.has(SECRET_SPECS.apiKey.ref), false);
  assert.equal((await f.manager.resolve()).apiKey, 'env-key');
  delete f.env.DEEPSEEK_API_KEY;
  assert.equal((await f.manager.resolve()).apiKey, '');
  const restarted = new MemoryCredentials(f.config, () => f.service, f.cleanup, {});
  assert.equal((await restarted.resolve()).apiKey, '');
});

test('replacement persists the new DSH value before clearing legacy Config', async () => {
  const f = fixture({ apiKey: 'old' });
  const manager = new MemoryCredentials(f.config, () => f.service, async values => {
    assert.equal(f.disk.get(SECRET_SPECS.apiKey.ref), 'new');
    assert.deepEqual(values, { apiKey: 'old' });
    f.config.apiKey = '';
  }, {});
  await manager.update({ apiKey: ' new ' });
  assert.equal((await manager.resolve()).apiKey, 'new');
  assert.equal(f.config.apiKey, '');
  assert.equal(f.disk.has('DEEPSEEK_API_KEY'), false);
});

test('unknown fields, blank values and invalid payloads cause no partial writes', async () => {
  const f = fixture();
  for (const values of [[], null, { apiKey: 'ok', unknown: 'bad' }, { apiKey: '' }, { apiKey: 3 }, { apiKey: 'x'.repeat(16385) }]) {
    await assert.rejects(f.manager.update(values));
  }
  assert.equal(f.writes.length, 0);
});

test('no DSH service keeps standalone env/legacy reads working and rejects new secret writes', async () => {
  const manager = new MemoryCredentials({ apiKey: 'legacy' }, () => undefined, undefined, { EMBEDDING_API_KEY: 'env' });
  const keys = await manager.resolve();
  assert.equal(keys.apiKey, 'legacy');
  assert.equal(keys.embeddingApiKey, 'env');
  assert.equal((await manager.status()).writable, false);
  await assert.rejects(manager.update({ apiKey: 'new' }), /unavailable/);
});

test('backend reads changed DSH model keys for each operation', async t => {
  const f = fixture({ neo4jMode: 'external', neo4jPassword: 'db', apiKey: 'first' });
  const original = MemoryService.create;
  t.after(() => { MemoryService.create = original; });
  const observed = [];
  MemoryService.create = async keys => new MemoryService(MemoryConfig.fromEnvironment(keys, {}), undefined, {
    graph: async () => { observed.push(keys.apiKey); return {}; }, close: async () => {},
  });
  const backend = new MemoryBackend(f.config, () => f.manager.resolve());
  t.after(() => backend.close());
  const service = await backend.start();
  service.call = async () => { observed.push(service.config.apiKey); return {}; };
  await backend.call('memory_database_graph', {});
  await f.manager.update({ apiKey: 'second' });
  await backend.call('memory_database_graph', {});
  assert.deepEqual(observed, ['first', 'second']);
});

async function httpFixture(t, manager) {
  let route;
  registerCredentialRoutes({ webServer: { register: value => { route = value; return () => {}; } } }, manager);
  const http = createServer((req, res) => { void route.handler(req, res); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  return `http://127.0.0.1:${http.address().port}${route.path}`;
}
const postHeaders = { 'content-type': 'application/json', 'x-dsh-neo4j-memory-action': 'credentials' };

test('credential HTTP API saves, clears and returns metadata without any secret value', async t => {
  const f = fixture();
  const url = await httpFixture(t, f.manager);
  const response = await fetch(url, { method: 'POST', headers: postHeaders, body: JSON.stringify({ apiKey: 'http-secret' }) });
  assert.equal(response.status, 200);
  assert.equal(f.disk.get(SECRET_SPECS.apiKey.ref), 'http-secret');
  assert.ok(!(await response.text()).includes('http-secret'));
  const status = await (await fetch(url)).json();
  assert.deepEqual(status.data.secrets.apiKey, { configured: true, source: 'dsh', ref: SECRET_SPECS.apiKey.ref });
  const cleared = await fetch(url, { method: 'POST', headers: postHeaders, body: '{"apiKey":null}' });
  assert.equal(cleared.status, 200);
  assert.equal(f.disk.size, 0);
});

test('plugin host migrates volatile Config through the DSH settings revision API', async t => {
  const plugin = await import('../index.js');
  const f = fixture();
  const values = { apiKey: 'host-legacy' };
  const config = { apiKey: { [Symbol.for('cosmokit.volatile.write')]: true, get: () => values.apiKey } };
  const mutations = [], routes = [];
  const settings = {
    writable: true,
    describe: () => [{ ns: plugin.name, revision: 7 }],
    mutate: async (ns, ops, revision) => {
      assert.equal(f.disk.get(SECRET_SPECS.apiKey.ref), 'host-legacy');
      mutations.push({ ns, ops, revision });
      for (const op of ops) values[op.path[0]] = op.value;
    },
  };
  const ctx = {
    get: key => key === 'credentials' ? f.service : key === 'settings' ? settings : undefined,
    tools: { register() {} }, on() {}, effect: effect => effect(),
    webServer: { register: route => { routes.push(route); return () => {}; } },
    inject: (deps, effect) => effect(deps[0] === 'settings' ? { settings } : ctx),
  };
  plugin.apply(ctx, config);
  const route = routes.find(route => route.path === '/dsh-neo4j-memory/credentials');
  const http = createServer((req, res) => { void route.handler(req, res); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${http.address().port}${route.path}`);
  assert.equal(response.status, 200);
  assert.equal(values.apiKey, '');
  assert.deepEqual(mutations, [{ ns: plugin.name, revision: 7, ops: [{ op: 'set', path: ['apiKey'], value: '' }] }]);
  assert.ok(!(await response.text()).includes('host-legacy'));
});

test('credential HTTP API rejects cross-origin writes, malformed/large requests and sanitizes errors', async t => {
  const f = fixture();
  const url = await httpFixture(t, f.manager);
  for (const headers of [{}, { ...postHeaders, origin: 'https://evil.example' }, { ...postHeaders, origin: 'null' }, { ...postHeaders, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"apiKey":"secret"}' })).status, 403);
  }
  assert.equal((await fetch(url, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: postHeaders, body: ' '.repeat(70001) })).status, 413);
  assert.equal(f.disk.size, 0);
  f.service.set = async () => { throw new Error('private-provider-value'); };
  const response = await fetch(url, { method: 'POST', headers: postHeaders, body: '{"apiKey":"private-provider-value"}' });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private-provider-value'));
});

test('actual settings page sends keys only to credentials and ordinary settings only to Config', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let definition, page, cursor = 0;
  const states = [], effects = [], requests = [], mutations = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect: effect => { cursor++; effects.push(effect); },
    useRef: initial => { cursor++; return { current: initial }; },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { definition = value; } } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, data: { writable: true, secrets: {} } }) };
    },
  };
  vm.runInNewContext(source, sandbox);
  const client = definition.factory(() => react);
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { extractionModel: 'deepseek-flash' } }),
    subscribe: () => () => {}, mutate: async ops => { mutations.push(ops); return true; },
  };
  client.apply({
    locale: { bind: () => key => key, register: () => () => {} },
    effect: effect => effect(), configForms: { get: () => form },
    slots: { inject: (_name, effect) => effect(), register: (meta, component) => { if (meta.name === 'settings.section') page = component; } },
  });
  const render = () => { cursor = 0; return page({ form, t: key => key }); };
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.children)] : [];
  let nodes = flatten(render());
  await Promise.all(effects.splice(0).map(effect => effect()));
  await new Promise(resolve => setImmediate(resolve));
  nodes = flatten(render());
  nodes.find(node => node.type === 'button' && node.props['aria-controls'] === 'dsh-neo4j-memory-keys').props.onClick();
  nodes = flatten(render());
  nodes.find(node => node.props.id === 'dsh-neo4j-memory-api-key').props.onChange({ target: { type: 'password', value: 'ui-secret' } });
  nodes = flatten(render());
  await nodes.find(node => node.type === 'button' && node.children.includes('save')).props.onClick();
  assert.equal(mutations.length, 0);
  assert.deepEqual(JSON.parse(requests.find(request => request.options.method === 'POST').options.body), { apiKey: 'ui-secret' });
  nodes = flatten(render());
  await nodes.find(node => node.props.id === 'dsh-neo4j-memory-api-key').props.onClear();
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { apiKey: null });
  assert.equal(mutations.length, 0);
  nodes.find(node => node.type === 'button' && node.props['aria-controls'] === 'dsh-neo4j-memory-model-endpoints').props.onClick();
  nodes = flatten(render());
  nodes.find(node => node.props.id === 'dsh-neo4j-memory-extraction-model').props.onChange({ target: { type: 'text', value: 'new-model' } });
  nodes = flatten(render());
  await nodes.find(node => node.type === 'button' && node.children.includes('save')).props.onClick();
  assert.equal(mutations.length, 1);
  assert.ok(!JSON.stringify(mutations).includes('ui-secret'));
});
