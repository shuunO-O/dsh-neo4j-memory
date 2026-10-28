/** Query evidence only: no model calls, inferred relations or database writes. */
export const EVIDENCE_LIMITS = Object.freeze({ events: 4, expandedEvents: 20, conceptsPerEvent: 64, branches: 6, excerpt: 120, quoteBudget: 1000, sourceWindow: 32000, cursors: 32, cursorMs: 15 * 60_000 });
export interface EvidenceEvent {
  id: string; summary: string; content: string; contentLength: number;
  occurrenceTime?: string | null; sourceKind?: 'graph' | 'nearby';
}
export interface EvidenceLink { eventId: string; conceptId: string; name: string; degree: number; score: number }
export interface EvidenceRow { id: string; summary: string; quote?: { range: [number, number]; text: string }; quoteRef?: { id: string; range: [number, number] }; source?: 'missing' | 'read'; via?: 'graph' | 'nearby'; time?: string }
export interface EvidenceResult {
  kind: 'evidence'; cursor?: string; scope: 'initial' | 'added'; seen: number;
  events: EvidenceRow[];
  shared: { concept: string; events: string[]; degree: number }[];
  next: { concepts: { id: string; name: string; from: string; remaining: number }[]; nearby: string[] };
  limited?: string[];
}
export interface SourceResult { kind: 'source'; id: string; range: [number, number]; text: string; total: number; next?: number }
const canonical = (s: string) => s.normalize('NFKC').toLowerCase();
function terms(text: string): string[] {
  const result = new Set<string>();
  for (const word of canonical(text).match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []) {
    if (/^[a-z]/.test(word) || word.length <= 2) result.add(word);
    else for (let i = 0; i < word.length - 1; i++) result.add(word.slice(i, i + 2));
  }
  return [...result].filter(t => t.length >= 2);
}
/** All production ranges use Unicode code points, matching Neo4j substring/size. */
export function evidenceExcerpt(content: string, query: string, summary: string, budget: number): { range: [number, number]; text: string } | undefined {
  if (!content || budget < 1) return;
  const points = Array.from(content), size = Math.min(EVIDENCE_LIMITS.excerpt, budget, points.length);
  const qTerms = terms(query), sTerms = terms(summary), starts = new Set([0, Math.max(0, points.length - size)]);
  for (const term of new Set([...qTerms, ...sTerms])) {
    // Find positions in the original text. Normalization is used for scoring only.
    let count = 0;
    for (const match of content.matchAll(new RegExp(term, 'giu'))) {
      if (count++ >= 3) break;
      const center = Array.from(content.slice(0, match.index)).length;
      starts.add(Math.max(0, Math.min(points.length - size, center - Math.floor(size * .35))));
    }
  }
  let best: { start: number; text: string; score: number } | undefined;
  for (const start of starts) {
    const text = points.slice(start, start + size).join(''), normalized = canonical(text);
    const score = qTerms.reduce((s, t) => s + Number(normalized.includes(t)), 0) + sTerms.reduce((s, t) => s + .5 * Number(normalized.includes(t)), 0);
    if (!best || score > best.score || score === best.score && start < best.start) best = { start, text, score };
  }
  return best && { range: [best.start, best.start + size], text: best.text };
}
export function sourcePosition(id: string): { prefix: string; record: number } | undefined {
  const match = id.match(/^(.*_ch\d+_e)(\d+)$/u);
  return match ? { prefix: match[1], record: Number(match[2]) } : undefined;
}
export function buildEvidence(events: EvidenceEvent[], links: EvidenceLink[], allIds: string[], query: string, scope: EvidenceResult['scope'], limited: string[] = []): EvidenceResult {
  const seen = new Set(allIds), added = new Set(events.map(e => e.id)); let budget: number = EVIDENCE_LIMITS.quoteBudget;
  const rows: EvidenceRow[] = events.map(e => {
    const quote = evidenceExcerpt(e.content, query, e.summary, budget);
    if (quote) budget -= Array.from(quote.text).length;
    return { id: e.id, summary: e.summary, ...(quote ? { quote } : { source: e.contentLength ? 'read' as const : 'missing' as const }), ...(e.sourceKind ? { via: e.sourceKind } : {}), ...(e.occurrenceTime ? { time: e.occurrenceTime } : {}) };
  });
  const grouped = new Map<string, { name: string; degree: number; score: number; events: Set<string> }>();
  for (const link of links) {
    if (!seen.has(link.eventId) || link.degree <= 1) continue;
    let group = grouped.get(link.conceptId);
    if (!group) { group = { name: link.name, degree: link.degree, score: link.score, events: new Set() }; grouped.set(link.conceptId, group); }
    group.events.add(link.eventId);
  }
  const shared = [...grouped.values()].filter(g => g.events.size > 1 && [...g.events].some(id => added.has(id))).map(g => ({ concept: g.name, events: [...g.events], degree: g.degree }));
  const concepts = [...grouped].filter(([, g]) => g.degree > g.events.size).map(([id, g]) => ({ id, name: g.name, from: [...g.events][0], remaining: g.degree - g.events.size, priority: .6 * Math.max(0, g.score) + .4 / Math.log2(2 + g.degree) }))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, EVIDENCE_LIMITS.branches).map(({ priority, ...c }) => c);
  return { kind: 'evidence', scope, seen: allIds.length, events: rows, shared, next: { concepts, nearby: allIds.filter(id => sourcePosition(id)) }, ...(limited.length ? { limited } : {}) };
}
export function renderMemoryEvidence(data: EvidenceResult | SourceResult): string {
  if (data.kind === 'source') return `${data.id} 原文[${data.range.join(':')}]: ${JSON.stringify(data.text)}${data.total === 0 ? '（缺原文）' : ''}${data.next === undefined ? '' : `\n续读：operation=read event_id=${data.id} start=${data.next}`}`;
  const lines = ['摘要待核；原文范围[起点:终点)按Unicode字符计。共享概念及来源邻近不代表因果或发生顺序。', `${data.scope === 'added' ? '本次新增' : '事件'}${data.events.length}条，累计${data.seen}条。`];
  const quoteRefs = new Map<string, string>();
  for (const e of data.events) {
    lines.push(`${e.id}${e.via ? ` [${e.via === 'graph' ? '沿图补充' : '来源补读'}]` : ''}${e.time ? ` 时间=${e.time}` : ''} | ${e.summary}`);
    if (e.quoteRef) lines.push(`原文同 ${e.quoteRef.id} 原文[${e.quoteRef.range.join(':')}]（此前已交付）`);
    else if (e.quote) {
      const prior = quoteRefs.get(e.quote.text);
      lines.push(`原文[${e.quote.range.join(':')}]: ${prior ? `同${prior}的摘录` : JSON.stringify(e.quote.text)}`);
      if (!prior) quoteRefs.set(e.quote.text, e.id);
    } else lines.push(e.source === 'missing' ? '缺原文' : '原文按需读');
  }
  if (data.shared.length) lines.push('共享概念：', ...data.shared.map(g => `${g.concept}（全库${g.degree}条）：${g.events.join(',')}`));
  if (data.cursor) {
    lines.push(`追查 cursor=${data.cursor}（15分钟内有效；重启后需重新检索）`, 'operation=read event_id=<id>；operation=expand concept_id=<id>；operation=nearby event_id=<id>。');
    lines.push(...data.next.concepts.map(c => `${c.id} | ${c.from}→${c.name} | 全库未展示${c.remaining}条`));
    if (data.next.nearby.length) lines.push(`可补读同章编号附近：${data.next.nearby.join(',')}`);
  }
  if (data.limited?.length) lines.push(`范围限制：${data.limited.join('；')}`);
  return lines.join('\n');
}
