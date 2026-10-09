/**
 * dsh-prompt-optimizer — dependency resolution that survives its own location.
 *
 * The plugin's source lives in the session workspace, which is typically on a
 * different Windows drive than the DSH installation. Node resolves bare
 * specifiers by walking up from the *real* file path, so neither the workspace
 * tree nor a junction can reach `@deepseek-ai/dsh-llm` on its own.
 *
 * Three facts drive this module:
 * - `createRequire` against the profile manifest always resolves DSH packages,
 *   because the profile's `node_modules` re-exports the shipped install. That
 *   makes it the reliable *locator*, and `require.resolve` gives an absolute
 *   entry path.
 * - `createRequire` reads only CJS `module.exports`, which for an ESM-only
 *   package exposes the default export alone. Named exports require `import()`.
 * - This package's own exports map does not expose its internal modules, so the
 *   entry is resolved as a *file URL* rather than as a subpath specifier.
 *
 * @module dsh-prompt-optimizer/resolve
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This module's directory, used as the nearest resolution anchor. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Cache of resolved values and the diagnostics behind any failure. */
const cache = new Map()

/** Human-readable record of every anchor / subpath probe, for /optimize status. */
const diagnostics = []

/**
 * Anchors tried in order: the profile that links this plugin first (it always
 * resolves DSH packages), then this module, then the global install, then the
 * process working directory.
 * @returns absolute paths usable as `createRequire` anchors.
 */
export function anchors() {
  const list = []
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE_DIR
  if (typeof profile === 'string' && profile.length > 0) list.push(join(profile, 'package.json'))
  for (const name of ['web', 'headless', 'sdk', 'acp', 'tui']) {
    list.push(join(home, 'profiles', name, 'package.json'))
  }
  list.push(join(home, 'profiles', 'node_modules', 'package.json'))
  list.push(join(HERE, 'package.json'))
  list.push(join(process.cwd(), 'package.json'))
  return list
}

/**
 * Locate one package root directory by resolving a path inside it. Using
 * `<pkg>/package.json` is the one subpath every published package exposes.
 * @param specifier - bare package name.
 * @returns the package root directory, or `null`.
 */
export function resolvePackageRoot(specifier) {
  for (const anchor of anchors()) {
    try {
      const manifest = createRequire(anchor).resolve(`${specifier}/package.json`)
      diagnostics.push(`root ${specifier} via ${anchor} -> ${manifest}`)
      return dirname(manifest)
    } catch (error) {
      diagnostics.push(`root ${specifier} via ${anchor} -> ${error?.code ?? error?.message}`)
    }
  }
  return null
}

/**
 * Resolve one file inside a package by its exports subpath, e.g. `./message`.
 * @param specifier - bare package name.
 * @param subpath - the exports key, defaulting to the package root.
 * @returns an absolute file path, or `null`.
 */
export function resolveSubpath(specifier, subpath = '.') {
  const spec = subpath === '.' ? specifier : `${specifier}/${subpath.replace(/^\.\//, '')}`
  for (const anchor of anchors()) {
    try {
      return createRequire(anchor).resolve(spec)
    } catch (error) {
      diagnostics.push(`sub ${spec} via ${anchor} -> ${error?.code ?? error?.message}`)
    }
  }
  return null
}

/**
 * Import one file path, caching the namespace including failures.
 * @param key - cache key.
 * @param entry - absolute file path, or `null`.
 * @returns the module namespace, or `null` with the reason recorded.
 */
async function importEntry(key, entry) {
  if (cache.has(key)) return cache.get(key)
  if (entry === null) {
    diagnostics.push(`import ${key} -> no entry resolved`)
    cache.set(key, null)
    return null
  }
  try {
    const namespace = await import(pathToFileURL(entry).href)
    cache.set(key, namespace)
    return namespace
  } catch (error) {
    diagnostics.push(`import ${key} from ${entry} -> ${error?.message}`)
    cache.set(key, null)
    return null
  }
}

/**
 * Load one deep module path from a package, e.g.
 * `loadDeep('@deepseek-ai/dsh-llm', 'lib/types/message.js')`.
 *
 * The deep path is joined onto the resolved package root, which bypasses the
 * package's own exports map — necessary for the internal modules this plugin
 * needs, and stable because it is what the shipped build emits.
 *
 * @param specifier - bare package name.
 * @param relative - path inside the package.
 * @returns the module namespace, or `null`.
 */
export async function loadDeep(specifier, relative) {
  const key = `${specifier}/${relative}`
  if (cache.has(key)) return cache.get(key)
  const root = resolvePackageRoot(specifier)
  return importEntry(key, root === null ? null : join(root, relative))
}

/**
 * Load one package subpath through its declared exports map.
 * @param specifier - bare package name.
 * @param subpath - exports key such as `./message`.
 * @returns the module namespace, or `null`.
 */
export async function loadSubpath(specifier, subpath) {
  const key = `${specifier}${subpath}`
  if (cache.has(key)) return cache.get(key)
  return importEntry(key, resolveSubpath(specifier, subpath))
}

/**
 * Resolve one package's public entry to a file path.
 * @param specifier - bare package name.
 * @returns an absolute file path, or `null`.
 */
export function resolveEntry(specifier) {
  return resolveSubpath(specifier, '.')
}

/**
 * Synchronous best-effort load, for packages consumed through their CJS face.
 * @param specifier - bare package name.
 * @returns the default export when present, else the namespace.
 */
export function loadPackage(specifier) {
  if (cache.has(specifier)) return cache.get(specifier)
  const entry = resolveEntry(specifier)
  if (entry === null) {
    cache.set(specifier, null)
    return null
  }
  try {
    const required = createRequire(entry)(specifier)
    const value = required?.default ?? required
    cache.set(specifier, value)
    return value
  } catch (error) {
    diagnostics.push(`require ${specifier} -> ${error?.message}`)
    cache.set(specifier, null)
    return null
  }
}

/**
 * The probe log behind the last resolution attempts, newest last.
 * @returns up to 40 diagnostic lines.
 */
export function resolutionDiagnostics() {
  return diagnostics.slice(-40)
}
