/**
 * Host dependency resolution for the host-side plugin module.
 *
 * `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` are optional peers: a desktop
 * profile with `autoInstallPeers: false` never installs them, so a bare `import` at the top of
 * index.js can fail and take the whole plugin entry down ("entry did not activate ... failed to
 * import") instead of failing one feature.
 *
 * Order of attempts:
 *   1. a real file inside the host's own module tree (same copy the host runs);
 *   2. a bare dynamic import, which the host loader may resolve even when nothing is on disk;
 *   3. a local fallback: schemastery falls back to "no Config" (plugin still loads, the settings
 *      page degrades), dsh-tools falls back to a minimal defineTool that only converts the
 *      parameter spec to JSON Schema and validates it.
 *
 * Nothing here reads credentials or memory data, and no failure throws at module scope.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), 'node_modules', '@deepseek-ai')

/** Places that may hold the host's own `@deepseek-ai` packages, most likely first. */
export function candidateRoots() {
  const roots = []
  const push = (path) => { if (path && !roots.includes(path)) roots.push(path) }
  push(process.env.DSH_HOST_MODULES)

  const appData = process.env.APPDATA
  if (appData) {
    const npm = join(appData, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const entry of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', entry, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* nothing installed there */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const profile of readdirSync(join(home, 'profiles'))) {
      push(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* no profiles yet */ }

  push(SELF_MODULES)
  return roots
}

/** Entry URL for `root/<name>` using the package's own exports map. */
function entryUrlFor(root, name) {
  try {
    const directory = join(root, name)
    const manifest = join(directory, 'package.json')
    if (!existsSync(manifest)) return null
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const dot = pkg.exports?.['.']
    const relative = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!relative) return null
    const file = join(directory, String(relative).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

async function fromHostTree(name, note) {
  const failures = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue // the plugin's own copy is handled by the bare import below
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const module = await import(url)
      note(`${name}: loaded from the host tree`)
      return module
    } catch (error) {
      failures.push(`${error?.code || 'ERR'}@${root}`)
    }
  }
  if (failures.length) note(`${name}: not usable from the host tree (${failures.slice(0, 3).join(' ')})`)
  return null
}

const PARAMETER_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

function parameterSchema(name, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`defineTool: parameter ${name} must be an object`)
  if (!PARAMETER_TYPES.has(spec.type)) throw new Error(`defineTool: parameter ${name} has no valid type`)
  const schema = { type: spec.type }
  if (typeof spec.description === 'string') schema.description = spec.description
  if (Array.isArray(spec.enum)) schema.enum = [...spec.enum]
  if (spec.type === 'array') schema.items = spec.items ?? { type: 'string' }
  return schema
}

/**
 * Fallback for `defineTool` when dsh-tools cannot be resolved.
 * dsh-tools accepts a spec with per-parameter `required` flags and converts it to JSON Schema;
 * the tool registry consumes the converted form, so the fallback returns that shape directly.
 */
export function localDefineTool(options) {
  if (!options || typeof options.name !== 'string' || !options.name) throw new Error('defineTool: name is required')
  if (typeof options.execute !== 'function') throw new Error(`defineTool(${options.name}): execute must be a function`)
  const spec = options.parameters || {}
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`defineTool(${options.name}): parameters must be an object`)

  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    properties[key] = parameterSchema(key, value)
    if (value.required === true) required.push(key)
  }
  const parameters = { type: 'object', properties, additionalProperties: false }
  if (required.length) parameters.required = required
  return { ...options, parameters }
}

/**
 * @returns {Promise<{ z: any, defineTool: Function, notes: string[] }>}
 */
export async function loadHostDeps() {
  const notes = []
  const note = (message) => notes.push(message)

  let schemaModule = await fromHostTree('schemastery', note)
  if (!schemaModule) {
    try {
      schemaModule = await import('@deepseek-ai/schemastery')
      note('schemastery: loaded through the host loader')
    } catch (error) {
      note(`schemastery: unavailable (${error?.code || ''} ${String(error?.message || '').slice(0, 120)}) — plugin loads without Config; the settings page degrades to read-only keys`)
    }
  }
  const z = schemaModule?.default ?? schemaModule ?? null

  let toolsModule = await fromHostTree('dsh-tools', note)
  if (!toolsModule) {
    try {
      toolsModule = await import('@deepseek-ai/dsh-tools')
      note('dsh-tools: loaded through the host loader')
    } catch (error) {
      note(`dsh-tools: unavailable (${error?.code || ''}) — using the local defineTool fallback`)
    }
  }
  const defineTool = toolsModule?.defineTool || ((options) => localDefineTool(options))

  return { z, defineTool, notes }
}
