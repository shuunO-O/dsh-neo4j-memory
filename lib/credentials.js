import { liveValue } from './config.js';
export const SECRET_SPECS = {
    apiKey: { env: 'DEEPSEEK_API_KEY', ref: 'DSH_NEO4J_MEMORY_EXTRACTION_API_KEY' },
    embeddingApiKey: { env: 'EMBEDDING_API_KEY', ref: 'DSH_NEO4J_MEMORY_EMBEDDING_API_KEY' },
    alignmentApiKey: { env: 'TYPESAFE_API_KEY', ref: 'DSH_NEO4J_MEMORY_ALIGNMENT_API_KEY' },
    neo4jPassword: { env: 'NEO4J_PASSWORD', ref: 'DSH_NEO4J_MEMORY_NEO4J_PASSWORD' },
};
const fields = Object.keys(SECRET_SPECS);
const text = (value) => typeof value === 'string' ? value.trim() : '';
/** All host credential access stays here; neither status nor errors expose values. */
export class MemoryCredentials {
    config;
    getService;
    cleanup;
    env;
    tail = Promise.resolve();
    cleared = new Map();
    migrationPending = false;
    constructor(config, getService, cleanup, env = process.env) {
        this.config = config;
        this.getService = getService;
        this.cleanup = cleanup;
        this.env = env;
    }
    legacy(field) {
        const value = text(liveValue(this.config[field]));
        if (this.cleared.get(field) === value)
            return '';
        this.cleared.delete(field);
        return value;
    }
    environment(field) {
        const spec = SECRET_SPECS[field];
        return text(this.env[spec.env]) || text(this.env[spec.ref]);
    }
    serial(work) {
        const next = this.tail.then(work);
        this.tail = next.catch(() => { });
        return next;
    }
    /** Writes only old Config values, never a resolved environment value. */
    migrate() {
        return this.serial(async () => {
            this.migrationPending = false;
            const service = this.getService();
            if (!service || !this.cleanup) {
                this.migrationPending = fields.some(field => Boolean(this.legacy(field)));
                return;
            }
            for (const field of fields) {
                const value = this.legacy(field);
                if (!value)
                    continue;
                try {
                    const ref = SECRET_SPECS[field].ref;
                    let stored = await service.resolve(ref);
                    // A pre-existing different credential wins; retain the legacy value
                    // until the user explicitly replaces/clears it, rather than lose it.
                    if (text(stored?.value) && (text(stored?.value) !== value
                        || ['env', 'project-env', 'user-env'].includes(stored?.source ?? ''))) {
                        this.migrationPending = true;
                        continue;
                    }
                    if (!text(stored?.value)) {
                        await service.set(ref, value);
                        stored = await service.resolve(ref);
                    }
                    if (text(stored?.value) !== value)
                        throw new Error();
                    await this.cleanup({ [field]: value });
                    this.cleared.set(field, value);
                }
                catch {
                    this.migrationPending = true;
                    throw new Error('Could not migrate memory credentials; the legacy configuration was retained');
                }
            }
        });
    }
    /** Process env > plugin-owned DSH credential > legacy Config. Read on every operation. */
    async resolve() {
        // Migration failure must not prevent an environment override or old Config
        // from working. The settings status explicitly reports incomplete migration.
        await this.migrate().catch(() => { });
        return this.serial(async () => {
            try {
                const result = { ...this.config };
                const service = this.getService();
                for (const field of fields) {
                    const fromEnv = this.environment(field);
                    result[field] = fromEnv || text((await service?.resolve(SECRET_SPECS[field].ref))?.value) || this.legacy(field);
                }
                return result;
            }
            catch {
                throw new Error('Could not read memory credentials from DSH');
            }
        });
    }
    async status() {
        await this.migrate().catch(() => { });
        return this.serial(async () => {
            const service = this.getService();
            const secrets = {};
            for (const field of fields) {
                const fromEnv = this.environment(field);
                const stored = fromEnv ? undefined : await service?.resolve(SECRET_SPECS[field].ref);
                secrets[field] = {
                    configured: Boolean(fromEnv || text(stored?.value) || this.legacy(field)),
                    source: fromEnv ? 'env' : text(stored?.value) ? 'dsh' : this.legacy(field) ? 'legacy' : 'none',
                    ref: SECRET_SPECS[field].ref,
                };
            }
            return { writable: Boolean(service), migrationPending: this.migrationPending, secrets };
        });
    }
    /** Validate the complete request before writing any key. Null explicitly clears. */
    update(values) {
        if (!values || typeof values !== 'object' || Array.isArray(values))
            return Promise.reject(new Error('Invalid credential update'));
        const edits = Object.entries(values);
        if (edits.some(([field, value]) => !fields.includes(field)
            || (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 16384)))) {
            return Promise.reject(new Error('Invalid credential update'));
        }
        return this.serial(async () => {
            const service = this.getService();
            if (!service)
                throw new Error('DSH credential service is unavailable');
            try {
                for (const [name, value] of edits) {
                    const field = name;
                    const ref = SECRET_SPECS[field].ref;
                    const legacy = this.legacy(field);
                    // Clear legacy first for deletion, so it cannot resurrect on restart.
                    // For replacement, persist the new credential before clearing old Config.
                    if (value === null) {
                        if (legacy) {
                            if (!this.cleanup)
                                throw new Error();
                            await this.cleanup({ [field]: legacy });
                            this.cleared.set(field, legacy);
                        }
                        await service.unset(ref);
                    }
                    else {
                        await service.set(ref, value.trim());
                        if (legacy) {
                            if (!this.cleanup)
                                throw new Error();
                            await this.cleanup({ [field]: legacy });
                            this.cleared.set(field, legacy);
                        }
                    }
                }
            }
            catch {
                throw new Error('Could not update memory credentials; retry the operation');
            }
        });
    }
}
//# sourceMappingURL=credentials.js.map