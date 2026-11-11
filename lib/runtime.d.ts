export declare const NEO4J_VERSION = "5.26.30", JRE_VERSION = "21.0.12.1+1";
export type ArchiveKind = 'zip' | 'tar.gz';
export interface RuntimeArtifact {
    version: string;
    url: string;
    sha256: string;
    archive: ArchiveKind;
}
export interface RuntimeArtifacts {
    neo4j: RuntimeArtifact;
    jre: RuntimeArtifact;
}
export declare function runtimeTarget(): string;
/** Artifacts for a platform; URL and checksum may be overridden for mirrors or offline provisioning. */
export declare function runtimeArtifacts(target?: string, env?: NodeJS.ProcessEnv): RuntimeArtifacts | undefined;
export declare class RuntimeUnavailable extends Error {
}
export interface RuntimeInfo {
    uri: string;
    user: string;
    password: string;
    port: number;
    home: string;
}
export declare function processAlive(pid: number): boolean;
export declare function defaultDataRoot(): string;
export declare function portOpen(port: number): Promise<boolean>;
export declare function guardArchivePath(root: string, name: string): string;
export declare function extractZip(archive: string, destination: string): Promise<void>;
/**
 * Extract a .tar.gz with the system tar. Members are listed and validated before extraction;
 * links and special files are refused so staged content cannot escape the staging tree.
 */
export declare function extractTarGz(archive: string, destination: string): Promise<void>;
export declare function extractArchive(kind: ArchiveKind, archive: string, destination: string): Promise<void>;
export declare class LocalNeo4j {
    private signal?;
    dataRoot: string;
    home: string;
    jre: string;
    confDir: string;
    dataDir: string;
    logsDir: string;
    runDir: string;
    port: number;
    password: string;
    startedHere: boolean;
    private javaHome?;
    private process?;
    private guardian?;
    private pid?;
    private detach;
    private stopped;
    constructor(dataRoot?: string, bundle?: string, signal?: AbortSignal | undefined);
    private locked;
    private readState;
    private writeState;
    private loadState;
    private initialized;
    private info;
    log(message: string): Promise<void>;
    probe(): Promise<'ready' | 'auth' | 'down'>;
    resolveJava(): Promise<string | undefined>;
    private homeReady;
    private download;
    private assertSupportedPaths;
    private prepareInstall;
    prepare(): Promise<RuntimeInfo>;
    private choosePort;
    private writeConfig;
    private command;
    private launch;
    ensure(): Promise<RuntimeInfo>;
    private terminate;
    stop(): Promise<void>;
    private runtimeVersion;
    status(): Promise<{
        installed: boolean;
        home: string;
        data: string;
        port: number;
        running: boolean;
        version: string;
    }>;
    startPersistent(): Promise<RuntimeInfo>;
    stopPersistent(): Promise<void>;
}
