// A separate Node watchdog keeps the Java process tree tied to the host's stdin pipe.
// EOF is delivered even when the host crashes; persistent CLI starts bypass this helper.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let child, stopping = false, finished = false;
function finish() {
    if (finished)
        return;
    finished = true;
    process.exit(0);
}
function signal(signal) {
    if (!child?.pid || child.exitCode !== null)
        return;
    try {
        process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch { }
    }
}
function stop() {
    if (stopping)
        return;
    stopping = true;
    if (!child?.pid || child.exitCode !== null) {
        finish();
        return;
    }
    // Windows uses the PowerShell job-object guardian; the Node path is POSIX only.
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 20_000 });
        finish();
        return;
    }
    // Neo4j needs its graceful shutdown window to close; wait for it before the host proceeds.
    signal('SIGTERM');
    const timer = setTimeout(() => { signal('SIGKILL'); finish(); }, 20_000);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); finish(); });
}
process.on('exit', () => { if (stopping)
    return; if (child?.pid && child.exitCode === null)
    signal('SIGKILL'); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
lines.once('line', line => {
    try {
        const { executable, args, cwd, env, log } = JSON.parse(line);
        const fd = openSync(log, 'a');
        try {
            child = spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
        }
        finally {
            closeSync(fd);
        }
        child.once('spawn', () => process.stdout.write(JSON.stringify({ pid: child.pid }) + '\n'));
        child.once('error', () => { process.stdout.write('{"error":"Cannot launch local Neo4j"}\n'); process.exit(1); });
        child.once('exit', () => { child = undefined; finish(); });
        // Avoid emitting any Java output, memory content or environment values to the host.
    }
    catch {
        process.exit(1);
    }
});
lines.on('close', stop);
//# sourceMappingURL=guardian.js.map