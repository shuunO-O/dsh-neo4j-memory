import { type HostConfig } from './config.js';
export declare const SECRET_SPECS: {
    readonly apiKey: {
        readonly env: "DEEPSEEK_API_KEY";
        readonly ref: "DSH_NEO4J_MEMORY_EXTRACTION_API_KEY";
    };
    readonly embeddingApiKey: {
        readonly env: "EMBEDDING_API_KEY";
        readonly ref: "DSH_NEO4J_MEMORY_EMBEDDING_API_KEY";
    };
    readonly alignmentApiKey: {
        readonly env: "TYPESAFE_API_KEY";
        readonly ref: "DSH_NEO4J_MEMORY_ALIGNMENT_API_KEY";
    };
    readonly neo4jPassword: {
        readonly env: "NEO4J_PASSWORD";
        readonly ref: "DSH_NEO4J_MEMORY_NEO4J_PASSWORD";
    };
};
export type SecretField = keyof typeof SECRET_SPECS;
export interface CredentialService {
    resolve(ref: string): Promise<{
        value: string;
        source?: string;
    } | undefined>;
    set(ref: string, value: string): Promise<void>;
    unset(ref: string): Promise<void>;
}
export type LegacyCleanup = (values: Partial<Record<SecretField, string>>) => Promise<void>;
/** All host credential access stays here; neither status nor errors expose values. */
export declare class MemoryCredentials {
    private config;
    private getService;
    private cleanup?;
    private env;
    private tail;
    private cleared;
    private migrationPending;
    constructor(config: HostConfig, getService: () => CredentialService | undefined, cleanup?: LegacyCleanup | undefined, env?: NodeJS.ProcessEnv);
    private legacy;
    private environment;
    private serial;
    /** Writes only old Config values, never a resolved environment value. */
    migrate(): Promise<void>;
    /** Process env > plugin-owned DSH credential > legacy Config. Read on every operation. */
    resolve(): Promise<HostConfig>;
    status(): Promise<{
        writable: boolean;
        migrationPending: boolean;
        secrets: Record<"apiKey" | "embeddingApiKey" | "alignmentApiKey" | "neo4jPassword", {
            configured: boolean;
            source: string;
            ref: string;
        }>;
    }>;
    /** Validate the complete request before writing any key. Null explicitly clears. */
    update(values: unknown): Promise<void>;
}
