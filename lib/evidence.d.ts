/** Query evidence only: no model calls, inferred relations or database writes. */
export declare const EVIDENCE_LIMITS: Readonly<{
    events: 4;
    expandedEvents: 20;
    conceptsPerEvent: 64;
    branches: 6;
    excerpt: 120;
    quoteBudget: 1000;
    sourceWindow: 32000;
    cursors: 32;
    cursorMs: number;
}>;
export interface EvidenceEvent {
    id: string;
    summary: string;
    content: string;
    contentLength: number;
    occurrenceTime?: string | null;
    sourceKind?: 'graph' | 'nearby';
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
    source?: 'missing' | 'read';
    via?: 'graph' | 'nearby';
    time?: string;
}
export interface EvidenceResult {
    kind: 'evidence';
    cursor?: string;
    scope: 'initial' | 'added';
    seen: number;
    events: EvidenceRow[];
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
/** All production ranges use Unicode code points, matching Neo4j substring/size. */
export declare function evidenceExcerpt(content: string, query: string, summary: string, budget: number): {
    range: [number, number];
    text: string;
} | undefined;
export declare function sourcePosition(id: string): {
    prefix: string;
    record: number;
} | undefined;
export declare function buildEvidence(events: EvidenceEvent[], links: EvidenceLink[], allIds: string[], query: string, scope: EvidenceResult['scope'], limited?: string[]): EvidenceResult;
export declare function renderMemoryEvidence(data: EvidenceResult | SourceResult): string;
