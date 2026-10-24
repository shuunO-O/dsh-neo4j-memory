import { readFileSync } from 'node:fs';
import type { MemoryConfig } from './config.js';

export class ModelAPIError extends Error {}
export interface Relationship { source: string; target: string; type: string; properties?: { sentiment?: string } }
export interface Extraction {
  event: { type: string; summary: string };
  entities: { persons: string[]; locations: string[]; concepts: string[] };
  relationships: Relationship[];
}
export const relations = ['PARTICIPATED_IN', 'OCCURRED_AT', 'MENTIONS', 'HAS_ATTITUDE'];
export const labels = ['Event', 'Person', 'Concept', 'Location'];
export function validateExtraction(value: unknown): asserts value is Extraction {
  const v = value as Extraction;
  if (!v || typeof v !== 'object' || !v.event || !v.entities || !Array.isArray(v.relationships)) throw new Error('Invalid extraction fields');
  if (!['milestone', 'interaction', 'travel', 'study'].includes(v.event.type) || typeof v.event.summary !== 'string' || !v.event.summary.trim() || v.relationships.length > 300) throw new Error('Invalid extracted event');
  const names = new Set(['CURRENT_EVENT']);
  for (const key of ['persons', 'locations', 'concepts'] as const) {
    const values = v.entities[key];
    if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid extracted entities');
    for (const name of values) {
      if (typeof name !== 'string' || !name.trim() || [...name].length > 500) throw new Error('Invalid extracted entity name');
      names.add(name.trim());
    }
  }
  for (const r of v.relationships) {
    if (!r || !relations.includes(r.type) || !names.has(r.source) || !names.has(r.target)) throw new Error('Invalid extracted relationship');
    const props = r.properties ?? {};
    if (typeof props !== 'object' || Array.isArray(props) || Object.keys(props).some(k => k !== 'sentiment')) throw new Error('Invalid relationship properties');
    if (('sentiment' in props && !['喜欢', '讨厌', '中立', '不明确'].includes(props.sentiment!)) || (r.type === 'HAS_ATTITUDE' && !('sentiment' in props))) throw new Error('Invalid relationship sentiment');
  }
}
export class ModelClient {
  constructor(public config: MemoryConfig, public signal?: AbortSignal) {}
  async post(base: string, path: string, key: string, body: unknown, timeout = 60_000): Promise<any> {
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(this.signal ? [this.signal] : [])]);
    try {
      const response = await fetch(base.replace(/\/+$/, '') + path, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (response.status !== 200) { await response.body?.cancel(); throw new ModelAPIError(`Model API returned HTTP ${response.status}`); }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16_000_000) throw new ModelAPIError('Model API response exceeded its size limit'); chunks.push(value); }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      this.signal?.throwIfAborted();
      if (error instanceof ModelAPIError) throw error;
      throw new ModelAPIError('Model API request failed');
    }
  }
  async embed(texts: string[]): Promise<number[][]> {
    const unique = [...new Set(texts.map(t => t.trim()))], vectors = new Map<string, number[]>(), cfg = this.config;
    for (let start = 0; start < unique.length; start += 20) {
      const batch = unique.slice(start, start + 20);
      const data = await this.post(cfg.embeddingUrl, '/embeddings', cfg.embeddingApiKey, { model: cfg.embeddingModel, input: batch, dimensions: cfg.dimensions });
      if (!Array.isArray(data?.data) || data.data.length !== batch.length) throw new ModelAPIError('Invalid embedding response count');
      const indexed = new Set<number>();
      for (const row of data.data) {
        if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= batch.length || indexed.has(row.index) || !Array.isArray(row.embedding) || row.embedding.length !== cfg.dimensions || row.embedding.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) throw new ModelAPIError('Invalid embedding response shape');
        indexed.add(row.index); vectors.set(batch[row.index], row.embedding);
      }
    }
    return texts.map(t => vectors.get(t.trim())!);
  }
  async extract(content: string): Promise<Extraction> {
    const cfg = this.config;
    const data = await this.post(cfg.extractionUrl, '/chat/completions', cfg.apiKey, {
      model: cfg.extractionModel, messages: [
        { role: 'system', content: readFileSync(new URL('../assets/extraction_prompt.md', import.meta.url), 'utf8') },
        { role: 'user', content: JSON.stringify({ content }) },
      ], response_format: { type: 'json_object' }, stream: false,
    });
    try {
      const raw = data.choices[0].message.content.trim().replace(/^```[^\n]*\n([\s\S]*?)```$/, '$1').trim();
      const result: unknown = JSON.parse(raw); validateExtraction(result); return result;
    } catch { throw new ModelAPIError('Memory extraction did not return valid event/entities/relationships JSON'); }
  }
}
