import { MemoryConfig, type HostConfig } from './config.js';
import { ModelClient, ModelAPIError, labels } from './api.js';
import { Neo4jStore, type EvidenceFilter } from './store.js';
import { LocalNeo4j } from './runtime.js';
import { randomBytes } from 'node:crypto';
import { buildEvidence, EVIDENCE_LIMITS, type EvidenceEvent, type EvidenceResult } from './evidence.js';

interface EvidenceCursor {
  expires: number; owner: string; query: string; vector?: number[]; model: string; dimensions: number;
  ids: string[]; concepts: string[]; filter: EvidenceFilter;
}

export class MemoryService {
  store: Neo4jStore;
  private reembedding = false;
  private evidenceSessions = new Map<string, { expires: number; ids: Set<string>; quotes: Map<string, { id: string; range: [number, number] }> }>();
  private searchTails = new Map<string, Promise<unknown>>();
  private evidenceCursors = new Map<string, EvidenceCursor>();
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
  async close() { this.evidenceCursors.clear(); this.evidenceSessions.clear(); try { await this.store.close(); } finally { await this.runtime?.stop(); } }
  private rememberEvidence(data: EvidenceResult, state: Omit<EvidenceCursor, 'expires' | 'concepts'>): EvidenceResult {
    for (const [key, value] of this.evidenceCursors) if (value.expires <= Date.now()) this.evidenceCursors.delete(key);
    while (this.evidenceCursors.size >= EVIDENCE_LIMITS.cursors) this.evidenceCursors.delete(this.evidenceCursors.keys().next().value!);
    const cursor = randomBytes(12).toString('base64url');
    this.evidenceCursors.set(cursor, { ...state, expires: Date.now() + EVIDENCE_LIMITS.cursorMs, concepts: data.next.concepts.map(c => c.id) });
    return { ...data, cursor };
  }
  private delivered(owner: string) {
    const state = this.evidenceSessions.get(owner);
    if (state && state.expires > Date.now()) return state;
    this.evidenceSessions.delete(owner);
    return { expires: 0, ids: new Set<string>(), quotes: new Map<string, { id: string; range: [number, number] }>() };
  }
  private confirmDelivery(data: EvidenceResult, owner: string, reset: boolean): EvidenceResult {
    const old = reset ? undefined : this.delivered(owner);
    const ids = new Set(old?.ids), quotes = new Map(old?.quotes);
    const events = data.events.map(row => {
      ids.add(row.id);
      if (!row.quote) return row;
      const prior = quotes.get(row.quote.text);
      if (prior) { const { quote, ...rest } = row; return { ...rest, quoteRef: prior }; }
      quotes.set(row.quote.text, { id: row.id, range: row.quote.range }); return row;
    });
    // Bound per-session history; expired/evicted IDs become eligible again.
    while (ids.size > 640) ids.delete(ids.values().next().value!);
    while (quotes.size > 640) quotes.delete(quotes.keys().next().value!);
    for (const [key, state] of this.evidenceSessions) if (state.expires <= Date.now()) this.evidenceSessions.delete(key);
    if (reset) for (const [key, state] of this.evidenceCursors) if (state.owner === owner) this.evidenceCursors.delete(key);
    this.evidenceSessions.delete(owner);
    while (this.evidenceSessions.size >= EVIDENCE_LIMITS.cursors) this.evidenceSessions.delete(this.evidenceSessions.keys().next().value!);
    this.evidenceSessions.set(owner, { expires: Date.now() + EVIDENCE_LIMITS.cursorMs, ids, quotes });
    return { ...data, events };
  }
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
    if (method !== 'memory_database_search' || !args || typeof args !== 'object') return this.dispatch(method, args, signal);
    const owner = typeof args.session_id === 'string' ? args.session_id.trim() || 'dsh' : 'dsh';
    const previous = this.searchTails.get(owner) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.dispatch(method, args, signal));
    this.searchTails.set(owner, pending);
    try { return await pending; } finally { if (this.searchTails.get(owner) === pending) this.searchTails.delete(owner); }
  }
  private async dispatch(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
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
      const operation = args.operation ?? 'search', owner = text('session_id', 200) || 'dsh';
      if (args.reset_seen !== undefined && (typeof args.reset_seen !== 'boolean' || operation !== 'search')) throw new Error('reset_seen is a boolean for search only');
      const reset = args.reset_seen === true, delivered = reset ? [] : [...this.delivered(owner).ids];
      if (typeof operation !== 'string' || !['search', 'read', 'expand', 'nearby'].includes(operation)) throw new Error('operation must be search, read, expand or nearby');
      const integer = (name: string, fallback: number, min: number, max: number) => {
        const value = args[name] ?? fallback;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
        return value;
      };
      if (operation !== 'search') {
        if (args.query_text || args.entity_filter || args.time_hint || args.target_label && args.target_label !== 'Event') throw new Error('Follow-up operations use the original search conditions; do not supply new search conditions');
        const eventId = text('event_id', 500).replace(/^Event:/u, '');
        if (operation === 'read') {
          if (!eventId) throw new Error('event_id is required');
          return { status: 'ok', data: await this.store.readEvidence(eventId, integer('start', 0, 0, Number.MAX_SAFE_INTEGER), integer('limit', 1600, 1, 10000), signal) };
        }
        const cursor = text('cursor', 200), state = this.evidenceCursors.get(cursor);
        if (!state || state.owner !== owner || state.expires <= Date.now()) { if (state?.expires && state.expires <= Date.now()) this.evidenceCursors.delete(cursor); throw new Error('Search cursor expired or unavailable; run the search again'); }
        if (state.vector && (state.model !== this.config.embeddingModel || state.dimensions !== this.config.dimensions)) throw new Error('Embedding settings changed; run the search again');
        const room = EVIDENCE_LIMITS.expandedEvents - state.ids.length;
        if (room <= 0) throw new Error('Evidence budget of 20 events reached; start another search');
        let additions: EvidenceEvent[];
        if (operation === 'expand') {
          const conceptId = text('concept_id', 500).replace(/^Concept:/u, '');
          if (!conceptId || !state.concepts.includes(conceptId)) throw new Error('Choose concept_id from the current search continuation entries');
          const limit = Math.min(room, EVIDENCE_LIMITS.events, integer('limit', 3, 1, 8));
          await this.store.evidenceExisting(state.ids, signal);
          additions = await this.store.expandEvidence(conceptId, state.ids, state.vector, state.filter, limit, signal, { query: state.query, exclude: delivered });
        } else {
          if (!state.ids.includes(eventId)) throw new Error('Choose event_id from the current evidence');
          const before = integer('before', 2, 0, 10), after = integer('after', 2, 0, 10);
          await this.store.evidenceExisting(state.ids, signal);
          additions = await this.store.nearbyEvidence(eventId, state.ids, state.filter, before, after, Math.min(room, EVIDENCE_LIMITS.events), signal, delivered);
        }
        const offered = additions.length;
        additions = additions.filter(e => !delivered.includes(e.id) && !state.ids.includes(e.id)).slice(0, Math.min(room, EVIDENCE_LIMITS.events));
        const ids = [...state.ids, ...additions.map(e => e.id)];
        if (new Set(ids).size !== ids.length) throw new Error('Memory Event IDs are ambiguous; no continuation confirmed');
        const { links, limited } = await this.store.evidenceLinks(ids, state.vector, signal);
        const warnings = limited ? ['每Event最多保留64个非叶子Concept；共享连接和入口可能有遗漏'] : [];
        if (offered > additions.length) warnings.push('仅按本次4条及追查剩余额度交付；未交付事件不进入游标');
        if (additions.some(e => e.contentLength > EVIDENCE_LIMITS.sourceWindow)) warnings.push('短摘录只在来源前32000字符内选择；其余内容可用read继续读取');
        additions = additions.map(e => ({ ...e, sourceKind: operation === 'expand' ? 'graph' as const : 'nearby' as const }));
        const data = buildEvidence(additions, links, ids, state.query, 'added', warnings);
        signal?.throwIfAborted();
        return { status: 'ok', data: this.rememberEvidence(this.confirmDelivery(data, owner, false), { ...state, ids }) };
      }
      if (args.cursor || args.event_id || args.concept_id) throw new Error('Use operation=read, expand or nearby for continuation arguments');
      const query = text('query_text', 4000) || undefined, entity = text('entity_filter', 500) || undefined, date = text('time_hint', 10) || undefined;
      const label = args.target_label ?? 'Event';
      if (typeof label !== 'string' || !['Event', 'Person', 'Concept'].includes(label)) throw new Error('target_label must be Event, Person or Concept');
      if (!query && !entity && !date) throw new Error('Provide query_text, entity_filter or time_hint');
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Invalid time_hint');
      if (label === 'Event') {
        let vector: number[] | undefined;
        if (query) { this.config.requireModelKeys(false, true); await this.store.ensureIndexes(signal); vector = (await client.embed([query]))[0]; }
        const filter = { entity, date }, candidates = await this.store.searchEvidence(vector, filter, signal, { query, exclude: delivered });
        const events = candidates.filter(e => !delivered.includes(e.id)).slice(0, EVIDENCE_LIMITS.events), ids = events.map(e => e.id);
        if (new Set(ids).size !== ids.length) throw new Error('Memory Event IDs are ambiguous; no result confirmed');
        const { links, limited } = await this.store.evidenceLinks(ids, vector, signal);
        const warnings = limited ? ['每Event最多保留64个非叶子Concept；共享连接和入口可能有遗漏'] : [];
        if (events.some(e => e.contentLength > EVIDENCE_LIMITS.sourceWindow)) warnings.push('短摘录只在来源前32000字符内选择；其余内容可用read继续读取');
        if (vector && events.some(e => 'sourceHashes' in e && Array.isArray(e.sourceHashes) && !e.sourceHashes.length && e.contentLength)) warnings.push('部分旧记忆尚无原文向量，当前使用摘要候选；可重新向量化补齐原文索引');
        if (candidates.length > events.length) warnings.push('每次最多交付4个新事件；未交付事件不进入游标');
        const data = buildEvidence(events, links, ids, query ?? '', 'initial', warnings);
        signal?.throwIfAborted();
        const confirmed = this.confirmDelivery(data, owner, reset);
        return { status: 'ok', data: ids.length ? this.rememberEvidence(confirmed, { owner, query: query ?? '', vector, filter, ids, model: this.config.embeddingModel, dimensions: this.config.dimensions }) : confirmed };
      }
      if (query) this.config.requireModelKeys(false, true);
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
