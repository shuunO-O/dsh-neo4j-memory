/** Query evidence only: no model calls, inferred relations or database writes. */
export const EVIDENCE_LIMITS = Object.freeze({ events: 8, relatedEvents: 24, expandedEvents: 20, conceptsPerEvent: 64, branches: 6, excerpt: 120, quoteBudget: 1000, sourceWindow: 32000, cursors: 32, cursorMs: 15 * 60_000 });
/** The only fields allowed to cross from the store into the model-facing evidence. */
export const AGENT_EVENT_FIELDS = Object.freeze(['id', 'summary', 'quote', 'read', 'via', 'time', 'chapter', 'title', 'session']);
const canonical = (s) => s.normalize('NFKC').toLowerCase();
/** Numeric shorthand is resolved only against events already delivered to this session. */
export function resolveEventReference(value, delivered) {
    const id = value.replace(/^Event:/u, '');
    if (!/^\d+$/u.test(id))
        return id;
    const known = new Set(delivered), candidate = `event_${id}`;
    if (known.has(id))
        return id;
    if (known.has(candidate))
        return candidate;
    throw new Error('Use the complete event_id returned in this session (for example event_123); numeric shorthand must match a delivered event');
}
function terms(text) {
    const result = new Set();
    for (const word of canonical(text).match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []) {
        if (/^[a-z]/.test(word) || word.length <= 2)
            result.add(word);
        else
            for (let i = 0; i < word.length - 1; i++)
                result.add(word.slice(i, i + 2));
    }
    return [...result].filter(t => t.length >= 2);
}
/** All production ranges use Unicode code points, matching Neo4j substring/size. */
export function evidenceExcerpt(content, query, summary, budget, maxCharacters = EVIDENCE_LIMITS.excerpt) {
    if (!content || budget < 1)
        return;
    const points = Array.from(content), size = Math.min(maxCharacters, budget, points.length);
    const qTerms = terms(query), sTerms = terms(summary), starts = new Set([0, Math.max(0, points.length - size)]);
    for (const term of new Set([...qTerms, ...sTerms])) {
        // Find positions in the original text. Normalization is used for scoring only.
        let count = 0;
        for (const match of content.matchAll(new RegExp(term, 'giu'))) {
            if (count++ >= 3)
                break;
            const center = Array.from(content.slice(0, match.index)).length;
            starts.add(Math.max(0, Math.min(points.length - size, center - Math.floor(size * .35))));
        }
    }
    let best;
    for (const start of starts) {
        const text = points.slice(start, start + size).join(''), normalized = canonical(text);
        const score = qTerms.reduce((s, t) => s + Number(normalized.includes(t)), 0) + sTerms.reduce((s, t) => s + .5 * Number(normalized.includes(t)), 0);
        if (!best || score > best.score || score === best.score && start < best.start)
            best = { start, text, score };
    }
    return best && { range: [best.start, best.start + size], text: best.text };
}
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function dayRange(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day)
        return;
    return { start: iso(d), end: iso(new Date(Date.UTC(year, month - 1, day + 1))) };
}
/** Accepts YYYY, YYYY-MM, YYYY-MM-DD or an inclusive A..B range; trailing time is ignored. */
export function dateRange(value) {
    const point = (text) => {
        const v = text.trim();
        let m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(v);
        if (m)
            return dayRange(Number(m[1]), Number(m[2]), Number(m[3]));
        m = /^(\d{4})-(\d{2})/u.exec(v);
        if (m) {
            const year = Number(m[1]), month = Number(m[2]);
            const first = dayRange(year, month, 1), next = month === 12 ? dayRange(year + 1, 1, 1) : dayRange(year, month + 1, 1);
            return first && next ? { start: first.start, end: next.start } : undefined;
        }
        m = /^(\d{4})/u.exec(v);
        return m ? { start: `${m[1]}-01-01`, end: `${Number(m[1]) + 1}-01-01` } : undefined;
    };
    const parts = value.trim().split(/\.\./u);
    if (!value.trim() || parts.length > 2)
        return;
    if (parts.length === 1)
        return point(parts[0]);
    const start = point(parts[0]), end = point(parts[1]);
    return start && end && start.start <= end.start ? { start: start.start, end: end.end } : undefined;
}
/** Keep relevance order, but let at most `cap` rows share one session before filling the remainder. */
export function sessionDiverse(events, limit, cap) {
    if (!cap || cap < 1 || limit < 1)
        return events.slice(0, Math.max(0, limit));
    const counts = new Map(), picked = new Set(), out = [];
    for (const e of events) {
        if (out.length >= limit)
            break;
        const key = e.session || `~${e.id}`, used = counts.get(key) ?? 0;
        if (used >= cap)
            continue;
        counts.set(key, used + 1);
        picked.add(e.id);
        out.push(e);
    }
    for (const e of events) {
        if (out.length >= limit)
            break;
        if (!picked.has(e.id)) {
            picked.add(e.id);
            out.push(e);
        }
    }
    return out;
}
export function sourcePosition(id) {
    const match = id.match(/^(.*_ch\d+_e)(\d+)$/u);
    return match ? { prefix: match[1], record: Number(match[2]) } : undefined;
}
/** Compact provenance: chapter is stable, title is shown only on full rows. */
function provenance(e) {
    const chapter = Number.isInteger(e.chapter) && e.chapter > 0 ? e.chapter : undefined;
    const title = chapter && typeof e.chapterTitle === 'string' && e.chapterTitle.trim() ? e.chapterTitle.trim() : undefined;
    const session = typeof e.session === 'string' && e.session.trim() ? e.session : undefined;
    return { ...(chapter ? { chapter } : {}), ...(title ? { title } : {}), ...(session ? { session } : {}) };
}
export function buildEvidence(events, links, allIds, query, scope, limited = [], related = []) {
    const seen = new Set(allIds), added = new Set(events.map(e => e.id));
    let budget = EVIDENCE_LIMITS.quoteBudget;
    const rows = events.map((e, index) => {
        const match = e.matchedSource;
        const validMatch = match && Array.isArray(match.range) && typeof match.text === 'string' && Number.isInteger(match.range[0]) && Number.isInteger(match.range[1]) && match.range[0] >= 0
            && match.range[1] <= e.contentLength && match.range[1] - match.range[0] === Array.from(match.text).length
            && (match.range[1] > Array.from(e.content).length || Array.from(e.content).slice(...match.range).join('') === match.text);
        // Keep the existing total quote budget; share it across the remaining events.
        const allowance = Math.floor(budget / Math.max(1, events.length - index));
        const local = validMatch ? evidenceExcerpt(match.text, query, '', allowance, allowance) : undefined;
        const quote = local && match ? { range: [local.range[0] + match.range[0], local.range[1] + match.range[0]], text: local.text }
            : evidenceExcerpt(e.content, query, e.summary, budget);
        if (quote)
            budget -= Array.from(quote.text).length;
        // One number is enough: how much source exists. start defaults to 0, so
        // `read event_id=<id> limit=<total>` returns the whole event in one call.
        const read = e.contentLength ? { start: 0, limit: Math.min(10_000, e.contentLength), total: e.contentLength } : undefined;
        return { id: e.id, summary: e.summary, ...provenance(e), ...(quote ? { quote } : { source: e.contentLength ? 'read' : 'missing' }), ...(read ? { read } : {}), ...(e.sourceKind ? { via: e.sourceKind } : {}), ...(e.occurrenceTime ? { time: e.occurrenceTime } : {}) };
    });
    const grouped = new Map();
    for (const link of links) {
        if (!seen.has(link.eventId) || link.degree <= 1)
            continue;
        let group = grouped.get(link.conceptId);
        if (!group) {
            group = { name: link.name, degree: link.degree, score: link.score, events: new Set() };
            grouped.set(link.conceptId, group);
        }
        group.events.add(link.eventId);
    }
    const shared = [...grouped.values()].filter(g => g.events.size > 1 && [...g.events].some(id => added.has(id))).map(g => ({ concept: g.name, events: [...g.events], degree: g.degree }));
    const concepts = [...grouped].filter(([, g]) => g.degree > g.events.size).map(([id, g]) => ({ id, name: g.name, from: [...g.events][0], remaining: g.degree - g.events.size, priority: .6 * Math.max(0, g.score) + .4 / Math.log2(2 + g.degree) }))
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, EVIDENCE_LIMITS.branches).map(({ priority, ...c }) => c);
    const ordered = new Set(events.filter(e => e.session || sourcePosition(e.id)).map(e => e.id));
    return { kind: 'evidence', scope, seen: allIds.length, events: rows, related: related.map(e => {
            const { chapter, session } = provenance(e);
            return { id: e.id, summary: e.summary, ...(chapter ? { chapter } : {}), ...(session ? { session } : {}) };
        }), shared, next: { concepts, nearby: allIds.filter(id => ordered.has(id) || sourcePosition(id)) }, ...(limited.length ? { limited } : {}) };
}
export function renderMemoryEvidence(data) {
    if (data.kind === 'source_matches')
        return `${data.id} 原文共${data.total}字符；事件内检索，${data.ranking}相关性分数不代表置信概率。候选${data.candidates}块。\n` +
            (data.passages.length ? data.passages.map(p => `原文[${p.range.join(':')}): ${JSON.stringify(p.text)}\n命中分数：${p.matches.map(m => `${m.range.join(':')}=${m.score.toFixed(4)}`).join(', ')}\n继续定位：operation=read event_id=${data.id} query_text=<具体问题>；范围阅读：operation=read event_id=${data.id} start=${p.range[0]} limit=${p.range[1] - p.range[0]}`).join('\n') : '未找到满足条件的相关片段。') + '\n只交付相关片段，不代表全文完整覆盖；可换问题检索同一事件或按位置补读。';
    if (data.kind === 'source')
        return `${data.id} 原文[${data.range.join(':')}]: ${JSON.stringify(data.text)}${data.total === 0 ? '（缺原文）' : ''}\n原文共${data.total}字符；本次仅交付[${data.range.join(':')})。${data.next === undefined ? '' : `尚有后续原文，不能把本段未提及当作全文不存在。\n续读：operation=read event_id=${data.id} start=${data.next} limit=1600`}`;
    const lines = ['摘要待核；原文范围[起点:终点)按Unicode字符计。共享概念及来源邻近不代表因果或发生顺序。', `${data.scope === 'added' ? '本次新增' : '事件'}${data.events.length}条，累计${data.seen}条。`];
    const quoteRefs = new Map();
    for (const e of data.events) {
        lines.push(`${e.id}${e.chapter ? ` [第${e.chapter}章${e.title ? ` ${e.title}` : ''}]` : ''}${e.session ? ` session=${JSON.stringify(e.session)}` : ''}${e.via ? ` [${e.via === 'graph' ? '沿图补充' : '来源补读'}]` : ''}${e.time ? ` 时间=${e.time}` : ''} | ${e.summary}`);
        if (e.quoteRef)
            lines.push(`原文同 ${e.quoteRef.id} 原文[${e.quoteRef.range.join(':')}]（此前已交付）`);
        else if (e.quote) {
            const prior = quoteRefs.get(e.quote.text);
            lines.push(`原文[${e.quote.range.join(':')}]: ${prior ? `同${prior}的摘录` : JSON.stringify(e.quote.text)}`);
            if (!prior)
                quoteRefs.set(e.quote.text, e.id);
        }
        else if (e.source === 'missing')
            lines.push('缺原文');
        if (e.read)
            lines.push(`read event_id=${e.id} limit=${e.read.limit}${e.read.total && e.read.total > e.read.limit ? `（共${e.read.total}字符，可分段）` : ''}`);
    }
    if (data.related?.length) {
        lines.push(`其它候选（未展开全文，${data.related.length}条；operation=read event_id=<id> 可读取）：`);
        for (const e of data.related)
            lines.push(`${e.id}${e.chapter ? ` [第${e.chapter}章]` : ''}${e.session ? ` session=${JSON.stringify(e.session)}` : ''} | ${[...e.summary].slice(0, 100).join('')}`);
    }
    if (data.shared.length)
        lines.push('共享概念：', ...data.shared.map(g => `${g.concept}（全库${g.degree}条）：${g.events.join(',')}`));
    if (data.cursor) {
        lines.push(`追查 cursor=${data.cursor}（15分钟内有效；重启后需重新检索）`, 'operation=read event_id=<id>；operation=expand concept_id=<id>；operation=nearby event_id=<id>。');
        lines.push(...data.next.concepts.map(c => `${c.id} | ${c.from}→${c.name} | 全库未展示${c.remaining}条`));
        if (data.next.nearby.length)
            lines.push(`可补读相邻记录（同章或同会话）：${data.next.nearby.join(',')}`);
    }
    if (data.limited?.length)
        lines.push(`范围限制：${data.limited.join('；')}`);
    return lines.join('\n');
}
//# sourceMappingURL=evidence.js.map