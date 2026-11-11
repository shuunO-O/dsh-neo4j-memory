import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A temporary data root for a managed Neo4j instance. Neo4j splits its startup
 * command line on whitespace, so Linux tests must not place the runtime under a
 * checkout path that contains spaces.
 */
export async function scratchRoot(prefix) {
  const configured = process.env.DSH_NEO4J_MEMORY_TEST_TMPDIR;
  if (!configured && process.platform === 'win32') {
    await mkdir(join(process.cwd(), 'tmp'), { recursive: true });
    return mkdtemp(join(process.cwd(), 'tmp', prefix));
  }
  const base = configured || tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}

/**
 * Copy a locally extracted Neo4j distribution into a test data root so integration
 * tests can run without the managed-runtime download (restricted networks, CI).
 */
export async function seedRuntime(root) {
  const source = process.env.DSH_NEO4J_MEMORY_TEST_NEO4J_HOME;
  if (!source) return false;
  await cp(source, join(root, 'neo4j'), { recursive: true });
  const java = process.env.DSH_NEO4J_MEMORY_TEST_JAVA;
  if (java && !process.env.DSH_NEO4J_MEMORY_JAVA) process.env.DSH_NEO4J_MEMORY_JAVA = java;
  return true;
}
