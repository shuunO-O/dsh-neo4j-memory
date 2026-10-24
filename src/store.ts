import neo4j, { type Driver, type Transaction } from 'neo4j-driver';
import { ModelClient, labels, relations, type Extraction } from './api.js';
import { alignConcepts, type Candidate, type Decision, type EntityRecord } from './alignment.js';
import type { MemoryConfig } from './config.js';

export const indexes: Record<string, string> = { Event: 'event_embedding', Person: 'person_embedding', Concept: 'concept_embedding', Location: 'location_embedding' };
export class EmbeddingMismatch extends Error {}
export function localTimestamp(timezone: string): string {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}
export class Neo4jStore {
  driver: Driver;
  private indexPromise?: Promise<void>;
  private saveTail: Promise<unknown> = Promise.resolve();
  constructor(public config: MemoryConfig, driver?: Driver) {
    this.driver = driver ?? neo4j.driver(config.neo4jUri, neo4j.auth.basic(config.neo4jUser, config.neo4jPassword), {
      connectionTimeout: 15_000, connectionAcquisitionTimeout: 30_000, maxTransactionRetryTime: 0,
      disableLosslessIntegers: true,
    });
  }
  async close(): Promise<void> { await this.driver.close(); }
  async run(query: string, params: Record<string, any> = {}, signal?: AbortSignal): Promise<any[]> {
    signal?.throwIfAborted();
    const session = this.driver.session({ database: this.config.neo4jDatabase });
    const abort = () => { void session.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await session.run(query, params, { timeout: 60_000 });
      signal?.throwIfAborted();
      return result.records.map(r => r.toObject());
    } finally { signal?.removeEventListener('abort', abort); await session.close(); }
  }
  async ensureIndexes(signal?: AbortSignal): Promise<void> {
    if (!this.indexPromise) this.indexPromise = (async () => {
      // The sequence node is matched by id, so it must be unique even if two clients write at once.
      await this.run('CREATE CONSTRAINT memory_sequence_id IF NOT EXISTS FOR (c:MemorySequence) REQUIRE c.id IS UNIQUE', {}, signal);
      await this.assertEmbeddingReady(signal);
      await this.createVectorIndexes(this.config.dimensions, signal);
    })().catch(error => { this.indexPromise = undefined; throw error; });
    await this.indexPromise; signal?.throwIfAborted();
  }
  /** Drop the cached "indexes are ready" state after the embedding model or dimensions change. */
  resetIndexes(): void { this.indexPromise = undefined; }
  private async createVectorIndexes(dimensions: number, signal?: AbortSignal): Promise<void> {
    for (const [label, name] of Object.entries(indexes)) {
      await this.run(`CREATE VECTOR INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.embedding)
        OPTIONS {indexConfig: {\`vector.dimensions\`: $dimensions, \`vector.similarity_function\`: 'cosine'}}`, { dimensions: neo4j.int(dimensions) }, signal);
      await this.run('CALL db.awaitIndex($name, 30)', { name }, signal);
    }
  }
  private async readEmbeddingMeta(signal?: AbortSignal): Promise<{ model: string; dimensions: number } | null> {
    const rows = await this.run("MATCH (m:MemoryMeta {id:'embedding'}) RETURN m.model AS model, m.dimensions AS dimensions LIMIT 1", {}, signal);
    if (!rows.length) return null;
    const dimensions = Number(rows[0].dimensions);
    if (typeof rows[0].model !== 'string' || !rows[0].model || !Number.isInteger(dimensions)) throw new Error('Invalid embedding metadata in memory database');
    return { model: rows[0].model, dimensions };
  }
  private async writeEmbeddingMeta(model: string, dimensions: number, signal?: AbortSignal): Promise<void> {
    await this.run(`MERGE (m:MemoryMeta {id:'embedding'}) SET m.model=$model, m.dimensions=$dimensions, m.updated_at=$updated_at`, {
      model, dimensions: neo4j.int(dimensions), updated_at: localTimestamp(this.config.timezone),
    }, signal);
  }
  /** Group existing vectors by stored model/dimension, including nodes written before metadata existed. */
  private async embeddingStats(signal?: AbortSignal): Promise<{ dimensions: number | null; model: string | null; count: number }[]> {
    const rows = await this.run(`MATCH (n) WHERE any(l IN labels(n) WHERE l IN $labels)
      RETURN size(n.embedding) AS dimensions, n.embedding_model AS model, count(*) AS count`, { labels }, signal);
    return rows.map(row => ({
      dimensions: row.dimensions === null || row.dimensions === undefined ? null : Number(row.dimensions),
      model: typeof row.model === 'string' && row.model ? row.model : null,
      count: Number(row.count),
    }));
  }
  /**
   * Refuse to mix vectors from different models or dimensions: they are not comparable, and the
   * vector index has a fixed dimension. The one safe upgrade is a legacy database whose vectors
   * already match the current configuration; adopt it by recording the metadata once.
   */
  private async assertEmbeddingReady(signal?: AbortSignal): Promise<void> {
    const meta = await this.readEmbeddingMeta(signal);
    const configured = { model: this.config.embeddingModel, dimensions: this.config.dimensions };
    if (meta) {
      if (meta.model !== configured.model || meta.dimensions !== configured.dimensions) throw new EmbeddingMismatch(
        `Memory vectors were built with ${meta.model} (${meta.dimensions} dimensions), but the current configuration is ` +
        `${configured.model} (${configured.dimensions} dimensions). Re-vectorize existing memories in the Neo4j Memory settings before saving or searching.`,
      );
      const stats = await this.embeddingStats(signal);
      if (!stats.every(row => row.dimensions === meta.dimensions)) throw new EmbeddingMismatch(
        `Some stored vectors do not match the recorded ${meta.dimensions}-dimension embedding metadata; ` +
        're-vectorize existing memories in the Neo4j Memory settings before saving or searching.',
      );
      return;
    }
    const stats = await this.embeddingStats(signal);
    const total = stats.reduce((sum, row) => sum + row.count, 0);
    if (total === 0) { await this.writeEmbeddingMeta(configured.model, configured.dimensions, signal); return; }
    const dimensions = [...new Set(stats.map(row => row.dimensions).filter((value): value is number => value !== null))];
    const models = stats.map(row => row.model).filter((value): value is string => Boolean(value));
    if (dimensions.length === 1 && dimensions[0] === configured.dimensions && stats.every(row => row.dimensions === configured.dimensions) && models.every(model => model === configured.model)) {
      await this.writeEmbeddingMeta(configured.model, configured.dimensions, signal);
      return;
    }
    throw new EmbeddingMismatch(
      `Existing memories do not share one embedding configuration (found ${dimensions.length ? dimensions.join(', ') + ' dimensions' : 'missing vectors'}); ` +
      're-vectorize existing memories in the Neo4j Memory settings before saving or searching.',
    );
  }
  async embeddingStatus(): Promise<{
    nodes: number; dimensions: number | null; model: string | null; detected_dimensions: number[]; detected_models: string[];
    configured: { model: string; dimensions: number }; compatible: boolean; legacy: boolean;
  }> {
    const meta = await this.readEmbeddingMeta();
    const stats = await this.embeddingStats();
    const nodes = stats.reduce((sum, row) => sum + row.count, 0);
    const detected = [...new Set(stats.map(row => row.dimensions).filter((value): value is number => value !== null))].sort((a, b) => a - b);
    const models = [...new Set(stats.map(row => row.model).filter((value): value is string => Boolean(value)))];
    const configured = { model: this.config.embeddingModel, dimensions: this.config.dimensions };
    const compatible = meta
      ? meta.model === configured.model && meta.dimensions === configured.dimensions && stats.every(row => row.dimensions === meta.dimensions)
      : nodes === 0
        ? true
        : detected.length === 1 && detected[0] === configured.dimensions && stats.every(row => row.dimensions !== null) && models.every(model => model === configured.model);
    return { nodes, dimensions: meta?.dimensions ?? (detected.length === 1 ? detected[0] : null), model: meta?.model ?? null, detected_dimensions: detected, detected_models: models, configured, compatible, legacy: !meta && nodes > 0 };
  }
  /**
   * Re-embed every node with the current model and dimensions, then rebuild the vector indexes.
   * New vectors are staged in `embedding_next` first, so a failed embedding call leaves the old
   * index and old vectors untouched; only the final copy and index rebuild touch live data.
   */
  async reembed(client: ModelClient): Promise<{ nodes: number; model: string; dimensions: number }> {
    const signal = client.signal, cfg = this.config;
    const previous = await this.readEmbeddingMeta(signal);
    signal?.throwIfAborted();
    const rows = await this.run(`MATCH (n) WHERE any(l IN labels(n) WHERE l IN $labels)
      RETURN n.id AS id, labels(n) AS labels, n.summary AS summary, n.name AS name`, { labels }, signal);
    const texts = rows.map(row => {
      const value = Array.isArray(row.labels) && row.labels.includes('Event') ? row.summary : row.name;
      return String(value || row.name || row.id || '').trim() || String(row.id);
    });
    const vectors = texts.length ? await client.embed(texts) : [];
    if (vectors.length !== rows.length) throw new Error('Embedding response did not cover every memory node');
    signal?.throwIfAborted();
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200).map((row, offset) => ({ id: row.id, vector: vectors[start + offset] }));
      await this.run(`UNWIND $rows AS row MATCH (n {id: row.id})
        SET n.embedding_next=row.vector, n.embedding_next_model=$model, n.embedding_next_dim=$dimensions`,
        { rows: batch, model: cfg.embeddingModel, dimensions: neo4j.int(cfg.dimensions) }, signal);
    }
    for (const name of Object.values(indexes)) await this.run(`DROP INDEX ${name} IF EXISTS`, {}, signal);
    let swapped = false;
    try {
      // Copy the staged vectors and the new metadata in one transaction: readers never see
      // new vectors with old metadata, or the reverse.
      await this.run(`CALL {
          MATCH (n) WHERE n.embedding_next IS NOT NULL
          SET n.embedding=n.embedding_next, n.embedding_model=n.embedding_next_model, n.embedding_dim=n.embedding_next_dim
          REMOVE n.embedding_next, n.embedding_next_model, n.embedding_next_dim
          RETURN count(*) AS updated
        }
        MERGE (m:MemoryMeta {id:'embedding'})
        SET m.model=$model, m.dimensions=$dimensions, m.updated_at=$updated_at`, {
        model: cfg.embeddingModel, dimensions: neo4j.int(cfg.dimensions), updated_at: localTimestamp(this.config.timezone),
      }, signal);
      swapped = true;
    } catch (error) {
      // Only restore the old index when the live vectors were not replaced.
      if (!swapped && previous) { try { await this.createVectorIndexes(previous.dimensions); } catch { /* best effort */ } }
      throw error;
    }
    this.indexPromise = undefined;
    await this.ensureIndexes(signal);
    return { nodes: rows.length, model: cfg.embeddingModel, dimensions: cfg.dimensions };
  }
  /** Allocate the next per-label numeric ID, e.g. event_1, person_2. */
  async nextId(label: string): Promise<string> {
    const key = label.toLowerCase();
    if (!['event', 'person', 'concept', 'location'].includes(key)) throw new Error('Invalid memory node label');
    const rows = await this.run(`MERGE (c:MemorySequence {id:'primary'})
      ON CREATE SET c.event=0, c.person=0, c.concept=0, c.location=0
      SET c.${key} = c.${key} + 1
      RETURN c.${key} AS value`);
    const value = Number(rows[0]?.value);
    if (!Number.isInteger(value) || value < 1) throw new Error('Invalid memory sequence value');
    return `${key}_${value}`;
  }
  async save(content: string, sessionId: string, extraction: Extraction, client: ModelClient): Promise<{ event_id: string; decisions: Decision[] }> {
    const pending = this.saveTail.then(() => this.saveMemory(content, sessionId, extraction, client));
    this.saveTail = pending.catch(() => {});
    return pending;
  }
  private async saveMemory(content: string, sessionId: string, extraction: Extraction, client: ModelClient) {
    const signal = client.signal; signal?.throwIfAborted(); await this.ensureIndexes(signal);
    const summary = extraction.event.summary || [...content].slice(0, 100).join('');
    const records: EntityRecord[] = [], nameToLabel = new Map<string, string>();
    for (const [key, label] of [['persons', 'Person'], ['locations', 'Location'], ['concepts', 'Concept']] as const) {
      for (const name of new Set(extraction.entities[key].map(n => n.trim()))) {
        if (name === 'CURRENT_EVENT' || nameToLabel.has(name)) throw new Error('Entity names overlap labels or reserved name');
        nameToLabel.set(name, label); records.push({ name, label, id: '', embedding: [] });
      }
    }
    const eventId = await this.nextId('Event');
    for (const record of records) record.id = await this.nextId(record.label);
    const vectors = await client.embed([summary, ...records.map(r => r.name)]);
    records.forEach((r, i) => { r.embedding = vectors[i + 1]; });
    const concepts = records.filter(r => r.label === 'Concept');
    const decisions = this.config.conceptAlignment && concepts.length
      ? await alignConcepts(client, concepts, content, summary, (n, v, k, s) => this.recallConcepts(n, v, k, s)) : [];
    for (const rec of concepts) { rec.alignment = decisions.find(d => d.mention === rec.name); rec.first_context = summary.slice(0, 500); }
    const session = this.driver.session({ database: this.config.neo4jDatabase });
    let tx: Transaction | undefined;
    const abort = () => { if (tx) void tx.rollback().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      tx = session.beginTransaction({ timeout: 120_000 });
      await this.writeMemory(tx, records, eventId, extraction, summary, content, sessionId, vectors[0], decisions, nameToLabel, signal);
      signal?.throwIfAborted();
      await tx.commit(); // Never automatically replay a write with an uncertain commit outcome.
      return { event_id: eventId, decisions };
    } catch (error) { await tx?.rollback().catch(() => {}); throw error; }
    finally { signal?.removeEventListener('abort', abort); await session.close(); }
  }
  private async writeMemory(tx: Transaction, records: EntityRecord[], eventId: string, extraction: Extraction, summary: string, content: string, sessionId: string, vector: number[], decisions: Decision[], nameToLabel: Map<string, string>, signal?: AbortSignal) {
    const names = new Map<string, string>();
    for (const rec of records) {
      signal?.throwIfAborted();
      const alignment = rec.alignment;
      if (rec.label === 'Concept' && alignment) {
        if (alignment.action === 'reuse') {
          const result = await tx.run('MATCH (n:Concept {id: $id}) RETURN n.id AS id, n.name AS name', { id: alignment.target_id });
          if (result.records.length !== 1) throw new Error('Alignment target missing or duplicated; memory rolled back');
          if (rec.name !== result.records[0].get('name')) await tx.run(`MATCH (n:Concept {id: $id}) SET n.aliases = CASE WHEN $name IN coalesce(n.aliases, []) THEN n.aliases ELSE coalesce(n.aliases, []) + [$name] END`, { id: alignment.target_id, name: rec.name });
          names.set(rec.name, alignment.target_id);
        } else {
          await tx.run(`CREATE (n:Concept {id: $id, name: $name, embedding: $embedding, first_context: $context,
            embedding_model: $embedding_model, embedding_dim: $embedding_dim})`, {
            id: rec.id, name: rec.name, embedding: rec.embedding, context: rec.first_context,
            embedding_model: this.config.embeddingModel, embedding_dim: neo4j.int(this.config.dimensions),
          });
          names.set(rec.name, rec.id);
        }
      } else {
        if (rec.label === 'Concept') {
          const existing = await tx.run('MATCH (n:Concept) WHERE n.name=$name OR $name IN coalesce(n.aliases, []) RETURN n.id AS id', { name: rec.name });
          if (existing.records.length > 1 || (existing.records.length && !existing.records[0].get('id'))) throw new Error('Ambiguous Concept name or alias; memory rolled back');
          if (existing.records.length) { names.set(rec.name, existing.records[0].get('id')); continue; }
        }
        const result = await tx.run(`MERGE (n:${rec.label} {name: $name}) ON CREATE SET n.id=$id, n.embedding=$embedding,
          n.embedding_model=$embedding_model, n.embedding_dim=$embedding_dim RETURN n.id AS id`, {
          name: rec.name, id: rec.id, embedding: rec.embedding, embedding_model: this.config.embeddingModel, embedding_dim: neo4j.int(this.config.dimensions),
        });
        if (result.records.length !== 1 || !result.records[0].get('id')) throw new Error('Entity name ambiguous or missing ID; memory rolled back');
        names.set(rec.name, result.records[0].get('id'));
      }
    }
    await tx.run(`CREATE (e:Event {id:$id, type:$type, summary:$summary, content:$content, create_time:$create_time, raw_session:$raw_session, embedding:$embedding, concept_alignment:$alignment_json, embedding_model:$embedding_model, embedding_dim:$embedding_dim})`, {
      id: eventId, type: extraction.event.type, summary, content, create_time: localTimestamp(this.config.timezone), raw_session: sessionId, embedding: vector, alignment_json: decisions.length ? JSON.stringify(decisions) : null,
      embedding_model: this.config.embeddingModel, embedding_dim: neo4j.int(this.config.dimensions),
    });
    for (const rel of extraction.relationships) {
      signal?.throwIfAborted();
      const sourceLabel = rel.source === 'CURRENT_EVENT' ? 'Event' : nameToLabel.get(rel.source);
      const targetLabel = rel.target === 'CURRENT_EVENT' ? 'Event' : nameToLabel.get(rel.target);
      if (!sourceLabel || !targetLabel || !relations.includes(rel.type)) throw new Error('Invalid relationship; memory rolled back');
      const result = await tx.run(`MATCH (a:${sourceLabel} {id:$source_value}) MATCH (b:${targetLabel} {id:$target_value}) MERGE (a)-[r:${rel.type}]->(b) SET r += $props RETURN count(r) AS written`, {
        source_value: sourceLabel === 'Event' ? eventId : names.get(rel.source), target_value: targetLabel === 'Event' ? eventId : names.get(rel.target), props: rel.properties ?? {},
      });
      if (result.records.length !== 1 || Number(result.records[0].get('written')) !== 1) throw new Error('Relationship endpoint missing or duplicated; memory rolled back');
    }
  }
  async recallConcepts(name: string, vector: number[], limit: number, signal?: AbortSignal): Promise<Candidate[]> {
    const exact = await this.run('MATCH (n:Concept) WHERE n.name=$name OR $name IN coalesce(n.aliases, []) RETURN n.id AS id ORDER BY n.id LIMIT $limit', { name, limit: neo4j.int(limit + 1) }, signal);
    if (exact.length > limit || exact.some(r => !r.id)) throw new Error('ambiguous_or_invalid_exact_candidates');
    const similar = await this.run("CALL db.index.vector.queryNodes('concept_embedding', $top_k, $vector) YIELD node, score WHERE node:Concept RETURN node.id AS id ORDER BY score DESC", { top_k: neo4j.int(limit), vector }, signal);
    if (similar.some(r => !r.id)) throw new Error('candidate_missing_id');
    const ids = [...new Set([...exact, ...similar].map(r => r.id))];
    if (!ids.length) return [];
    const candidates = await this.run(`UNWIND $ids AS candidate_id MATCH (n:Concept {id:candidate_id})
      CALL { WITH n MATCH (e:Event)-[:MENTIONS]->(n) WITH e ORDER BY e.create_time DESC LIMIT 3 RETURN collect(left(e.summary,300)) AS events }
      RETURN n.id AS id, n.name AS name, coalesce(n.aliases,[])[..20] AS aliases, left(coalesce(n.first_context,''),500) AS first_context, events`, { ids }, signal);
    if (candidates.length !== ids.length || new Set(candidates.map(c => c.id)).size !== ids.length) throw new Error('candidate_changed_or_duplicate_id');
    return candidates;
  }
  async search(query: string | undefined, label: string, entity: string | undefined, date: string | undefined, client: ModelClient): Promise<any> {
    let vector: number[] | undefined;
    if (query) { await this.ensureIndexes(client.signal); vector = (await client.embed([query]))[0]; }
    let rows: any[];
    if (vector && !entity && !date) rows = await this.run(`CALL db.index.vector.queryNodes($index_name,$top_k,$queryVector) YIELD node,score WHERE $label IN labels(node)
      RETURN node.id AS id,node.name AS name,node.summary AS summary,node.content AS content,node.create_time AS timestamp,node.type AS type,score ORDER BY score DESC`, { index_name: indexes[label], top_k: neo4j.int(3), queryVector: vector, label }, client.signal);
    else {
      const parts = [`MATCH (n:${label})`], params: Record<string, any> = { top_k: neo4j.int(3) };
      if (entity) { parts.push('MATCH (n)-[]-(m) WHERE m.name=$entity OR $entity IN coalesce(m.aliases,[])'); params.entity = entity; }
      parts.push('WITH DISTINCT n');
      if (date && label === 'Event') { parts.push('WHERE n.create_time >= $start AND n.create_time <= $end'); params.start = `${date}T00:00:00`; params.end = `${date}T23:59:59`; }
      if (vector) { parts.push('WITH n,vector.similarity.cosine(n.embedding,$vector) AS score WHERE score IS NOT NULL'); params.vector = vector; }
      parts.push(`RETURN n.id AS id,n.name AS name,n.summary AS summary,n.content AS content,n.create_time AS timestamp,n.type AS type,${vector ? 'score' : '0.0 AS score'} ORDER BY ${vector ? 'score DESC' : label === 'Event' ? 'n.create_time DESC' : 'n.name'} LIMIT $top_k`);
      rows = await this.run(parts.join('\n'), params, client.signal);
    }
    if (!rows.length) return { primary_match: null, secondary_matches: [] };
    for (const row of rows) { row.label = label; row.confidence = row.score ?? 0; }
    const context: Record<string, any[]> = { persons: [], locations: [], concepts: [], attitudes: [] };
    const neighbors = await this.run('MATCH (n {id:$node_id})-[r]-(m) RETURN type(r) AS relation,labels(m) AS labels,m.name AS name,m.id AS id,properties(r) AS rel_props', { node_id: rows[0].id }, client.signal);
    for (const r of neighbors) {
      const item: Record<string, any> = { name: r.name, relation: r.relation };
      if (r.relation === 'HAS_ATTITUDE') { item.sentiment = r.rel_props?.sentiment ?? ''; context.attitudes.push(item); }
      else for (const [label, key] of [['Person', 'persons'], ['Location', 'locations'], ['Concept', 'concepts']]) if (r.labels?.includes(label)) { context[key].push(item); break; }
    }
    return { primary_match: { node: rows[0], context }, secondary_matches: rows.slice(1) };
  }
  async graph(selected: string[] = [], signal?: AbortSignal): Promise<any> {
    const pick = (ls: string[]) => labels.find(l => ls.includes(l)) ?? ls[0] ?? 'Node';
    const key = (label: string, name: string, id: string) => `${label}:${label === 'Event' || (label === 'Concept' && id) ? id : name}`;
    const rows = await this.run('MATCH (a) WHERE any(l IN labels(a) WHERE l IN $labels) RETURN labels(a) AS labels,a.id AS id,a.name AS name,a.type AS type,a.summary AS summary,a.content AS content,a.create_time AS create_time', { labels: selected.length ? selected : labels }, signal);
    const nodes = rows.map(({ labels: ls, id, ...r }) => ({ ...r, id: key(pick(ls), r.name, id), label: pick(ls) }));
    const valid = new Set(nodes.map(n => n.id));
    const edges = await this.run('MATCH (a)-[r]->(b) WHERE type(r) IN $types RETURN labels(a) AS a_labels,a.id AS a_id,a.name AS a_name,labels(b) AS b_labels,b.id AS b_id,b.name AS b_name,type(r) AS rel_type,properties(r) AS props', { types: relations }, signal);
    const relationships = edges.map(r => ({ source: key(pick(r.a_labels), r.a_name, r.a_id), target: key(pick(r.b_labels), r.b_name, r.b_id), type: r.rel_type, properties: r.props ?? {} })).filter(r => valid.has(r.source) && valid.has(r.target));
    return { nodes, relationships };
  }
}
