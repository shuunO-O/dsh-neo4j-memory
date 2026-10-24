export type HostConfig = Record<string, unknown>;
export declare function parseBoolean(value: unknown, fallback: boolean): boolean;
export declare class MemoryConfig {
    apiKey: string;
    embeddingApiKey: string;
    alignmentApiKey: string;
    neo4jPassword: string;
    neo4jUri: string;
    neo4jUser: string;
    neo4jDatabase: string;
    neo4jManaged: boolean;
    conceptAlignment: boolean;
    extractionUrl: string;
    extractionModel: string;
    embeddingUrl: string;
    embeddingModel: string;
    dimensions: number;
    alignmentUrl: string;
    alignmentModel: string;
    alignmentThreshold: number;
    timezone: string;
    dataDir: string;
    static fromEnvironment(keys?: HostConfig, env?: NodeJS.ProcessEnv): MemoryConfig;
    requireModelKeys(extraction?: boolean, embedding?: boolean, alignment?: boolean): void;
}
