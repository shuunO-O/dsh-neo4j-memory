import type { MemoryConfig } from './config.js';
import type { SourceMatch } from './source-search.js';
export declare class ModelAPIError extends Error {
}
export interface Relationship {
    source: string;
    target: string;
    type: string;
    properties?: {
        sentiment?: string;
    };
}
export interface Extraction {
    event: {
        type: string;
        summary: string;
    };
    entities: {
        persons: string[];
        locations: string[];
        concepts: string[];
    };
    relationships: Relationship[];
}
export declare const relations: string[];
export declare const labels: string[];
export declare function validateExtraction(value: unknown): asserts value is Extraction;
export declare class ModelClient {
    config: MemoryConfig;
    signal?: AbortSignal | undefined;
    constructor(config: MemoryConfig, signal?: AbortSignal | undefined);
    rerankSource(query: string, rows: SourceMatch[]): Promise<SourceMatch[]>;
    post(base: string, path: string, key: string, body: unknown, timeout?: number): Promise<any>;
    embed(texts: string[]): Promise<number[][]>;
    extract(content: string): Promise<Extraction>;
}
