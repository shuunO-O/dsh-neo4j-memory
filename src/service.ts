import { MemoryConfig, type HostConfig } from './config.js';
import { ModelClient, ModelAPIError, labels } from './api.js';
import { Neo4jStore } from './store.js';
import { LocalNeo4j } from './runtime.js';

export class MemoryService {
  store: Neo4jStore;
  private reembedding = false;
  constructor(public config: MemoryConfig, public runtime?: LocalNeo4j, store?: Neo4jStore) { this.store = store ?? new Neo4jStore(config); }
  static async create(keys: HostConfig, signal?: AbortSignal): Promise<MemoryService> {
    const config = MemoryConfig.fromEnvironment(keys);
    let runtime: LocalNeo4j | undefined;
    try {
      if (config.neo4jManaged) {
        runtime = new LocalNeo4j(config.dataDir, undefined, signal);
        const info = await runtime.ensure();
        config.neo4jUri = info.uri; config.neo4jPassword = info.password; config.neo4jUser = info.user; config.neo4jDatabase = 'neo4j';
      }
      return new MemoryService(config, runtime);
    } catch (error) { await runtime?.stop(); throw error; }
  }
  async close() { try { await this.store.close(); } finally { await this.runtime?.stop(); } }
  /**
   * Refresh model-facing settings from the live Config cells on an already-running service.
   * The backend is created once; volatile edits (keys, endpoints, models, threshold) must be
   * re-read here or they would only apply after a restart.
   */
  applyLiveConfig(keys: HostConfig): void {
    // Do not mutate the model/dimensions while re-vectorization is reading them.
    if (this.reembedding) return;
    const next = MemoryConfig.fromEnvironment(keys);
    const current = this.config;
    const embeddingChanged = current.embeddingModel !== next.embeddingModel || current.dimensions !== next.dimensions;
    current.apiKey = next.apiKey;
    current.embeddingApiKey = next.embeddingApiKey;
    current.alignmentApiKey = next.alignmentApiKey;
    current.extractionUrl = next.extractionUrl;
    current.extractionModel = next.extractionModel;
    current.embeddingUrl = next.embeddingUrl;
    current.embeddingModel = next.embeddingModel;
    current.dimensions = next.dimensions;
    current.alignmentUrl = next.alignmentUrl;
    current.alignmentModel = next.alignmentModel;
    current.alignmentThreshold = next.alignmentThreshold;
    current.conceptAlignment = next.conceptAlignment;
    if (embeddingChanged) this.store.resetIndexes?.();
  }
  async call(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
    const client = new ModelClient(this.config, signal);
    const text = (name: string, limit: number) => {
      const value = args[name] ?? '';
      if (typeof value !== 'string' || [...value].length > limit) throw new Error(`Invalid ${name}`);
      return value.trim();
    };
    if (method === 'memory_database_embedding_status') return { status: 'ok', data: await this.store.embeddingStatus() };
    if (method === 'memory_database_reembed') {
      this.config.requireModelKeys(false, true);
      if (this.reembedding) throw new Error('Re-vectorization is already running');
      this.reembedding = true;
      try { return { status: 'ok', data: await this.store.reembed(client) }; }
      finally { this.reembedding = false; }
    }
    if (method === 'memory_database_graph') {
      const selected = args.labels ?? [];
      if (!Array.isArray(selected) || selected.length > 4 || selected.some(l => typeof l !== 'string' || !labels.includes(l))) throw new Error('labels must be Event, Person, Concept or Location');
      return this.store.graph(selected, signal);
    }
    if (this.reembedding) throw new Error('Memory is being re-vectorized; try again when it finishes');
    if (method === 'memory_database_save') {
      const content = text('content', 32000), source = text('session_id', 200) || 'dsh';
      if (!content) throw new Error('content cannot be empty');
      this.config.requireModelKeys(true, true, this.config.conceptAlignment);
      // Fail before paying for extraction if the embedding model/dimensions no longer match the store.
      await this.store.ensureIndexes(signal);
      const extraction = await client.extract(content);
      const saved = await this.store.save(content, source, extraction, client);
      return { status: 'ok', event_id: saved.event_id, concept_alignment: saved.decisions.map(d => Object.fromEntries(['mention', 'target_id', 'action', 'status', 'reason', 'error_code'].filter(k => k in d).map(k => [k, (d as unknown as Record<string, unknown>)[k]]))) };
    }
    if (method === 'memory_database_search') {
      const query = text('query_text', 4000) || undefined, entity = text('entity_filter', 500) || undefined, date = text('time_hint', 10) || undefined;
      const label = args.target_label ?? 'Event';
      if (typeof label !== 'string' || !['Event', 'Person', 'Concept'].includes(label)) throw new Error('target_label must be Event, Person or Concept');
      if (!query && !entity && !date) throw new Error('Provide query_text, entity_filter or time_hint');
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Invalid time_hint');
      this.config.requireModelKeys(false);
      return { status: 'ok', data: await this.store.search(query, label, entity, date, client) };
    }
    throw new Error('Unknown memory tool');
  }
}

/** One lazy, in-process service per Cordis plugin instance. */
export class MemoryBackend {
  private starting?: Promise<MemoryService>;
  private service?: MemoryService;
  private closed = false;
  private lifecycle = new AbortController();
  private pending = new Set<Promise<unknown>>();
  constructor(private keys: HostConfig = {}) {}
  async start() {
    if (this.closed) throw new Error('Memory plugin has been disposed');
    if (!this.starting) {
      this.starting = MemoryService.create(this.keys, AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(600_000)])).then(async service => {
        if (this.closed) { await service.close(); throw new Error('Memory plugin has been disposed'); }
        this.service = service; return service;
      }).catch(error => { this.starting = undefined; throw error; });
    }
    return this.starting;
  }
  async call(method: string, args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.pending.size >= 16) throw new Error('Memory backend is busy');
    const waiting = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]);
    const operation = (async () => {
      const service = await new Promise<MemoryService>((resolve, reject) => {
        const abort = () => reject(new Error('Memory call cancelled'));
        waiting.addEventListener('abort', abort, { once: true });
        if (waiting.aborted) { waiting.removeEventListener('abort', abort); abort(); return; }
        this.start().then(resolve, reject).finally(() => waiting.removeEventListener('abort', abort));
      });
      service.applyLiveConfig(this.keys);
      const timeout = method === 'memory_database_reembed' ? 900_000 : 250_000;
      const combined = AbortSignal.any([waiting, AbortSignal.timeout(timeout)]);
      combined.throwIfAborted();
      try { return await service.call(method, args, combined); }
      catch (error) {
        if (combined.aborted) throw new Error('Memory call cancelled or timed out; an in-progress write may already have committed');
        if (error instanceof ModelAPIError) throw error;
        if (error && typeof error === 'object' && 'code' in error) throw new Error('Memory operation failed; no result confirmed');
        throw error;
      }
    })();
    this.pending.add(operation);
    try { return await operation; } finally { this.pending.delete(operation); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.lifecycle.abort();
    await this.starting?.catch(() => {});
    await Promise.allSettled([...this.pending]);
    await this.service?.close(); this.service = undefined;
  }
}
