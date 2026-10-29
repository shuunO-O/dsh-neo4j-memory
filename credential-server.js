/** Write-only credentials API. Every request is same-origin and responses contain metadata only. */
export function registerCredentialRoutes(ctx, credentials) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  return [ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-neo4j-memory/credentials',
      handler: async (req, res) => {
        const verb = String(req.method || 'GET').toUpperCase()
        if (!['GET', 'POST'].includes(verb)) return send(res, 405, { ok: false })
        try {
          const host = new URL('http://' + String(req.headers.host || ''))
          const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
          const origin = req.headers.origin
          if (['cross-site', 'same-site'].includes(site) || origin === 'null'
            || (origin && new URL(origin).host.toLowerCase() !== host.host.toLowerCase())
            || (verb === 'POST' && req.headers['x-dsh-neo4j-memory-action'] !== 'credentials')) {
            return send(res, 403, { ok: false })
          }
        } catch { return send(res, 403, { ok: false }) }
        try {
          if (verb === 'POST') {
            if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false })
            let size = 0
            const chunks = []
            for await (const chunk of req) {
              size += Buffer.byteLength(chunk)
              if (size > 70000) return send(res, 413, { ok: false })
              chunks.push(Buffer.from(chunk))
            }
            let values
            try { values = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
            catch { return send(res, 400, { ok: false }) }
            await credentials.update(values)
          }
          send(res, 200, { ok: true, data: await credentials.status() })
        } catch {
          // Provider errors may include the submitted value; never pass them through.
          send(res, 503, { ok: false, error: 'Memory credentials unavailable; retry the operation' })
        }
      },
    })]
}
