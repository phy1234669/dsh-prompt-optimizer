/**
 * dsh-prompt-optimizer — personal-context assembly.
 *
 * The optimizer can only infer what you want if it knows who you are and what
 * you are working on. That knowledge lives in ordinary files you already
 * maintain, not in a bespoke database: a user-global `AGENTS.md`, the
 * workspace's own `AGENTS.md`, and an optional profile file you write for this
 * plugin. This module reads that chain broad-to-specific, skips absent files
 * silently, collapses byte-identical duplicates, and bounds the result so a
 * pathological file can never blow the optimizer's input budget.
 *
 * @module dsh-prompt-optimizer/persona
 */
import { readFile } from 'node:fs/promises'
import { expandPath } from './config.js'

/** Bytes that count as a duplicate after trimming, matching the instructions plugin. */
function normalizeForDuplicate(text) {
  return text.trim()
}

/**
 * Read one candidate file, treating absence and unreadable paths as "no layer".
 * @param path - absolute path to read.
 * @param maxBytes - per-file read cap; `undefined` reads the whole file.
 * @param logger - optional logger for non-ENOENT diagnostics.
 * @returns the file text, or `null` when it contributes nothing.
 */
async function readCandidate(path, maxBytes, logger) {
  try {
    const raw = await readFile(path, 'utf8')
    if (raw.trim() === '') return null
    return raw
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') {
      logger?.warn?.(`prompt-optimizer: could not read persona file ${path}: ${String(error)}`)
    }
    return null
  }
}

/**
 * Assemble the personal-context block for one session.
 *
 * Layers are read in configured order — broad to specific — and the budget is
 * spent most-specific-first, so an oversized global file is dropped before the
 * profile file you wrote for this plugin is truncated: the same precedence the
 * workspace-instruction loader uses.
 *
 * @param config - validated plugin configuration.
 * @param workspace - the session working directory, substituted for `{workspace}`.
 * @returns the rendered context, the contributing paths, and any omitted paths.
 */
export async function assemblePersona(config, workspace) {
  const logger = config.logger
  const candidates = Array.isArray(config.personaFiles) ? config.personaFiles : []
  /** @type {{path: string, text: string}[]} */
  const layers = []
  /** @type {string[]} */
  const omitted = []
  const seen = new Set()

  for (const template of candidates) {
    const path = expandPath(template, workspace)
    const text = await readCandidate(path, config.maxSourceBytes, logger)
    if (text === null) continue
    const key = normalizeForDuplicate(text)
    if (seen.has(key)) {
      omitted.push(path)
      continue
    }
    seen.add(key)
    layers.push({ path, text })
  }

  if (layers.length === 0) {
    return { text: '', loaded: [], omitted }
  }

  // Spend the byte budget from the most specific layer backwards, then render in
  // broad-to-specific order so the narrowest guidance is what the model reads last.
  const budget = Number.isFinite(config.maxContextBytes) && config.maxContextBytes > 0 ? config.maxContextBytes : 16000
  const kept = []
  let used = 0
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]
    const size = Buffer.byteLength(layer.text, 'utf8')
    if (used + size <= budget) {
      kept.unshift(layer)
      used += size
      continue
    }
    const remaining = budget - used
    if (remaining > 512) {
      const truncated = Buffer.from(layer.text, 'utf8').subarray(0, remaining).toString('utf8')
      kept.unshift({ path: layer.path, text: `${truncated}\n…[truncated by prompt-optimizer budget]` })
      used = budget
    } else {
      omitted.push(layer.path)
    }
  }

  const rendered = kept
    .map((layer) => `### Instructions from: ${layer.path}\n\n${layer.text.trim()}`)
    .join('\n\n')
  return { text: rendered, loaded: kept.map((layer) => layer.path), omitted }
}
