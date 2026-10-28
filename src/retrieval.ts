import { createHash } from 'node:crypto';
import type { EvidenceEvent } from './evidence.js';

export const RETRIEVAL = Object.freeze({ candidates: 40, rrfK: 60, keywordBonus: .10, mmrLambda: .85 });
export interface SourceChunk { start: number; end: number; text: string; hash: string }
export function sourceChunks(content: string): SourceChunk[] {
  const points = Array.from(content), chunks: SourceChunk[] = [];
  for (let start = 0; start < points.length; start += 680) {
    const end = Math.min(points.length, start + 800), text = points.slice(start, end).join('');
    chunks.push({ start, end, text, hash: createHash('sha256').update(text).digest('hex') });
    if (end === points.length) break;
  }
  return chunks;
}
export function cosine(a: number[] = [], b: number[] = []): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export interface RankedEvent extends EvidenceEvent { vector?: number[]; sourceHashes?: string[]; score?: number }
function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (word.length > 2 && /\p{Script=Han}/u.test(word)) for (let i = 0; i < word.length - 1; i++) result.add(word.slice(i, i + 2));
    else result.add(word);
  }
  return result;
}
/** Fuse independently ranked summary/source routes, then diversify without a model call. */
export function rerankEvents(routes: RankedEvent[][], query: string, limit: number): RankedEvent[] {
  type Candidate = RankedEvent & { relevance: number; signature: string };
  const fused = new Map<string, Candidate>();
  const qt = terms(query);
  for (const route of routes) {
    const seen = new Set<string>();
    for (const e of route) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const c = fused.get(e.id) ?? { ...e, relevance: 0, signature: createHash('sha256').update(e.contentLength > Array.from(e.content).length ? e.id : e.content || e.id).digest('hex') };
      c.relevance += 1 / (RETRIEVAL.rrfK + seen.size);
      fused.set(e.id, c);
    }
  }
  for (const c of fused.values()) {
    const text = (c.summary + '\n' + c.content).normalize('NFKC').toLowerCase();
    const hits = [...qt].filter(t => text.includes(t)).length;
    c.relevance = c.relevance / (2 / (RETRIEVAL.rrfK + 1)) + RETRIEVAL.keywordBonus * (qt.size ? hits / qt.size : 0);
  }
  const selected: Candidate[] = [], signatures = new Set<string>();
  while (selected.length < limit) {
    let best: (typeof selected)[number] | undefined, bestScore = -Infinity;
    for (const c of fused.values()) {
      if (signatures.has(c.signature) || selected.includes(c)) continue;
      let redundancy = 0;
      for (const s of selected) {
        const a = c.sourceHashes ?? [], b = s.sourceHashes ?? [];
        const overlap = a.length && b.length ? a.filter(x => b.includes(x)).length / Math.min(a.length, b.length) : 0;
        redundancy = Math.max(redundancy, Math.max(0, cosine(c.vector, s.vector)), overlap);
      }
      const score = RETRIEVAL.mmrLambda * c.relevance - (1 - RETRIEVAL.mmrLambda) * redundancy;
      if (!best || score > bestScore || score === bestScore && c.id < best.id) { best = c; bestScore = score; }
    }
    if (!best) break;
    selected.push(best); signatures.add(best.signature);
  }
  return selected;
}
