import { type Driver } from 'neo4j-driver';
import { ModelClient, type Extraction } from './api.js';
import { type Candidate, type Decision } from './alignment.js';
import type { MemoryConfig } from './config.js';
import { type EvidenceEvent, type EvidenceLink, type SourceResult } from './evidence.js';
export interface EvidenceFilter {
    entity?: string;
    date?: string;
}
export interface EvidenceSearchOptions {
    query?: string;
    exclude?: string[];
}
export declare const indexes: Record<string, string>;
export declare class EmbeddingMismatch extends Error {
}
export declare function localTimestamp(timezone: string): string;
export declare class Neo4jStore {
    config: MemoryConfig;
    driver: Driver;
    private indexPromise?;
    private saveTail;
    constructor(config: MemoryConfig, driver?: Driver);
    close(): Promise<void>;
    run(query: string, params?: Record<string, any>, signal?: AbortSignal): Promise<any[]>;
    ensureIndexes(signal?: AbortSignal): Promise<void>;
    /** Drop the cached "indexes are ready" state after the embedding model or dimensions change. */
    resetIndexes(): void;
    private createVectorIndexes;
    private readEmbeddingMeta;
    private writeEmbeddingMeta;
    /** Group existing vectors by stored model/dimension, including nodes written before metadata existed. */
    private embeddingStats;
    /**
     * Refuse to mix vectors from different models or dimensions: they are not comparable, and the
     * vector index has a fixed dimension. The one safe upgrade is a legacy database whose vectors
     * already match the current configuration; adopt it by recording the metadata once.
     */
    private assertEmbeddingReady;
    embeddingStatus(): Promise<{
        nodes: number;
        dimensions: number | null;
        model: string | null;
        detected_dimensions: number[];
        detected_models: string[];
        configured: {
            model: string;
            dimensions: number;
        };
        compatible: boolean;
        legacy: boolean;
    }>;
    /**
     * Re-embed every node with the current model and dimensions, then rebuild the vector indexes.
     * New vectors are staged in `embedding_next` first, so a failed embedding call leaves the old
     * index and old vectors untouched; only the final copy and index rebuild touch live data.
     */
    reembed(client: ModelClient): Promise<{
        nodes: number;
        model: string;
        dimensions: number;
    }>;
    private reembedMemory;
    /** Allocate the next per-label numeric ID, e.g. event_1, person_2. */
    nextId(label: string): Promise<string>;
    save(content: string, sessionId: string, extraction: Extraction, client: ModelClient): Promise<{
        event_id: string;
        decisions: Decision[];
    }>;
    private saveMemory;
    private writeMemory;
    recallConcepts(name: string, vector: number[], limit: number, signal?: AbortSignal): Promise<Candidate[]>;
    private rankEvidence;
    searchEvidence(vector: number[] | undefined, filter: EvidenceFilter, signal?: AbortSignal, options?: EvidenceSearchOptions): Promise<EvidenceEvent[]>;
    evidenceLinks(ids: string[], vector: number[] | undefined, signal?: AbortSignal): Promise<{
        links: EvidenceLink[];
        limited: boolean;
    }>;
    evidenceExisting(ids: string[], signal?: AbortSignal): Promise<void>;
    expandEvidence(conceptId: string, seen: string[], vector: number[] | undefined, filter: EvidenceFilter, limit: number, signal?: AbortSignal, options?: EvidenceSearchOptions): Promise<EvidenceEvent[]>;
    nearbyEvidence(eventId: string, seen: string[], filter: EvidenceFilter, before: number, after: number, limit: number, signal?: AbortSignal, exclude?: string[]): Promise<EvidenceEvent[]>;
    readEvidence(eventId: string, start: number, limit: number, signal?: AbortSignal): Promise<SourceResult>;
    search(query: string | undefined, label: string, entity: string | undefined, date: string | undefined, client: ModelClient): Promise<any>;
    graph(selected?: string[], signal?: AbortSignal): Promise<any>;
}
