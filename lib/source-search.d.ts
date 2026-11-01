/** Source matches retain exact Unicode offsets; scores are relevance, not probabilities. */
export interface SourceMatch {
    id: string;
    range: [number, number];
    text: string;
    vectorScore: number;
    score: number;
}
export interface SourceMatches {
    kind: 'source_matches';
    id: string;
    total: number;
    ranking: 'vector' | 'rerank';
    candidates: number;
    minScore?: number;
    passages: {
        range: [number, number];
        text: string;
        matches: SourceMatch[];
    }[];
}
export declare function uniqueSourceMatches(rows: SourceMatch[]): SourceMatch[];
export declare function sourceMatchResult(id: string, total: number, rows: SourceMatch[], ranking: SourceMatches['ranking'], topK: number, minScore?: number): SourceMatches;
