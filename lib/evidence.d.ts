/** Query evidence only: no model calls, inferred relations or database writes. */
export declare const EVIDENCE_LIMITS: Readonly<{
    events: 8;
    relatedEvents: 24;
    expandedEvents: 20;
    conceptsPerEvent: 64;
    branches: 6;
    excerpt: 120;
    quoteBudget: 1000;
    sourceWindow: 32000;
    cursors: 32;
    cursorMs: number;
}>;
/** The only fields allowed to cross from the store into the model-facing evidence. */
export declare const AGENT_EVENT_FIELDS: readonly ["id", "summary", "quote", "read", "via", "time", "chapter", "title", "session"];
export interface EvidenceEvent {
    id: string;
    summary: string;
    content: string;
    contentLength: number;
    matchedSource?: {
        range: [number, number];
        text: string;
    };
    occurrenceTime?: string | null;
    sourceKind?: 'graph' | 'nearby';
    chapter?: number;
    chapterTitle?: string;
    /** Source session ID, also usable as the search source_session scope. */
    session?: string | null;
}
export interface EvidenceLink {
    eventId: string;
    conceptId: string;
    name: string;
    degree: number;
    score: number;
}
export interface EvidenceRow {
    id: string;
    summary: string;
    quote?: {
        range: [number, number];
        text: string;
    };
    quoteRef?: {
        id: string;
        range: [number, number];
    };
    read?: {
        start: number;
        limit: number;
        total?: number;
    };
    source?: 'missing' | 'read';
    via?: 'graph' | 'nearby';
    time?: string;
    chapter?: number;
    title?: string;
    session?: string;
}
export interface EvidenceResult {
    kind: 'evidence';
    cursor?: string;
    scope: 'initial' | 'added';
    seen: number;
    events: EvidenceRow[];
    /** One-line index of further candidates: visible to the model without paying for full text. */
    related?: {
        id: string;
        summary: string;
        chapter?: number;
        session?: string;
    }[];
    shared: {
        concept: string;
        events: string[];
        degree: number;
    }[];
    next: {
        concepts: {
            id: string;
            name: string;
            from: string;
            remaining: number;
        }[];
        nearby: string[];
    };
    limited?: string[];
}
export interface SourceResult {
    kind: 'source';
    id: string;
    range: [number, number];
    text: string;
    total: number;
    next?: number;
}
/** Numeric shorthand is resolved only against events already delivered to this session. */
export declare function resolveEventReference(value: string, delivered: Iterable<string>): string;
/** All production ranges use Unicode code points, matching Neo4j substring/size. */
export declare function evidenceExcerpt(content: string, query: string, summary: string, budget: number, maxCharacters?: number): {
    range: [number, number];
    text: string;
} | undefined;
export interface DateRange {
    start: string;
    end: string;
}
/** Accepts YYYY, YYYY-MM, YYYY-MM-DD or an inclusive A..B range; trailing time is ignored. */
export declare function dateRange(value: string): DateRange | undefined;
/** Keep relevance order, but let at most `cap` rows share one session before filling the remainder. */
export declare function sessionDiverse(events: EvidenceEvent[], limit: number, cap: number): EvidenceEvent[];
export declare function sourcePosition(id: string): {
    prefix: string;
    record: number;
} | undefined;
export declare function buildEvidence(events: EvidenceEvent[], links: EvidenceLink[], allIds: string[], query: string, scope: EvidenceResult['scope'], limited?: string[], related?: EvidenceEvent[]): EvidenceResult;
export declare function renderMemoryEvidence(data: EvidenceResult | SourceResult | import('./source-search.js').SourceMatches): string;
