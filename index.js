import { loadHostDeps } from './hostdeps.js'
import { MemoryBackend } from './bridge.js'
import { registerGraphRoutes } from './graph-server.js'
import { renderMemoryEvidence } from './lib/evidence.js'
import { MemoryCredentials } from './lib/credentials.js'
import { liveValue } from './lib/config.js'
import { registerCredentialRoutes } from './credential-server.js'

// Both @deepseek-ai packages are optional peers, which a desktop profile never installs.
// Resolving them here keeps one failed import from taking the whole plugin entry down.
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'dsh-neo4j-memory'
export const inject = ['tools']

// Without schemastery there is no config schema; the plugin still loads and the tools fall back
// to environment variables, which is what the README documents for headless use.
export const Config = z ? z.object({
  apiKey: z.string().role('secret').volatile().default('')
    .description('Legacy extraction key, migrated to DSH credentials. Use the Neo4j Memory settings to save keys. DEEPSEEK_API_KEY overrides saved credentials.'),
  embeddingApiKey: z.string().role('secret').volatile().default('')
    .description('Legacy embedding key, migrated to DSH credentials. EMBEDDING_API_KEY overrides saved credentials.'),
  alignmentApiKey: z.string().role('secret').volatile().default('')
    .description('Legacy alignment key, migrated to DSH credentials. TYPESAFE_API_KEY overrides saved credentials. Only required while concept alignment is enabled.'),
  conceptAlignment: z.boolean().volatile().default(true)
    .description('Run the TypeSafe concept alignment pass before writing Concept nodes. Disable it to skip those model calls and reuse concepts only by exact name or alias.'),
  extractionBaseUrl: z.string().volatile().default('https://api.deepseek.com')
    .description('Base URL for the extraction chat API; defaults to https://api.deepseek.com.'),
  extractionModel: z.string().volatile().default('deepseek-flash')
    .description('Extraction model name; defaults to deepseek-flash.'),
  embeddingBaseUrl: z.string().volatile().default('https://dashscope.aliyuncs.com/compatible-mode/v1')
    .description('Base URL for the OpenAI-compatible embeddings API; defaults to the DashScope compatible endpoint.'),
  embeddingModel: z.string().volatile().default('qwen3.7-text-embedding')
    .description('Embedding model name; defaults to qwen3.7-text-embedding. It must return the configured dimensions.'),
  embeddingDimensions: z.number().min(1).max(4096).volatile().default(1024)
    .description('Vector dimensions returned by the embedding model. Changing the model or this value requires re-vectorizing existing memories before saving or searching again.'),
  alignmentBaseUrl: z.string().volatile().default('https://api.typesafe.ai/v1/systemone')
    .description('Full endpoint URL for the decisions/alignment API. TypeSafe defaults to https://api.typesafe.ai/v1/systemone; OpenRouter uses https://openrouter.ai/api/alpha/decisions.'),
  alignmentModel: z.string().volatile().default('jev')
    .description('Concept alignment model name; defaults to jev.'),
  alignmentThreshold: z.number().min(0.8).max(0.99).volatile().default(0.95)
    .description('Minimum identity probability for reusing an existing concept. The opposite-candidate threshold is five points lower.'),
  neo4jMode: z.string().volatile().default('auto')
    .description('auto uses the local Neo4j (downloaded on first use) unless NEO4J_PASSWORD or DSH_NEO4J_MEMORY_NEO4J_URI is set; managed always uses the local database; external always connects to the configured server.'),
  neo4jPassword: z.string().role('secret').volatile().default('')
    .description('Legacy external Neo4j password, migrated to DSH credentials. NEO4J_PASSWORD overrides saved credentials.'),
  dataDir: z.string().volatile().default('')
    .description('Folder that holds the local Neo4j data; leave empty for %LOCALAPPDATA%\\dsh-neo4j-memory. Set a folder the harness may write to when the local database cannot start. Takes effect the next time the memory backend starts.'),
}) : undefined

export const hostDependencyNotes = hostDeps.notes

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const searchOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: value?.status === 'ok' && ['evidence', 'source'].includes(value.data?.kind) ? renderMemoryEvidence(value.data) : JSON.stringify(value) }],
}

export function apply(ctx, config) {
  const credentials = new MemoryCredentials(config, () => ctx.get?.('credentials'), async (values) => {
    const settings = ctx.get?.('settings')
    if (!settings?.writable || typeof settings.mutate !== 'function') throw new Error('Memory settings are read-only')
    const form = settings.describe().find((row) => row.ns === name)
    if (!form) throw new Error('Memory configuration is unavailable')
    const ops = Object.entries(values).map(([field, expected]) => {
      if (String(liveValue(config[field]) || '').trim() !== expected) throw new Error('Memory configuration changed; retry')
      // An explicit blank also masks a secret inherited from a bundle layer.
      return { op: 'set', path: [field], value: '' }
    })
    await settings.mutate(form.ns, ops, form.revision)
  })
  const backend = new MemoryBackend(config, () => credentials.resolve())
  ctx.on('dispose', () => backend.close())
  // The custom page owns secret entry; hide the generic Config editor so it
  // cannot create new plaintext legacy keys through an autogenerated form.
  ctx.inject(['settings'], (host) => {
    if (typeof host.settings.configure === 'function') host.effect(() => host.settings.configure({ auto: false }, ctx.fiber))
  })

  // The graph viewer is optional: headless profiles have no webServer, and the tools must still work.
  ctx.inject(['webServer'], (web) => {
    const disposers = [...registerGraphRoutes(web, backend), ...registerCredentialRoutes(web, credentials)]
    web.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* route already gone */ }
      }
    })
  })

  ctx.tools.register(defineTool({
    name: 'memory_database_save',
    description: 'Save a worthwhile experience, fact or preference to long-term graph memory. Include known people, time and context. Only content supplied to this tool is saved; chat history is not scanned.',
    parameters: {
      content: { type: 'string', required: true, description: 'Memory text, up to 32,000 characters. Include names rather than ambiguous pronouns when known.' },
    },
    output,
    async execute(args, exec) {
      return backend.call('memory_database_save', {
        content: args.content,
        session_id: exec.agent?.session?.id || 'dsh',
      }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_database_search',
    description: 'Recall graph memory. Default search fuses summary and source vectors and returns up to 4 new events with compact source evidence and shared-concept continuation entries. Use read for source text, expand for more events through a returned concept, or nearby for chapter/record neighbors when available. Pass the returned cursor for expand/nearby; these return only newly added events. Shared concepts and source proximity do not establish causality. A failed call does not mean there are no memories.',
    parameters: {
      operation: { type: 'string', enum: ['search', 'read', 'expand', 'nearby'], description: 'Defaults to search. read needs event_id; expand needs cursor and concept_id; nearby needs cursor and event_id.' },
      reset_seen: { type: 'boolean', description: 'search only: start a new recall task, allowing earlier events to be returned again. Delivered-ID and excerpt history otherwise expire after 15 minutes of inactivity.' },
      query_text: { type: 'string', description: 'Natural-language semantic query; at least one search condition is required.' },
      target_label: { type: 'string', enum: ['Event', 'Person', 'Concept'], description: 'Node type to retrieve; defaults to Event.' },
      entity_filter: { type: 'string', description: 'Exact name or known alias of a connected entity.' },
      time_hint: { type: 'string', description: 'Stored/written date YYYY-MM-DD in the configured memory timezone; not necessarily the event occurrence date.' },
      event_id: { type: 'string', description: 'Event ID as returned, without a type prefix. Used by read/nearby.' },
      concept_id: { type: 'string', description: 'Concept ID from the current continuation entries. Used by expand.' },
      cursor: { type: 'string', description: 'Continuation cursor returned by this session; valid for 15 minutes. Use the latest returned cursor to continue.' },
      start: { type: 'number', description: 'read source start offset, default 0. Offsets count Unicode characters, excluding the end position.' },
      limit: { type: 'number', description: 'read: 1..10000 characters, default 1600. expand: accepts 1..8, delivers at most 4 new events within the remaining chain budget, default 3.' },
      before: { type: 'number', description: 'nearby: preceding source record-number distance, 0..10, default 2.' },
      after: { type: 'number', description: 'nearby: following source record-number distance, 0..10, default 2.' },
    },
    output: searchOutput,
    async execute(args, exec) {
      return backend.call('memory_database_search', { ...args, session_id: exec.agent?.session?.id || 'dsh' }, exec.signal)
    },
  }))
}
