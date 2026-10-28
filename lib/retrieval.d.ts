import type { EvidenceEvent } from './evidence.js';
export declare const RETRIEVAL: Readonly<{
    candidates: 40;
    rrfK: 60;
    keywordBonus: 0.1;
    mmrLambda: 0.85;
}>;
export interface SourceChunk {
    start: number;
    end: number;
    text: string;
    hash: string;
}
export declare function sourceChunks(content: string): SourceChunk[];
export declare function cosine(a?: number[], b?: number[]): number;
export interface RankedEvent extends EvidenceEvent {
    vector?: number[];
    sourceHashes?: string[];
    score?: number;
}
/** Fuse independently ranked summary/source routes, then diversify without a model call. */
export declare function rerankEvents(routes: RankedEvent[][], query: string, limit: number): RankedEvent[];
