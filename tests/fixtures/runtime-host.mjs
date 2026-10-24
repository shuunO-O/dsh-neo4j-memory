import { LocalNeo4j } from '../../lib/runtime.js';
const runtime = new LocalNeo4j(process.argv[2]);
try {
  const info = await runtime.ensure();
  console.log(JSON.stringify({ port: info.port }));
  // Keep the host alive; the parent test kills it to verify watchdog cleanup.
  setInterval(() => {}, 1000);
} catch (error) { console.error(error.name); process.exitCode = 1; }
