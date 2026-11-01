export function uniqueSourceMatches(rows) {
    const seen = new Set();
    return rows.filter(row => { if (seen.has(row.text))
        return false; seen.add(row.text); return true; });
}
export function sourceMatchResult(id, total, rows, ranking, topK, minScore) {
    const selected = rows.filter(r => minScore === undefined || r.score >= minScore)
        .sort((a, b) => b.score - a.score || a.range[0] - b.range[0] || a.id.localeCompare(b.id)).slice(0, topK);
    const passages = [];
    for (const row of [...selected].sort((a, b) => a.range[0] - b.range[0])) {
        const last = passages.at(-1);
        if (last && row.range[0] <= last.range[1]) {
            const overlap = Math.min(last.range[1], row.range[1]) - row.range[0];
            // Fail rather than present inconsistent overlapping chunks as original source.
            const old = Array.from(last.text).slice(row.range[0] - last.range[0], row.range[0] - last.range[0] + overlap).join('');
            if (old !== Array.from(row.text).slice(0, overlap).join(''))
                throw new Error('Source chunks changed or overlap is inconsistent');
            if (row.range[1] > last.range[1])
                last.text += Array.from(row.text).slice(overlap).join('');
            last.range[1] = Math.max(last.range[1], row.range[1]);
            last.matches.push(row);
        }
        else
            passages.push({ range: [...row.range], text: row.text, matches: [row] });
    }
    return { kind: 'source_matches', id, total, ranking, candidates: rows.length, ...minScore === undefined ? {} : { minScore }, passages };
}
//# sourceMappingURL=source-search.js.map