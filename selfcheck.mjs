/**
 * selfcheck.mjs — run both halves of the plugin on a fake host before restarting dsh.
 *
 *   node selfcheck.mjs          # from the plugin directory
 *
 * Exit code 0 means: the host module loads (even without the optional peers installed), the two
 * tools and the graph routes register, the graph page and its data route answer correctly, and the
 * browser bundle registers its settings sections with locale labels that exist.
 *
 * It never touches the real Neo4j, the real config, or the user's memory: the backend is
 * replaced by a stub, and every dependency on dsh is faked.
 */

import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const failures = []
const notes = []

function ok(message) {
  console.log(`  ✓ ${message}`)
}
function bad(message) {
  console.log(`  ✗ ${message}`)
  failures.push(message)
}
function note(message) {
  notes.push(message)
  console.log(`  · ${message}`)
}
function section(title) {
  console.log(`\n${title}`)
}
function assert(condition, message) {
  if (condition) ok(message)
  else bad(message)
  return Boolean(condition)
}

const read = (path) => readFileSync(join(ROOT, path), 'utf8')

/* ───────────────────────── ① host half ───────────────────────── */

section('① host half: module load, tools, routes')

let plugin
try {
  plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  ok('index.js imports (optional peers missing is tolerated)')
} catch (error) {
  bad(`index.js failed to import: ${error?.name}: ${error?.message}`)
}
if (!plugin) process.exit(1)

for (const entry of plugin.hostDependencyNotes || []) note(entry)
assert(plugin.name === 'dsh-neo4j-memory', 'plugin name is dsh-neo4j-memory')
assert(plugin.Config === undefined || typeof plugin.Config === 'object', 'Config is an object, or undefined when schemastery is unavailable')

const tools = []
const routes = []
const fakeBackendCalls = []
let disposeCount = 0
const fakeCtx = {
  tools: { register: (tool) => { tools.push(tool); return tool } },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => { disposeCount += 1 }
    },
  },
  inject: (deps, callback) => {
    if (!Array.isArray(deps) || deps[0] !== 'webServer') bad(`unexpected inject deps: ${JSON.stringify(deps)}`)
    return callback(fakeCtx)
  },
  effect: (fn) => fn(),
  on: () => {},
}

try {
  plugin.apply(fakeCtx, {})
  ok('apply() completed on a fake context')
} catch (error) {
  bad(`apply() threw: ${error?.message}`)
}

const toolNames = tools.map((tool) => tool.name).sort()
assert(JSON.stringify(toolNames) === JSON.stringify(['memory_database_save', 'memory_database_search']), `tools registered: ${toolNames.join(', ')}`)
for (const tool of tools) {
  assert(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name}: description present`)
  assert(typeof tool.execute === 'function', `${tool.name}: execute is a function`)
  assert(tool.parameters?.type === 'object', `${tool.name}: parameters converted to JSON Schema`)
  assert(tool.parameters?.additionalProperties === false, `${tool.name}: parameters reject unknown keys`)
  const requiresArguments = Object.values(tool.parameters?.properties || {}).length > 0
  const expectedRequired = tool.name === 'memory_database_save' ? ['content'] : []
  const required = tool.parameters?.required || []
  assert(requiresArguments && JSON.stringify(required) === JSON.stringify(expectedRequired), `${tool.name}: required = ${JSON.stringify(required)}`)
}

const expectedPaths = [
  '/dsh-neo4j-memory/graph', '/dsh-neo4j-memory/graph/', '/dsh-neo4j-memory/graph/index.html',
  '/dsh-neo4j-memory/graph/app.js', '/dsh-neo4j-memory/graph/graph-engine.js', '/dsh-neo4j-memory/graph/graph-io.js',
  '/dsh-neo4j-memory/graph/graph-renderer.js', '/dsh-neo4j-memory/graph/graph-worker.js',
  '/dsh-neo4j-memory/graph/radial-layout.js', '/dsh-neo4j-memory/graph/style.css',
  '/dsh-neo4j-memory/graph.json',
  '/dsh-neo4j-memory/embedding-status', '/dsh-neo4j-memory/reembed',
]
const registeredPaths = routes.map((route) => route.path)
const missingRoutes = expectedPaths.filter((path) => !registeredPaths.includes(path))
assert(missingRoutes.length === 0, `all ${expectedPaths.length} graph routes registered${missingRoutes.length ? ` (missing ${missingRoutes.join(', ')})` : ''}`)
assert(routes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'), 'every graph route is exact with a handler')

/* ───────────────────── ② config / client reconciliation ───────────────────── */

section('② config reconciliation between both halves')

const indexSource = read('index.js')
const clientSource = read('client.js')
const configKeys = [...indexSource.matchAll(/^[ \t]{2}([A-Za-z0-9]+): z\./gm)].map((match) => match[1]).sort()
const clientSecrets = (clientSource.match(/const SECRET_FIELDS = \[([^\]]+)\]/)?.[1] || '')
  .split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean).sort()
const clientFields = [
  'conceptAlignment', 'neo4jMode', 'dataDir',
  'extractionBaseUrl', 'extractionModel',
  'embeddingBaseUrl', 'embeddingModel', 'embeddingDimensions',
  'alignmentBaseUrl', 'alignmentModel', 'alignmentThreshold',
].sort()

assert(configKeys.length === 15, `Config declares 15 fields (${configKeys.join(', ')})`)
assert(JSON.stringify(clientSecrets) === JSON.stringify(['alignmentApiKey', 'apiKey', 'embeddingApiKey', 'neo4jPassword']), `secret fields match: ${clientSecrets.join(', ')}`)
const declaredInClient = [...clientSource.matchAll(/^[ \t]{8}([A-Za-z0-9]+):/gm)].map((match) => match[1])
for (const key of clientFields) {
  assert(declaredInClient.includes(key), `client form has ${key}`)
}
const uncovered = configKeys.filter((key) => !clientSecrets.includes(key) && !clientFields.includes(key))
assert(uncovered.length === 0, `every Config field is reachable from the settings page${uncovered.length ? ` (missing ${uncovered.join(', ')})` : ''}`)

/* ───────────────────── ③ graph routes over real HTTP ───────────────────── */

section('③ graph page and data route over real HTTP')

const sample = {
  nodes: [
    { id: 'Event:e1', label: 'Event', name: 'e1', type: 'milestone', summary: '摘要', create_time: '2026-10-24 10:00:00' },
    { id: 'Person:Ada', label: 'Person', name: 'Ada' },
  ],
  relationships: [{ source: 'Person:Ada', target: 'Event:e1', type: 'PARTICIPATED_IN', properties: {} }],
}

const { registerGraphRoutes } = await import(pathToFileURL(join(ROOT, 'graph-server.js')).href)
const checkRoutes = []
registerGraphRoutes({ webServer: { register: (route) => { checkRoutes.push(route); return () => {} } } }, {
  call: async (method, args) => { fakeBackendCalls.push([method, args]); return sample },
})

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const route = checkRoutes.find((item) => item.path === path)
  if (!route) { res.writeHead(404); res.end('missing'); return }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function request(path, options = {}) {
  const response = await fetch(base + path, options)
  const text = await response.text()
  return { status: response.status, type: response.headers.get('content-type') || '', text }
}

try {
  const page = await request('/dsh-neo4j-memory/graph/')
  assert(page.status === 200 && page.type.startsWith('text/html'), 'page answers 200 text/html')
  const referenced = [...page.text.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => !/^(https?:|#|\/)/.test(href))
  const unresolved = referenced.filter((href) => !registeredPaths.includes('/dsh-neo4j-memory/graph/' + href))
  assert(unresolved.length === 0, `page assets all routed (${referenced.length} referenced)${unresolved.length ? `: ${unresolved.join(', ')}` : ''}`)
  assert(!/\?v=/.test(page.text), 'no cache-busting query strings (exact routes match on path only)')

  for (const asset of ['app.js', 'style.css', 'graph-worker.js']) {
    const reply = await request('/dsh-neo4j-memory/graph/' + asset)
    assert(reply.status === 200 && reply.text.length > 200, `${asset}: 200 with content`)
  }

  const worker = read('web/graph/graph-worker.js')
  const imported = [...worker.matchAll(/importScripts\(([^)]*)\)/g)].flatMap((match) => match[1].split(',').map((item) => item.trim().replace(/['"]/g, '')))
  const workerMissing = imported.filter((file) => !registeredPaths.includes('/dsh-neo4j-memory/graph/' + file))
  assert(imported.length > 0 && workerMissing.length === 0, `worker imports routed files (${imported.join(', ')})`)

  const graph = await request('/dsh-neo4j-memory/graph.json')
  const payload = JSON.parse(graph.text)
  assert(graph.status === 200 && graph.type.startsWith('application/json'), 'graph.json answers 200 application/json')
  assert(payload.ok === true && payload.data?.nodes?.length === 2, 'graph.json returns the worker payload under data')
  assert(fakeBackendCalls[0]?.[0] === 'memory_database_graph', 'graph.json calls memory_database_graph')

  const filtered = await request('/dsh-neo4j-memory/graph.json?labels=Person,Location,../../etc')
  assert(JSON.stringify(fakeBackendCalls.at(-1)?.[1]?.labels) === JSON.stringify(['Person', 'Location']), 'labels are whitelisted before reaching the backend')
  assert(filtered.status === 200, 'filtered graph.json answers 200')

  assert((await request('/dsh-neo4j-memory/graph/nope.js')).status === 404, 'unknown asset answers 404')
  assert((await request('/dsh-neo4j-memory/graph.json', { method: 'POST' })).status === 405, 'POST is refused with 405')
  assert((await request('/dsh-neo4j-memory/graph.json', { headers: { 'sec-fetch-site': 'cross-site' } })).status === 403, 'cross-site read is refused with 403')
  assert((await request('/dsh-neo4j-memory/graph.json', { headers: { origin: 'https://evil.example' } })).status === 403, 'cross-origin read is refused with 403')

  assert((await request('/dsh-neo4j-memory/embedding-status')).status === 200, 'embedding status answers 200')
  assert((await request('/dsh-neo4j-memory/reembed', { method: 'POST' })).status === 403, 're-vectorize POST requires the action header')
  assert((await request('/dsh-neo4j-memory/reembed')).status === 405, 're-vectorize only accepts POST')
  const reembed = await request('/dsh-neo4j-memory/reembed', { method: 'POST', headers: { 'x-dsh-neo4j-memory-action': 'reembed' } })
  assert(reembed.status === 200 && JSON.parse(reembed.text).ok === true, 're-vectorize POST is accepted from a same-origin caller')
  assert(fakeBackendCalls.some(([method]) => method === 'memory_database_reembed'), 're-vectorize reaches the backend')
} catch (error) {
  bad(`HTTP checks threw: ${error?.message}`)
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

/* ───────────────────── ④ browser half ───────────────────── */

section('④ browser half: bundle, sections, locale')

const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  Fragment: 'Fragment',
}

const styleTags = []
const documentStub = { head: { appendChild: () => {} }, createElement: () => ({ setAttribute: () => {}, remove: () => {} }), querySelector: () => null }
const sandbox = {
  window: {},
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
}
const bundle = { id: null, factory: null }
sandbox.window.__ModuleLoader__ = { load: (definition) => { bundle.id = definition.id; bundle.factory = definition.factory } }
vm.createContext(sandbox)
try {
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' })
  ok('client.js self-registers through window.__ModuleLoader__')
} catch (error) {
  bad(`client.js failed to evaluate: ${error.message}`)
}

if (bundle.factory) {
  assert(bundle.id === 'dsh-neo4j-memory', `bundle id matches package name (${bundle.id})`)
  const client = bundle.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })
  assert(Array.isArray(client.inject), `client injects ${JSON.stringify(client.inject)}`)

  const sections = []
  const dictionaries = new Map()
  const fakeForm = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { neo4jMode: 'auto', conceptAlignment: true } }),
    subscribe: () => () => {},
    mutate: async () => true,
    unset: async () => true,
  }
  const clientCtx = {
    get: () => undefined,
    effect: (fn) => fn(),
    slots: {
      inject: (_name, factory) => factory(),
      register: (meta, component) => { sections.push({ meta, component }); return { dispose() {} } },
    },
    locale: {
      bind: (namespace) => (key) => dictionaries.get(namespace)?.[key] ?? key,
      register: (namespace, dicts) => { dictionaries.set(namespace, dicts.zh || {}); return () => {} },
    },
    configForms: { get: () => fakeForm },
  }
  try {
    client.apply(clientCtx)
    ok('client apply() completed')
  } catch (error) {
    bad(`client apply() threw: ${error.message}`)
  }

  const settingsSections = sections.filter((entry) => entry.meta.name === 'settings.section')
  assert(settingsSections.length === 1, `one merged settings section registered (${settingsSections.length})`)
  const ids = settingsSections.map((entry) => entry.meta.id)
  assert(JSON.stringify(ids) === JSON.stringify(['dsh-neo4j-memory']), `section ids: ${ids.join(', ')}`)
  for (const entry of settingsSections) {
    const label = entry.meta.label()
    assert(typeof label === 'string' && label.length > 0 && label !== 'graphNav' && label !== 'nav', `${entry.meta.id}: label resolves through locale (${label})`)
    assert(entry.meta.order === 16, `${entry.meta.id}: order ${entry.meta.order}`)
    assert(typeof entry.component === 'function', `${entry.meta.id}: component provided`)
  }

  const translate = (key) => dictionaries.get('dsh-neo4j-memory')?.[key] ?? key
  const overlay = sections.find((entry) => entry.meta.name === 'shell.overlay')
  assert(Boolean(overlay), 'graph overlay registered on shell.overlay')
  if (overlay) {
    assert(overlay.meta.id === 'dsh-neo4j-memory-graph-overlay', `overlay id (${overlay.meta.id})`)
    assert(overlay.component({ t: translate }) === null, 'overlay renders nothing while closed')
  }

  const settingsSection = settingsSections[0]
  if (settingsSection) {
    const tree = settingsSection.component({ form: fakeForm, t: translate })
    const flatten = (node) => (Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.children)] : [])
    const textOf = (node) => (Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? textOf(node.children) : '')
    const nodes = flatten(tree)
    assert(!nodes.some((node) => node.type === 'iframe'), 'merged page no longer embeds the graph inline')
    const graphCard = nodes.find((node) => typeof node.type === 'function' && node.type.name === 'GraphCard')
    assert(Boolean(graphCard), 'merged page renders the graph card')
    const cardNodes = graphCard ? flatten(graphCard.type(graphCard.props)) : []
    assert(!cardNodes.some((node) => node.type === 'iframe'), 'graph card does not load the page before expansion')
    assert(cardNodes.some((node) => node.type === 'button' && node.props?.onClick && textOf(node).includes(translate('graphExpand'))), 'graph card offers the expand action')
    const keysToggle = nodes.find((node) => node.type === 'button' && node.props?.['aria-expanded'] === false && textOf(node).includes(translate('keysToggle')))
    assert(Boolean(keysToggle), 'API keys start collapsed')
    const endpointsToggle = nodes.find((node) => node.type === 'button' && node.props?.['aria-expanded'] === false && textOf(node).includes(translate('modelEndpointsToggle')))
    assert(Boolean(endpointsToggle), 'model endpoints start collapsed')
    assert(!nodes.some((node) => typeof node.type === 'function' && node.type.name === 'Field' && node.props?.id === 'dsh-neo4j-memory-api-key'), 'API key fields stay unmounted while collapsed')
  }
}

/* ───────────────────── ⑤ TypeScript backend ───────────────────── */

section('⑤ TypeScript backend: service contract')

const { MemoryService } = await import('./lib/service.js')
const { MemoryConfig } = await import('./lib/config.js')
const volatileCell = (value) => Object.freeze({
  get: () => value,
  [Symbol.for('cosmokit.volatile.write')]: () => {},
})
const liveConfig = MemoryConfig.fromEnvironment({
  apiKey: volatileCell('sk-test-extraction'),
  embeddingApiKey: volatileCell('sk-test-embedding'),
  conceptAlignment: volatileCell(false),
  neo4jMode: volatileCell('managed'),
}, {})
assert(
  liveConfig.apiKey === 'sk-test-extraction'
    && liveConfig.embeddingApiKey === 'sk-test-embedding'
    && liveConfig.conceptAlignment === false
    && liveConfig.neo4jManaged,
  'live Config cells (cosmokit volatile) are unwrapped before use',
)
assert(
  liveConfig.extractionModel === 'deepseek-flash'
    && liveConfig.embeddingModel === 'qwen3.7-text-embedding'
    && liveConfig.dimensions === 1024
    && liveConfig.alignmentModel === 'jev'
    && liveConfig.alignmentThreshold === 0.95,
  'model defaults are deepseek-flash / qwen3.7-text-embedding (1024 dims) / jev and the threshold is 0.95',
)
const customConfig = MemoryConfig.fromEnvironment({
  extractionBaseUrl: 'https://example.test/v1',
  extractionModel: 'custom-extract',
  embeddingBaseUrl: 'https://example.test/v1',
  embeddingModel: 'custom-embed',
  embeddingDimensions: 768,
  alignmentBaseUrl: 'https://example.test/v1',
  alignmentModel: 'custom-align',
  alignmentThreshold: 0.9,
  neo4jMode: 'managed',
}, {})
assert(
  customConfig.extractionUrl === 'https://example.test/v1'
    && customConfig.extractionModel === 'custom-extract'
    && customConfig.embeddingModel === 'custom-embed'
    && customConfig.dimensions === 768
    && customConfig.alignmentModel === 'custom-align'
    && customConfig.alignmentThreshold === 0.9,
  'custom base URLs, model names, dimensions and threshold are applied',
)
const service = new MemoryService(new MemoryConfig(), undefined, {
  graph: async (labels) => ({ nodes: labels, relationships: [] }),
  close: async () => {},
})
const graphResult = await service.call('memory_database_graph', { labels: ['Concept'] })
assert(graphResult.nodes[0] === 'Concept', 'TypeScript service routes graph calls without model keys')
try {
  await service.call('memory_database_graph', { labels: ['invalid'] })
  bad('graph service accepted an invalid label')
} catch { ok('graph service rejects invalid labels') }
await service.close()

for (const required of ['lib/service.js', 'lib/store.js', 'lib/runtime.js', 'lib/guardian.js', 'assets/extraction_prompt.md']) {
  try {
    statSync(join(ROOT, required))
    ok(`${required} present`)
  } catch {
    bad(`${required} missing`)
  }
}

/* ───────────────────── summary ───────────────────── */

console.log('')
if (failures.length) {
  console.log(`✗ ${failures.length} check(s) failed`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ all checks passed${notes.length ? ` (${notes.length} note${notes.length > 1 ? 's' : ''})` : ''}`)
