import { MemoryConfig, type HostConfig } from './config.js';
import { Neo4jStore } from './store.js';
import { LocalNeo4j } from './runtime.js';
export declare class MemoryService {
    config: MemoryConfig;
    runtime?: LocalNeo4j | undefined;
    store: Neo4jStore;
    private reembedding;
    constructor(config: MemoryConfig, runtime?: LocalNeo4j | undefined, store?: Neo4jStore);
    static create(keys: HostConfig, signal?: AbortSignal): Promise<MemoryService>;
    close(): Promise<void>;
    /**
     * Refresh model-facing settings from the live Config cells on an already-running service.
     * The backend is created once; volatile edits (keys, endpoints, models, threshold) must be
     * re-read here or they would only apply after a restart.
     */
    applyLiveConfig(keys: HostConfig): void;
    call(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
/** One lazy, in-process service per Cordis plugin instance. */
export declare class MemoryBackend {
    private keys;
    private starting?;
    private service?;
    private closed;
    private lifecycle;
    private pending;
    constructor(keys?: HostConfig);
    start(): Promise<MemoryService>;
    call(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
}
