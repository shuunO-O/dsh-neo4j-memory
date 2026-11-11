import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalNeo4j, portOpen } from '../lib/runtime.js';

const archive = process.env.DSH_NEO4J_MEMORY_TEST_NEO4J_ARCHIVE;
const jreArchive = process.env.DSH_NEO4J_MEMORY_TEST_JRE_ARCHIVE;
const skip = process.platform !== 'linux' || !archive;

function findJava() {
  for (const directory of (process.env.PATH || '').split(':')) {
    if (directory && existsSync(join(directory, 'java'))) return join(directory, 'java');
  }
  return undefined;
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function serveArchive(path, filename = 'neo4j-community-test-unix.tar.gz') {
  const total = (await stat(path)).size;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const range = /^bytes=(\d+)-/.exec(request.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = total - 1;
      response.writeHead(206, { 'content-type': 'application/gzip', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${total}` });
      createReadStream(path, { start, end }).pipe(response);
    } else {
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': total });
      createReadStream(path).pipe(response);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/${filename}`,
    requests: () => requests,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}
async function waitClosed(port, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (!(await portOpen(port))) return true; await delay(250); }
  return !(await portOpen(port));
}

test('managed Linux runtime: download, checksum, tar extraction, watchdog and persistence', { skip, timeout: 600_000 }, async t => {
  const root = await mkdtemp(join(process.env.DSH_NEO4J_MEMORY_TEST_TMPDIR || tmpdir(), 'dsh-neo4j-linux-runtime-'));
  const server = await serveArchive(archive);
  t.after(() => server.close());
  const jreServer = jreArchive ? await serveArchive(jreArchive, 'temurin-jre-test.tar.gz') : undefined;
  if (jreServer) t.after(() => jreServer.close());
  const java = process.env.DSH_NEO4J_MEMORY_JAVA || findJava();
  const keys = ['DSH_NEO4J_MEMORY_NEO4J_ARCHIVE_URL', 'DSH_NEO4J_MEMORY_NEO4J_ARCHIVE_SHA256', 'DSH_NEO4J_MEMORY_JRE_ARCHIVE_URL', 'DSH_NEO4J_MEMORY_JRE_ARCHIVE_SHA256', 'DSH_NEO4J_MEMORY_JAVA', 'PATH'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DSH_NEO4J_MEMORY_NEO4J_ARCHIVE_URL = server.url;
  process.env.DSH_NEO4J_MEMORY_NEO4J_ARCHIVE_SHA256 = await digest(archive);
  if (java) process.env.DSH_NEO4J_MEMORY_JAVA = java;
  if (jreServer) {
    process.env.DSH_NEO4J_MEMORY_JRE_ARCHIVE_URL = jreServer.url;
    process.env.DSH_NEO4J_MEMORY_JRE_ARCHIVE_SHA256 = await digest(jreArchive);
    delete process.env.DSH_NEO4J_MEMORY_JAVA;
    process.env.PATH = ''; // Exercise managed JRE provisioning with no system Java or tar.
  }
  t.after(async () => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  });

  const runtime = new LocalNeo4j(root);
  t.after(async () => { await runtime.stop().catch(() => {}); });
  const info = await runtime.ensure();
  assert.ok(await portOpen(info.port), 'managed Neo4j listens after provisioning');
  if (jreServer) assert.equal(await runtime.resolveJava(), join(root, 'jre'));
  assert.equal(await runtime.probe(), 'ready');
  assert.ok((await readdir(join(root, 'neo4j', 'bin'))).length > 0, 'distribution extracted with bin/');
  assert.ok(existsSync(join(root, 'downloads')), 'archive kept in the download cache');
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(state.port, info.port); assert.equal(state.neo4j, '5.26.30'); assert.ok(state.password);
  const status = await runtime.status();
  assert.equal(status.installed, true); assert.equal(status.running, true);

  // A second instance attaches to the running server and must not stop it.
  const attached = new LocalNeo4j(root);
  assert.equal((await attached.ensure()).port, info.port);
  assert.equal(attached.startedHere, false);
  await attached.stop();
  assert.ok(await portOpen(info.port), 'attaching instance leaves the server running');

  await runtime.stop();
  assert.ok(await waitClosed(info.port), 'watchdog stops Neo4j with the host');

  // Restarting reuses the extracted distribution and the stored password.
  const restarted = new LocalNeo4j(root);
  t.after(async () => { await restarted.stop().catch(() => {}); });
  const again = await restarted.ensure();
  assert.equal(again.password, info.password); assert.equal(again.port, info.port);
  assert.ok(await portOpen(again.port));
  await restarted.stop(); assert.ok(await waitClosed(again.port));

  // Persistent mode detaches; stopping validates the stored PID through /proc.
  const persistent = new LocalNeo4j(root);
  await persistent.startPersistent();
  assert.ok(await portOpen(info.port), 'persistent instance keeps running after ensure');
  await new LocalNeo4j(root).stopPersistent();
  assert.ok(await waitClosed(info.port), 'stopPersistent terminates the detached process');

  // Killing the host must let the watchdog stop Java.
  const host = spawn(process.execPath, ['tests/fixtures/runtime-host.mjs', root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (host.exitCode === null) host.kill('SIGKILL'); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('watchdog fixture startup timed out')), 120_000);
    host.once('error', error => { clearTimeout(timer); reject(error); });
    host.once('exit', code => { clearTimeout(timer); reject(new Error(`watchdog fixture exited: ${code}`)); });
    host.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).port); }
    });
  });
  assert.ok(await portOpen(port));
  host.kill('SIGKILL');
  assert.ok(await waitClosed(port), 'watchdog stops Java when the host is killed');
  assert.equal(server.requests(), 1, 'Neo4j archive is downloaded only once across restarts');
  if (jreServer) assert.equal(jreServer.requests(), 1, 'JRE archive is downloaded only once across restarts');
});
