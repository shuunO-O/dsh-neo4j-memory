import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, rm, stat, appendFile, open } from 'node:fs/promises';
import { join, resolve, dirname, sep, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import yauzl from 'yauzl';
import neo4j from 'neo4j-driver';
const exec = promisify(execFile);
export const NEO4J_VERSION = '5.26.30', JRE_VERSION = '21.0.12.1+1';
const artifacts = {
    neo4j: ['https://dist.neo4j.org/neo4j-community-5.26.30-windows.zip', 'b2c2932b16f810adcc54560e90ee35847047d2d52f78cfbfabbae133be8f82cd'],
    jre: ['https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip', 'd35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636'],
};
export class RuntimeUnavailable extends Error {
}
export function defaultDataRoot() {
    return resolve(process.env.DSH_NEO4J_MEMORY_RUNTIME_DIR || process.env.DSH_NEO4J_MEMORY_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-neo4j-memory'));
}
async function digest(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path))
        hash.update(chunk);
    return hash.digest('hex');
}
export async function portOpen(port) {
    return new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const done = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(400);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}
export function guardArchivePath(root, name) {
    const normalized = name.replaceAll('\\', '/');
    const target = resolve(root, normalized);
    if (isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..') || normalized.includes(':') || !target.startsWith(resolve(root) + sep))
        throw new RuntimeUnavailable('Archive contains an unsafe path');
    return target;
}
export async function extractZip(archive, destination) {
    const staging = join(dirname(archive), `unpack-${randomBytes(8).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    try {
        await new Promise((resolve, reject) => {
            yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
                if (error || !zip) {
                    reject(error);
                    return;
                }
                const fail = (error) => { zip.close(); reject(error); };
                zip.on('error', fail);
                zip.on('end', resolve);
                zip.on('entry', entry => {
                    void (async () => {
                        const path = guardArchivePath(staging, entry.fileName);
                        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
                            throw new RuntimeUnavailable('Archive contains a symbolic link');
                        if (entry.fileName.endsWith('/'))
                            await mkdir(path, { recursive: true });
                        else {
                            await mkdir(dirname(path), { recursive: true });
                            const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (e, s) => e ? reject(e) : resolve(s)));
                            await pipeline(stream, createWriteStream(path, { flags: 'wx' }));
                        }
                        zip.readEntry();
                    })().catch(fail);
                });
                zip.readEntry();
            });
        });
        const children = await readdir(staging, { withFileTypes: true });
        const source = children.length === 1 && children[0].isDirectory() ? join(staging, children[0].name) : staging;
        // Refuse to replace an existing installation: it may contain user files.
        if (existsSync(destination))
            throw new RuntimeUnavailable(`Incomplete runtime at ${destination}; move it aside before retrying`);
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
    }
    finally {
        if (resolve(staging).startsWith(resolve(dirname(archive)) + sep) && /^unpack-[0-9a-f]+$/.test(staging.split(sep).at(-1)))
            await rm(staging, { recursive: true, force: true });
    }
}
export class LocalNeo4j {
    signal;
    dataRoot;
    home;
    jre;
    confDir;
    dataDir;
    logsDir;
    runDir;
    port = 7687;
    password = '';
    startedHere = false;
    javaHome;
    process;
    guardian;
    pid;
    detach = false;
    stopped = false;
    constructor(dataRoot, bundle, signal) {
        this.signal = signal;
        this.dataRoot = resolve(dataRoot || defaultDataRoot());
        const bundled = bundle || process.env.DSH_NEO4J_MEMORY_RUNTIME_BUNDLE || fileURLToPath(new URL('../runtime/', import.meta.url));
        this.home = existsSync(join(bundled, 'neo4j', 'bin')) ? join(bundled, 'neo4j') : join(this.dataRoot, 'neo4j');
        this.jre = existsSync(join(bundled, 'jre', 'bin')) ? join(bundled, 'jre') : join(this.dataRoot, 'jre');
        this.confDir = join(this.dataRoot, 'conf');
        this.dataDir = join(this.dataRoot, 'data');
        this.logsDir = join(this.dataRoot, 'logs');
        this.runDir = join(this.dataRoot, 'run');
    }
    async locked(callback) {
        await mkdir(this.dataRoot, { recursive: true });
        // A distinct lock directory avoids colliding with the legacy Python byte lock.
        let release;
        const deadline = Date.now() + 900_000;
        while (!release) {
            this.signal?.throwIfAborted();
            try {
                release = await lockfile.lock(this.dataRoot, { realpath: false, lockfilePath: join(this.dataRoot, 'runtime-node.lock'), stale: 30_000, update: 10_000, retries: 0 });
            }
            catch (error) {
                if (error.code !== 'ELOCKED' || Date.now() > deadline)
                    throw new RuntimeUnavailable('Cannot acquire local Neo4j runtime lock');
                await delay(500, undefined, { signal: this.signal });
            }
        }
        try {
            this.signal?.throwIfAborted();
            return await callback();
        }
        finally {
            await release();
        }
    }
    async readState() {
        try {
            const state = JSON.parse(await readFile(join(this.dataRoot, 'state.json'), 'utf8'));
            if (!state || typeof state !== 'object' || Array.isArray(state))
                throw new Error();
            return state;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return {};
            throw new RuntimeUnavailable('Cannot read local Neo4j state; restore state.json before starting');
        }
    }
    async writeState(state) {
        const path = join(this.dataRoot, 'state.json'), temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        await rename(temporary, path);
    }
    loadState(state) {
        this.password = typeof state.password === 'string' ? state.password : '';
        this.port = Number.isInteger(state.port) && state.port > 0 && state.port <= 65535 ? state.port : 7687;
    }
    initialized() { return existsSync(join(this.dataDir, 'dbms')) || existsSync(join(this.dataDir, 'databases')); }
    info() { return { uri: `bolt://127.0.0.1:${this.port}`, user: 'neo4j', password: this.password, port: this.port, home: this.home }; }
    async log(message) { await appendFile(join(this.dataRoot, 'provision.log'), `${new Date().toISOString()} ${message}\n`).catch(() => { }); }
    async probe() {
        if (!(await portOpen(this.port)))
            return 'down';
        const driver = neo4j.driver(this.info().uri, neo4j.auth.basic('neo4j', this.password), { connectionTimeout: 4000, connectionAcquisitionTimeout: 8000, maxTransactionRetryTime: 0 });
        const session = driver.session({ database: 'neo4j' });
        try {
            await session.run('RETURN 1 AS ok', {}, { timeout: 4000 });
            return 'ready';
        }
        catch (e) {
            return e.code === 'Neo.ClientError.Security.Unauthorized' ? 'auth' : 'down';
        }
        finally {
            await session.close();
            await driver.close();
        }
    }
    async resolveJava() {
        if (this.javaHome)
            return this.javaHome;
        const name = process.platform === 'win32' ? 'java.exe' : 'java';
        for (const root of [this.jre, join(this.jre, 'Contents', 'Home')])
            if (existsSync(join(root, 'bin', name)))
                return this.javaHome = root;
        for (const executable of [process.env.DSH_NEO4J_MEMORY_JAVA, ...(process.env.PATH || '').split(sep === '\\' ? ';' : ':').map(p => join(p, name))]) {
            if (!executable || !existsSync(executable))
                continue;
            try {
                const result = await exec(executable, ['-version'], { windowsHide: true, timeout: 20_000 });
                const match = (result.stderr + result.stdout).match(/version "(\d+)(?:\.(\d+))?/);
                if (match && Number(match[1] === '1' ? match[2] : match[1]) >= 17)
                    return this.javaHome = dirname(dirname(executable));
            }
            catch { }
        }
        return undefined;
    }
    async homeReady() { try {
        return (await readdir(join(this.home, 'bin'))).length > 0;
    }
    catch {
        return false;
    } }
    async download(url, checksum) {
        const directory = join(this.dataRoot, 'downloads');
        await mkdir(directory, { recursive: true });
        const target = join(directory, new URL(url).pathname.split('/').at(-1)), part = `${target}.part`;
        if (existsSync(target) && await digest(target) === checksum)
            return target;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const offset = await stat(part).then(s => s.size).catch(() => 0);
                const response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(this.signal ? [this.signal] : [])]) });
                if (response.status === 416) {
                    await response.body?.cancel();
                    await rm(part, { force: true });
                    continue;
                }
                if (!response.ok || !response.body) {
                    await response.body?.cancel();
                    throw new Error('Download failed');
                }
                if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) {
                    await response.body.cancel();
                    throw new Error('Invalid download range');
                }
                await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { flags: offset && response.status === 206 ? 'a' : 'w' }));
                if (await digest(part) !== checksum) {
                    await rm(part, { force: true });
                    throw new Error('Checksum mismatch');
                }
                await rename(part, target);
                return target;
            }
            catch {
                this.signal?.throwIfAborted();
                await this.log(`download attempt ${attempt} failed`);
                if (attempt < 3)
                    await delay(attempt * 2000, undefined, { signal: this.signal });
            }
        }
        throw new RuntimeUnavailable(`Could not download runtime; see ${join(this.dataRoot, 'provision.log')}`);
    }
    async prepareInstall() {
        const missingHome = !(await this.homeReady()), missingJava = !(await this.resolveJava());
        if ((missingHome || missingJava) && (process.platform !== 'win32' || process.arch !== 'x64'))
            throw new RuntimeUnavailable('Managed runtime downloads currently support Windows x64 only');
        if (missingHome)
            await extractZip(await this.download(...artifacts.neo4j), this.home);
        if (missingJava) {
            await extractZip(await this.download(...artifacts.jre), this.jre);
            this.javaHome = undefined;
        }
    }
    async prepare() {
        return this.locked(async () => {
            await this.prepareInstall();
            const state = await this.readState();
            this.loadState(state);
            if (!this.password) {
                if (this.initialized())
                    throw new RuntimeUnavailable('Local Neo4j data exists without password state');
                this.password = randomBytes(24).toString('base64url');
                await this.writeState({ ...state, password: this.password });
            }
            return this.info();
        });
    }
    async choosePort() {
        for (const port of new Set([this.port, 7687, ...Array.from({ length: 29 }, (_, i) => i + 7688)]))
            if (!(await portOpen(port))) {
                this.port = port;
                return;
            }
        this.port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
    }
    async writeConfig() {
        for (const dir of [this.confDir, this.dataDir, this.logsDir, this.runDir, join(this.dataRoot, 'tmp')])
            await mkdir(dir, { recursive: true });
        const posix = (p) => p.replaceAll('\\', '/');
        await writeFile(join(this.confDir, 'neo4j.conf'), [
            '# Generated by dsh-neo4j-memory. Changes are overwritten on start.', 'server.default_listen_address=127.0.0.1', 'server.bolt.enabled=true',
            `server.bolt.listen_address=127.0.0.1:${this.port}`, 'server.bolt.tls_level=DISABLED', 'server.http.enabled=false', 'server.https.enabled=false',
            `server.directories.data=${posix(this.dataDir)}`, `server.directories.logs=${posix(this.logsDir)}`, `server.directories.run=${posix(this.runDir)}`,
            'server.memory.heap.initial_size=256m', 'server.memory.heap.max_size=512m', 'server.memory.pagecache.size=256m',
            'dbms.security.auth_enabled=true', 'dbms.usage_report.enabled=false', '',
            `server.jvm.additional=-Djava.io.tmpdir=${posix(join(this.dataRoot, 'tmp'))}`,
            `server.jvm.additional=-Djna.tmpdir=${posix(join(this.dataRoot, 'tmp'))}`,
            // Windows JDK selectors need a working Unix-domain socket directory.
            ...(process.platform === 'win32' ? [`server.jvm.additional=-Djdk.net.unixdomain.tmpdir=${posix(tmpdir())}`] : []),
        ].join('\n'));
    }
    async command(main, args) {
        const javaHome = await this.resolveJava();
        if (!javaHome)
            throw new RuntimeUnavailable('Java runtime is missing');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('NEO4J_')).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]));
        Object.assign(env, { NEO4J_HOME: this.home, NEO4J_CONF: this.confDir, JAVA_HOME: javaHome, TEMP: join(this.dataRoot, 'tmp'), TMP: join(this.dataRoot, 'tmp'), PATH: `${join(javaHome, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}` });
        return { executable: join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), args: [`-Djava.io.tmpdir=${join(this.dataRoot, 'tmp')}`, ...(process.platform === 'win32' ? [`-Djdk.net.unixdomain.tmpdir=${tmpdir()}`] : []), '-cp', join(this.home, 'lib', '*'), `-Dbasedir=${this.home}`, main, ...args], cwd: this.home, env, log: join(this.logsDir, 'console.log') };
    }
    async launch() {
        const options = await this.command('org.neo4j.server.startup.Neo4jCommand', ['console']);
        if (this.detach || process.env.DSH_NEO4J_MEMORY_NEO4J_KEEP_RUNNING === '1') {
            const fd = await open(options.log, 'a');
            try {
                const child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: true, stdio: ['ignore', fd.fd, fd.fd] });
                this.process = child;
                await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
                this.pid = child.pid;
                child.unref();
            }
            finally {
                await fd.close();
            }
        }
        else {
            const executable = process.platform === 'win32' ? 'powershell.exe' : process.execPath;
            const args = process.platform === 'win32'
                ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../assets/windows-guardian.ps1', import.meta.url))]
                : [fileURLToPath(new URL('./guardian.js', import.meta.url))];
            const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
            this.guardian = child;
            await new Promise((resolve, reject) => {
                let buffer = '';
                const timer = setTimeout(() => reject(new RuntimeUnavailable('Neo4j watchdog did not start')), 15_000);
                const fail = () => { clearTimeout(timer); reject(new RuntimeUnavailable('Cannot launch Neo4j watchdog')); };
                child.once('error', fail);
                child.once('exit', fail);
                child.stdin.on('error', fail);
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', chunk => {
                    buffer += chunk;
                    if (buffer.includes('\n')) {
                        clearTimeout(timer);
                        try {
                            const response = JSON.parse(buffer.split('\n')[0]);
                            if (!Number.isInteger(response.pid)) {
                                void this.log(`Windows watchdog: ${response.diagnostic || response.error || 'invalid handshake'}`);
                                throw new Error();
                            }
                            this.pid = response.pid;
                            resolve();
                        }
                        catch {
                            reject(new RuntimeUnavailable('Cannot launch local Neo4j'));
                        }
                    }
                });
                child.stdin.write(JSON.stringify(options) + '\n');
            });
        }
        await writeFile(join(this.runDir, 'dsh-neo4j-memory.pid'), String(this.pid));
    }
    async ensure() {
        return this.locked(async () => {
            const state = await this.readState();
            this.loadState(state);
            if (!this.password) {
                if (this.initialized())
                    throw new RuntimeUnavailable('Local Neo4j data exists but its password state is missing; restore state.json');
                this.password = randomBytes(24).toString('base64url');
                await this.writeState({ ...state, password: this.password });
            }
            const status = await this.probe();
            if (status === 'ready') {
                await this.log('attached to an already running local Neo4j');
                return this.info();
            }
            if (status === 'auth' && this.initialized())
                throw new RuntimeUnavailable('Local Neo4j rejected the stored password');
            await this.prepareInstall();
            this.signal?.throwIfAborted();
            await this.choosePort();
            await this.writeConfig();
            if (!existsSync(join(this.dataDir, 'dbms', 'auth')) && !existsSync(join(this.dataDir, 'dbms', 'auth.ini'))) {
                const c = await this.command('org.neo4j.server.startup.Neo4jAdminCommand', ['dbms', 'set-initial-password', '--', this.password]);
                try {
                    await exec(c.executable, c.args, { cwd: c.cwd, env: c.env, windowsHide: true, timeout: 180_000, signal: this.signal });
                }
                catch (error) {
                    await this.log(`Password initialization failed: ${String(error.stderr || error.code || 'unknown error').replaceAll(this.password, '[redacted]').slice(-2000)}`);
                    throw new RuntimeUnavailable('Cannot initialize local Neo4j password; inspect local runtime configuration');
                }
            }
            try {
                await this.launch();
                const deadline = Date.now() + 240_000;
                while (Date.now() < deadline) {
                    this.signal?.throwIfAborted();
                    if (this.stopped)
                        throw new RuntimeUnavailable('Memory plugin was disposed during startup');
                    if ((this.guardian && this.guardian.exitCode !== null) || (this.process && this.process.exitCode !== null))
                        throw new RuntimeUnavailable(`Local Neo4j exited during startup; inspect ${join(this.logsDir, 'console.log')}`);
                    if (await this.probe() === 'ready') {
                        this.startedHere = true;
                        await this.writeState({ ...state, password: this.password, port: this.port, neo4j: NEO4J_VERSION });
                        await this.log(`started local Neo4j on port ${this.port}`);
                        return this.info();
                    }
                    await delay(1000, undefined, { signal: this.signal });
                }
                throw new RuntimeUnavailable(`Local Neo4j did not become ready; inspect ${join(this.logsDir, 'console.log')}`);
            }
            catch (error) {
                await this.terminate();
                throw error;
            }
        });
    }
    async terminate() {
        if (this.guardian) {
            const child = this.guardian;
            this.guardian = undefined;
            const exited = new Promise(resolve => { if (child.exitCode !== null)
                resolve();
            else
                child.once('exit', () => resolve()); });
            child.stdin?.end();
            await Promise.race([exited, delay(25_000, undefined, { ref: false })]);
        }
        else if (this.pid) {
            if (process.platform === 'win32')
                await exec('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 }).catch(() => { });
            else {
                try {
                    process.kill(-this.pid, 'SIGTERM');
                }
                catch { }
            }
        }
        this.process = undefined;
        this.pid = undefined;
        for (let i = 0; i < 100 && await portOpen(this.port); i++)
            await delay(200);
        if (await portOpen(this.port))
            throw new RuntimeUnavailable('Local Neo4j is still running after shutdown');
        await rm(join(this.runDir, 'dsh-neo4j-memory.pid'), { force: true });
    }
    async stop() {
        this.stopped = true;
        if (!this.startedHere || this.detach || process.env.DSH_NEO4J_MEMORY_NEO4J_KEEP_RUNNING === '1')
            return;
        await this.terminate();
        this.startedHere = false;
        await this.log('stopped local Neo4j');
    }
    async status() {
        this.loadState(await this.readState());
        return { installed: await this.homeReady() && !!await this.resolveJava(), home: this.home, data: this.dataDir, port: this.port, running: !!this.password && await this.probe() === 'ready', version: NEO4J_VERSION };
    }
    async startPersistent() { this.detach = true; return this.ensure(); }
    async stopPersistent() {
        await this.locked(async () => {
            this.loadState(await this.readState());
            if (await this.probe() !== 'ready')
                throw new RuntimeUnavailable('Cannot authenticate the managed database; refusing to stop an unverified process');
            const pid = Number((await readFile(join(this.runDir, 'dsh-neo4j-memory.pid'), 'utf8')).trim());
            if (!Number.isInteger(pid) || pid <= 0)
                throw new RuntimeUnavailable('Invalid local Neo4j PID');
            // Check command identity as well as credentials before using a stored PID.
            if (process.platform === 'win32') {
                const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`], { windowsHide: true });
                if (!result.stdout.includes('org.neo4j.server.startup.Neo4jCommand') || !result.stdout.includes(this.home))
                    throw new RuntimeUnavailable('Stored process no longer belongs to this runtime');
            }
            this.pid = pid;
            await this.terminate();
        });
    }
}
//# sourceMappingURL=runtime.js.map