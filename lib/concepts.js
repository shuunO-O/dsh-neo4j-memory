/** Only known case-insensitive names may be physically reused across casing changes. */
const caseInsensitive = new Set(['neo4j', 'typescript', 'javascript', 'postgresql', 'mysql', 'docker']);
export const isKnownConceptSpelling = (name) => caseInsensitive.has(conceptNameKey(name));
export function conceptNameKey(name) {
    const spelling = name.replace(/[\uFF01-\uFF5E]/gu, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/gu, ' ').trim().normalize('NFC');
    const lower = spelling.toLowerCase();
    return caseInsensitive.has(lower) ? lower : spelling;
}
/** Recall may hit several spellings; compare their whole group only once. */
export function conceptGroups(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
        const key = candidate.group_id ?? candidate.id;
        const previous = groups.get(key);
        const members = [...new Map([...(previous?.members ?? []), ...(candidate.members ?? [candidate])].map(m => [m.id, m])).values()];
        const first = members[0];
        groups.set(key, { ...first, group_id: key, members,
            aliases: [...new Set(members.flatMap(m => [m.name, ...(m.aliases ?? [])]))],
            events: [...new Set(members.flatMap(m => m.events ?? []))] });
    }
    return [...groups.values()];
}
//# sourceMappingURL=concepts.js.map