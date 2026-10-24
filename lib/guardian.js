// A separate Node watchdog keeps the Java process tree tied to the host's stdin pipe.
// EOF is delivered even when the host crashes; persistent CLI starts bypass this helper.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let child, stopping = false;
function stop() {
    if (stopping)
        return;
    stopping = true;
    if (child?.pid && child.exitCode === null) {
        if (process.platform === 'win32')
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 20_000 });
        else {
            try {
                process.kill(-child.pid, 'SIGTERM');
            }
            catch { }
        }
    }
}
process.on('exit', stop);
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('SIGINT', () => { stop(); process.exit(0); });
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
        child.once('exit', () => { child = undefined; process.exit(0); });
        // Avoid emitting any Java output, memory content or environment values to the host.
    }
    catch {
        process.exit(1);
    }
});
lines.on('close', () => { stop(); process.exit(0); });
//# sourceMappingURL=guardian.js.map