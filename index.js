import { loadHostDeps } from './hostdeps.js'
import { MemoryBackend } from './bridge.js'
import { registerGraphRoutes } from './graph-server.js'

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
    .description('Your extraction model API key; defaults to DEEPSEEK_API_KEY.'),
  embeddingApiKey: z.string().role('secret').volatile().default('')
    .description('Your embedding API key; defaults to EMBEDDING_API_KEY.'),
  alignmentApiKey: z.string().role('secret').volatile().default('')
    .description('Your concept alignment API key; defaults to TYPESAFE_API_KEY. Only required while concept alignment is enabled.'),
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
    .description('Password for an external Neo4j; leave empty to use the local database.'),
  dataDir: z.string().volatile().default('')
    .description('Folder that holds the local Neo4j data; leave empty for %LOCALAPPDATA%\\dsh-neo4j-memory. Set a folder the harness may write to when the local database cannot start. Takes effect the next time the memory backend starts.'),
}) : undefined

export const hostDependencyNotes = hostDeps.notes

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx, config) {
  const backend = new MemoryBackend(config)
  ctx.on('dispose', () => backend.close())

  // The graph viewer is optional: headless profiles have no webServer, and the tools must still work.
  ctx.inject(['webServer'], (web) => {
    const disposers = registerGraphRoutes(web, backend)
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
    description: 'Recall events, people or concepts from long-term graph memory using semantic search, related entity names or a calendar date. A failed search is an error and does not mean there are no matching memories.',
    parameters: {
      query_text: { type: 'string', description: 'Natural-language semantic query; at least one search condition is required.' },
      target_label: { type: 'string', enum: ['Event', 'Person', 'Concept'], description: 'Node type to retrieve; defaults to Event.' },
      entity_filter: { type: 'string', description: 'Exact name or known alias of a connected entity.' },
      time_hint: { type: 'string', description: 'Calendar date YYYY-MM-DD, in the configured memory timezone.' },
    },
    output,
    async execute(args, exec) {
      return backend.call('memory_database_search', args, exec.signal)
    },
  }))
}
