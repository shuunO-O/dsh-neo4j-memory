/** Cordis marks live-editable Config fields with this symbol and a `get()` reader. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
/** Resolve a live Config field to its current value, leaving plain values untouched. */
function liveValue(value) {
    if (value !== null && typeof value === 'object' && VOLATILE_WRITE in value) {
        const get = value.get;
        if (typeof get === 'function')
            return get.call(value);
    }
    return value;
}
export function parseBoolean(value, fallback) {
    value = liveValue(value);
    if (typeof value === 'boolean')
        return value;
    if (value === 1 || value === 0)
        return Boolean(value);
    if (typeof value === 'string') {
        const normalized = value.trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized))
            return true;
        if (['0', 'false', 'no', 'off'].includes(normalized))
            return false;
    }
    return fallback;
}
export class MemoryConfig {
    apiKey = '';
    embeddingApiKey = '';
    alignmentApiKey = '';
    neo4jPassword = '';
    neo4jUri = 'bolt://localhost:7687';
    neo4jUser = 'neo4j';
    neo4jDatabase = 'neo4j';
    neo4jManaged = false;
    conceptAlignment = true;
    extractionUrl = 'https://api.deepseek.com';
    extractionModel = 'deepseek-flash';
    embeddingUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    embeddingModel = 'qwen3.7-text-embedding';
    dimensions = 1024;
    alignmentUrl = 'https://api.typesafe.ai/v1/systemone';
    alignmentModel = 'jev';
    alignmentThreshold = 0.95;
    timezone = 'Asia/Shanghai';
    dataDir = '';
    static fromEnvironment(keys = {}, env = process.env) {
        const cfg = new MemoryConfig();
        const text = (key, variable, fallback = '') => {
            const value = liveValue(keys[key]) || env[variable] || fallback;
            if (typeof value !== 'string')
                throw new Error(`Invalid ${key}`);
            return value.trim();
        };
        const number = (key, variable, fallback) => {
            const value = liveValue(keys[key]) ?? env[variable];
            if (value === undefined || value === null || value === '')
                return fallback;
            const parsed = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(parsed))
                throw new Error(`Invalid ${key}`);
            return parsed;
        };
        cfg.apiKey = text('apiKey', 'DEEPSEEK_API_KEY');
        cfg.embeddingApiKey = text('embeddingApiKey', 'EMBEDDING_API_KEY');
        cfg.alignmentApiKey = text('alignmentApiKey', 'TYPESAFE_API_KEY');
        cfg.neo4jPassword = text('neo4jPassword', 'NEO4J_PASSWORD');
        const mode = text('neo4jMode', 'DSH_NEO4J_MEMORY_NEO4J_MODE', 'auto').toLowerCase();
        if (!['auto', 'managed', 'external'].includes(mode))
            throw new Error('DSH_NEO4J_MEMORY_NEO4J_MODE must be auto, managed or external');
        const uri = env.DSH_NEO4J_MEMORY_NEO4J_URI?.trim();
        cfg.neo4jManaged = mode === 'managed' || (mode === 'auto' && !cfg.neo4jPassword && !uri);
        if (!cfg.neo4jManaged && !cfg.neo4jPassword)
            throw new Error('Missing credential: NEO4J_PASSWORD');
        if (cfg.neo4jManaged)
            cfg.neo4jPassword = '';
        cfg.neo4jUri = uri || cfg.neo4jUri;
        cfg.conceptAlignment = parseBoolean(keys.conceptAlignment ?? env.DSH_NEO4J_MEMORY_CONCEPT_ALIGNMENT, true);
        cfg.extractionUrl = text('extractionBaseUrl', 'DSH_NEO4J_MEMORY_EXTRACTION_URL', cfg.extractionUrl);
        cfg.extractionModel = text('extractionModel', 'DSH_NEO4J_MEMORY_EXTRACTION_MODEL', cfg.extractionModel);
        cfg.embeddingUrl = text('embeddingBaseUrl', 'DSH_NEO4J_MEMORY_EMBEDDING_URL', cfg.embeddingUrl);
        cfg.embeddingModel = text('embeddingModel', 'DSH_NEO4J_MEMORY_EMBEDDING_MODEL', cfg.embeddingModel);
        cfg.alignmentUrl = text('alignmentBaseUrl', 'DSH_NEO4J_MEMORY_ALIGNMENT_URL', cfg.alignmentUrl);
        cfg.alignmentModel = text('alignmentModel', 'DSH_NEO4J_MEMORY_ALIGNMENT_MODEL', cfg.alignmentModel);
        cfg.alignmentThreshold = number('alignmentThreshold', 'DSH_NEO4J_MEMORY_ALIGNMENT_THRESHOLD', cfg.alignmentThreshold);
        if (!(cfg.alignmentThreshold >= 0.8 && cfg.alignmentThreshold <= 0.99))
            throw new Error('alignmentThreshold must be between 0.8 and 0.99');
        cfg.dataDir = text('dataDir', 'DSH_NEO4J_MEMORY_RUNTIME_DIR', env.DSH_NEO4J_MEMORY_DATA_DIR || '');
        for (const [field, variable] of Object.entries({
            neo4jUser: 'DSH_NEO4J_MEMORY_NEO4J_USER', neo4jDatabase: 'DSH_NEO4J_MEMORY_NEO4J_DATABASE', timezone: 'DSH_NEO4J_MEMORY_TIMEZONE',
        }))
            if (env[variable] !== undefined)
                cfg[field] = env[variable];
        cfg.dimensions = number('embeddingDimensions', 'DSH_NEO4J_MEMORY_EMBEDDING_DIMENSIONS', cfg.dimensions);
        if (!Number.isInteger(cfg.dimensions) || cfg.dimensions < 1 || cfg.dimensions > 4096)
            throw new Error('embeddingDimensions must be an integer between 1 and 4096');
        new Intl.DateTimeFormat('en', { timeZone: cfg.timezone });
        for (const value of [cfg.extractionUrl, cfg.embeddingUrl, cfg.alignmentUrl]) {
            const url = new URL(value);
            if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password)
                throw new Error('API URLs must be HTTP(S) URLs without embedded credentials');
        }
        if (!/^(bolt|neo4j)(\+s|\+ssc)?:\/\//.test(cfg.neo4jUri))
            throw new Error('Invalid Neo4j URI scheme');
        return cfg;
    }
    requireModelKeys(extraction = true, embedding = true, alignment = false) {
        const missing = [extraction && !this.apiKey && 'DEEPSEEK_API_KEY', embedding && !this.embeddingApiKey && 'EMBEDDING_API_KEY', alignment && !this.alignmentApiKey && 'TYPESAFE_API_KEY'].filter(Boolean);
        if (missing.length)
            throw new Error(`Missing credential: ${missing.join(', ')}`);
    }
}
//# sourceMappingURL=config.js.map