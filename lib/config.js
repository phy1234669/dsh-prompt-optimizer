/**
 * dsh-prompt-optimizer — configuration schema, durable toggle state, and the
 * shared change-notice record.
 *
 * The plugin has two surfaces that must agree on one truth: the host plugin
 * (which decides whether a first prompt is optimized) and the browser toggle
 * (which displays and flips that decision). This module owns the single source
 * of truth — the `enabled` flag — and persists it so a page reload, a host
 * restart, and a headless run all read the same answer. The in-memory notice
 * record is what the Web banner polls; it is deliberately not persisted, since
 * a notice describes an event in this process, not a durable fact.
 *
 * @module dsh-prompt-optimizer/config
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { loadPackage } from './resolve.js'

/**
 * The schemastery validator, or `null` when it could not be resolved — in which
 * case the mirrored defaults below keep the plugin fully functional. Validation
 * is a convenience here, never a load-bearing dependency.
 */
const Schema = (() => {
  const candidate = loadPackage('@deepseek-ai/schemastery')
  return typeof candidate?.object === 'function' ? candidate : null
})()
/** Per-file read bound applied to each persona candidate, in bytes. */
export const MAX_SOURCE_BYTES = 262144

/** Bound on the comparison text retained for one change notice, in characters. */
export const MAX_DETAIL_CHARS = 12000

/** Bound on the one-line summary retained for one change notice, in characters. */
export const MAX_SUMMARY_CHARS = 240

/** Shipped defaults, mirrored by the schema below and used when schemastery is unavailable. */
const DEFAULTS = Object.freeze({
  enabled: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  // The response contract carries two complete rewritten prompts plus the
  // intent paragraph, and the model spends 1300-1800 tokens on an ordinary
  // Chinese prompt. At 2400 a wordier answer is cut mid-JSON, which the parser
  // can only report as BAD_JSON; the headroom below keeps a full answer inside
  // the cap while staying far under the route's context window.
  maxOutputTokens: 6000,
  timeoutMs: 60000,
  maxInputBytes: 24000,
  maxContextBytes: 16000,
  personaFiles: ['~/.dsh/AGENTS.md', '{workspace}/AGENTS.md', '{workspace}/dsh-prompt-optimizer/persona.md'],
  minPromptChars: 15,
  keepOriginal: true,
  stateFile: '~/.dsh/prompt-optimizer.json'
})

/**
 * Validate one raw configuration, falling back to the mirrored defaults when
 * schemastery could not be resolved. Validation never throws into plugin load:
 * a malformed value degrades to its default rather than taking the profile down.
 * @param rawConfig - untrusted plugin configuration.
 * @returns an immutable configuration with every field present.
 */
export function resolveConfig(rawConfig) {
  const raw = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  if (Schema !== null) {
    try {
      return Object.freeze({ ...DEFAULTS, ...Config(raw) })
    } catch (error) {
      // Fall through to the structural merge below.
      void error
    }
  }
  const merged = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key]
    if (typeof value === typeof fallback || (Array.isArray(fallback) && Array.isArray(value))) merged[key] = value
  }
  return Object.freeze(merged)
}

/**
 * Accepted plugin configuration. Every field is optional; the schema supplies
 * the shipped default so a profile patch may name the row with no config at all.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-prompt-optimizer',
    validate(value) {
      return { value: resolveConfig(value) }
    }
  }
}

/**
 * The schemastery-backed schema, exported for documentation and tooling. The
 * loader-facing {@link Config} stays schemastery-free so plugin load cannot fail
 * on a dependency-resolution problem.
 */
export const ConfigSchema =
  Schema === null
    ? null
    : Schema.object({
        /** Master switch at host startup; the durable toggle state overrides it once written. */
        enabled: Schema.boolean().default(DEFAULTS.enabled),
        /** Registered provider route for the auxiliary optimization request. */
        provider: Schema.string().default(DEFAULTS.provider),
        /** Model id for the auxiliary optimization request. */
        model: Schema.string().default(DEFAULTS.model),
        /** Reasoning effort for the auxiliary request; low effort keeps latency down. */
        reasoningEffort: Schema.string().default(DEFAULTS.reasoningEffort),
        /** Output-token cap for the auxiliary optimization request. */
        maxOutputTokens: Schema.number().default(DEFAULTS.maxOutputTokens),
        /** End-to-end deadline for the auxiliary optimization request, in milliseconds. */
        timeoutMs: Schema.number().default(DEFAULTS.timeoutMs),
        /** Maximum UTF-8 bytes sent to the optimizer, including the personal context. */
        maxInputBytes: Schema.number().default(DEFAULTS.maxInputBytes),
        /** Maximum UTF-8 bytes of personal context injected into the optimizer prompt. */
        maxContextBytes: Schema.number().default(DEFAULTS.maxContextBytes),
        /**
         * Personal-profile files, most specific last. `~` and `{workspace}` are
         * expanded, and a missing file is skipped rather than failing the run.
         */
        personaFiles: Schema.array(Schema.string()).default([...DEFAULTS.personaFiles]),
        /** Prompts shorter than this many characters are left untouched. */
        minPromptChars: Schema.number().default(DEFAULTS.minPromptChars),
        /** Retain the original prompt text in the change history for auditing. */
        keepOriginal: Schema.boolean().default(DEFAULTS.keepOriginal),
        /** Durable toggle/state file; `~` is expanded. */
        stateFile: Schema.string().default(DEFAULTS.stateFile)
      })

/** Bound on the change history attached to one state response, newest last. */
export const SNAPSHOT_HISTORY = 12

/**
 * Expand `~` and `{workspace}` in one configured path.
 * @param value - the configured path or path template.
 * @param workspace - the session working directory substituted for `{workspace}`.
 * @returns an absolute path suitable for the filesystem.
 */
export function expandPath(value, workspace) {
  let out = String(value)
  if (out === '~') out = homedir()
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(homedir(), out.slice(2))
  if (workspace !== undefined && workspace.length > 0) out = out.replaceAll('{workspace}', workspace)
  return out
}

/**
 * Clamp one string to a character bound, appending an ellipsis marker when cut.
 * @param value - the raw text.
 * @param max - the maximum retained character count.
 * @returns the bounded text.
 */
function clamp(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

/**
 * The durable slice of plugin state: the toggle and the audit trail.
 * Written through a temp-file rename so a crash mid-write cannot corrupt it.
 */
export class OptimizerState {
  /**
   * @param ctx - plugin context used for logging.
   * @param config - validated plugin configuration.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.path = expandPath(config.stateFile, undefined)
    /** Whether first-prompt optimization is active; the durable toggle. */
    this.enabled = config.enabled !== false
    /** One-shot arm set by `/optimize once`; consumed by the next session's first prompt. */
    this.pendingOnce = false
    /** Most recent change notice, polled by the Web banner. Never persisted. */
    this.lastChange = null
    /** Monotone revision bumped on every observable change. */
    this.revision = 0
    /** Durable change history, newest last, bounded by the host. */
    this.history = []
    /** Tail of the serialized write chain, so overlapping saves cannot race. */
    this.writeChain = Promise.resolve()
  }

  /**
   * Load the durable file, tolerating absence and corruption.
   * @returns this instance, for chaining during plugin startup.
   */
  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        if (typeof parsed.enabled === 'boolean') this.enabled = parsed.enabled
        if (Array.isArray(parsed.history)) this.history = parsed.history.slice(-50)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.ctx.logger?.warn(`prompt-optimizer: could not read ${this.path}: ${String(error)}`)
      }
    }
    return this
  }

  /**
   * Persist the durable slice, serialized against earlier writes. Never throws
   * into the caller's turn: a failed write is logged and the in-memory state
   * stays authoritative for this process.
   *
   * Writes are chained rather than concurrent because several notices can be
   * recorded in one tick (an optimization completing while the toggle flips),
   * and two overlapping temp-file renames would race on the same target.
   *
   * @returns a promise settling when this write has finished.
   */
  async save() {
    const previous = this.writeChain
    const next = previous.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true })
        const payload = JSON.stringify(
          {
            version: 1,
            enabled: this.enabled,
            updatedAt: new Date().toISOString(),
            history: this.history.slice(-50)
          },
          null,
          2
        )
        const tmp = `${this.path}.tmp`
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, this.path)
      } catch (error) {
        this.ctx.logger?.warn(`prompt-optimizer: could not write ${this.path}: ${String(error)}`)
      }
    })
    this.writeChain = next.catch(() => {})
    return next
  }

  /**
   * Read the state the Web toggle polls.
   *
   * The `history` tail is the answer to "what happened to my prompt?" after the
   * fact. It is attached to every response because the live `lastChange` is only
   * ever the newest decision: skipped and failed prompts both also land in the
   * history, and without it a mount that arrived late (or a Host restarted in
   * between) has no way to read what it missed.
   *
   * @param personaLoaded - profile files that contributed context, for display.
   * @returns a detached JSON-safe snapshot.
   */
  snapshot(personaLoaded) {
    return {
      enabled: this.enabled,
      pendingOnce: this.pendingOnce,
      personaLoaded: Array.isArray(personaLoaded) ? personaLoaded : [],
      lastChange: this.lastChange,
      history: this.history.slice(-SNAPSHOT_HISTORY),
      revision: this.revision
    }
  }

  /**
   * Flip the durable toggle.
   * @param enabled - the requested state.
   * @returns the new state.
   */
  async setEnabled(enabled) {
    this.enabled = enabled === true
    this.pendingOnce = false
    await this.save()
    return this.enabled
  }

  /**
   * Arm a single optimization for the next session's first prompt.
   * @returns nothing.
   */
  armOnce() {
    this.pendingOnce = true
  }

  /**
   * Consume the one-shot arm, if any.
   * @returns whether this session should optimize because of `/optimize once`.
   */
  consumeOnce() {
    if (!this.pendingOnce) return false
    this.pendingOnce = false
    return true
  }

  /**
   * Record one change for the Web banner and the audit trail.
   *
   * Every decision is persisted, not only the rewrites. Skipping a prompt and
   * failing to optimize one are the two events a user most needs to read back
   * later, and keeping them in memory alone meant a Host restart erased the
   * answer while the state file still claimed an older story. Writes are
   * serialized and these events are human-paced, so the extra durability is
   * cheap next to the diagnostic value.
   *
   * @param kind - notice tone: `info`, `success`, `warn`, or `muted`.
   * @param summary - the one-line account shown in the banner.
   * @param detail - optional longer comparison text revealed on demand.
   * @param sessionId - the session the change belongs to.
   * @param extra - optional durable facts recorded beside the notice.
   * @returns the recorded notice.
   */
  recordChange(kind, summary, detail, sessionId, extra) {
    const notice = {
      kind,
      summary: clamp(summary, MAX_SUMMARY_CHARS),
      detail: detail === undefined || detail === null || detail === '' ? '' : clamp(String(detail), MAX_DETAIL_CHARS),
      at: Date.now(),
      sessionId: sessionId === undefined ? null : String(sessionId)
    }
    this.lastChange = notice
    this.revision += 1
    this.history.push({ ...notice, ...(extra ?? {}) })
    if (this.history.length > 50) this.history = this.history.slice(-50)
    void this.save()
    return notice
  }

  /**
   * Mark the current notice as seen so a freshly loaded page does not replay it.
   * @param at - the notice timestamp the client observed.
   * @returns whether the acknowledged notice was still the newest one.
   */
  ack(at) {
    const stamp = Number(at)
    if (!Number.isFinite(stamp)) return false
    if (this.lastChange !== null && this.lastChange.at <= stamp) {
      this.lastChange = null
      this.revision += 1
      return true
    }
    return false
  }
}
