/**
 * Read-only HTTP surface for the memory graph page.
 *
 * The page itself is plain static files (no build step): the dsh web server hands them out
 * under /dsh-neo4j-memory/graph/, and /dsh-neo4j-memory/graph.json returns the graph the memory service reads
 * from Neo4j. Only same-origin GET requests are served; the re-vectorize maintenance route is a
 * same-origin POST guarded by a custom action header.
 */

import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const GRAPH_DIRECTORY = fileURLToPath(new URL('./web/graph/', import.meta.url))
const BASE = '/dsh-neo4j-memory/graph'
const GRAPH_JSON = '/dsh-neo4j-memory/graph.json'

// A fixed whitelist keeps path handling free of traversal questions.
const ASSETS = new Map([
  ['', 'index.html'],
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/graph-engine.js', 'graph-engine.js'],
  ['/graph-io.js', 'graph-io.js'],
  ['/graph-renderer.js', 'graph-renderer.js'],
  ['/graph-worker.js', 'graph-worker.js'],
  ['/radial-layout.js', 'radial-layout.js'],
  ['/style.css', 'style.css'],
])

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/**
 * Memory contents are personal: only a same-origin page of this dsh UI may read them.
 * Cross-site requests, cross-origin requests and writes are refused outright.
 */
function rejected(req, method = 'GET') {
  try {
    if (String(req?.method || 'GET').toUpperCase() !== method) return 405
    const headers = req?.headers || {}
    const host = new URL('http://' + String(headers.host || ''))
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    // Cross-origin pages cannot set this header without a preflight, which this server refuses.
    if (method !== 'GET' && String(headers['x-dsh-neo4j-memory-action'] || '') !== 'reembed') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      const parsed = new URL(origin)
      if (parsed.host.toLowerCase() !== host.host.toLowerCase()) return 403
    }
    return null
  } catch {
    return 403
  }
}

function send(res, status, body, headers = {}) {
  try {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
    res.end(body)
  } catch {
    // The client may already be gone; nothing to recover from here.
  }
}

function parseLabels(req) {
  try {
    const url = new URL(String(req?.url || ''), 'http://localhost')
    const raw = url.searchParams.get('labels') || ''
    const allowed = new Set(['Event', 'Person', 'Concept', 'Location'])
    return raw.split(',').map((item) => item.trim()).filter((item) => allowed.has(item)).slice(0, 4)
  } catch {
    return []
  }
}

/**
 * Registers the graph page and its data route on the host web server.
 * @param {object} ctx context that has webServer
 * @param {{call: (method: string, args: object) => Promise<any>}} backend shared memory service
 * @returns {Array<() => void>} disposers
 */
export function registerGraphRoutes(ctx, backend) {
  const disposers = []

  const route = (path, handler, method = 'GET') => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const deny = rejected(req, method)
        if (deny !== null) {
          send(res, deny, 'Unavailable', { 'Content-Type': 'text/plain; charset=utf-8' })
          return
        }
        try {
          await handler(req, res)
        } catch {
          if (!res.headersSent) send(res, 500, 'Unavailable', { 'Content-Type': 'text/plain; charset=utf-8' })
        }
      },
    }))
  }

  for (const [suffix, filename] of ASSETS) {
    route(BASE + suffix, async (_req, res) => {
      const body = await fs.readFile(GRAPH_DIRECTORY + filename)
      const extension = filename.slice(filename.lastIndexOf('.'))
      send(res, 200, body, { 'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream' })
    })
  }

  route(GRAPH_JSON, async (req, res) => {
    const json = { 'Content-Type': 'application/json; charset=utf-8' }
    try {
      const data = await backend.call('memory_database_graph', { labels: parseLabels(req) })
      send(res, 200, JSON.stringify({ ok: true, data }), json)
    } catch (error) {
      // Backend errors omit model response bodies and credentials.
      const message = String(error?.message || '').slice(0, 300) || '记忆图谱暂不可用'
      send(res, 503, JSON.stringify({ ok: false, data: { nodes: [], relationships: [] }, error: message }), json)
    }
  })

  route('/dsh-neo4j-memory/embedding-status', async (_req, res) => {
    const json = { 'Content-Type': 'application/json; charset=utf-8' }
    try {
      const result = await backend.call('memory_database_embedding_status', {})
      send(res, 200, JSON.stringify({ ok: true, data: result?.data ?? result }), json)
    } catch (error) {
      const message = String(error?.message || '').slice(0, 300) || '向量状态暂不可用'
      send(res, 503, JSON.stringify({ ok: false, error: message }), json)
    }
  })

  // Rebuilding all vectors is expensive, so it is an explicit same-origin POST, never a GET.
  route('/dsh-neo4j-memory/reembed', async (_req, res) => {
    const json = { 'Content-Type': 'application/json; charset=utf-8' }
    try {
      const result = await backend.call('memory_database_reembed', {})
      send(res, 200, JSON.stringify({ ok: true, data: result?.data ?? result }), json)
    } catch (error) {
      const message = String(error?.message || '').slice(0, 300) || '重新向量化失败'
      send(res, 503, JSON.stringify({ ok: false, error: message }), json)
    }
  }, 'POST')

  return disposers
}
