/**
 * dsh-prompt-optimizer — host plugin body.
 *
 * Behaviour: on the first human message of a session, infer what the user is
 * trying to achieve from their personal profile, ask a model for two rewrites on
 * two fixed axes, let the user pick one, and enter the step with the chosen text
 * in place of what they typed. The rewrite happens at `agent/pre-step`, the same
 * seam the shipped session-reference plugin uses, so the chosen prompt is what
 * the model sees and what the session log records.
 *
 * Three deliberate properties:
 * - **Never blocks the turn.** Every failure — no profile, slow model, malformed
 *   JSON, a user who closes the card — falls back to the user's own prompt.
 * - **Idempotent.** A session marker plus turn-number gating means a hot reload
 *   or a resumed step cannot ask twice.
 * - **Observable.** Every decision is recorded as a notice the Web banner polls,
 *   so "what happened to my prompt" always has an answer.
 *
 * @module dsh-prompt-optimizer
 */
import { readFile } from 'node:fs/promises'
import { Config, MAX_SOURCE_BYTES, OptimizerState, expandPath, resolveConfig } from './config.js'
import { assemblePersona } from './persona.js'
import { optimizePrompt } from './optimizer.js'
import { renderComparison } from './prompt.js'
import { loadDeep, resolutionDiagnostics } from './resolve.js'

/**
 * The DSH LLM message surface, resolved at load time because the plugin's source
 * path is not under the DSH installation. `null` here is not fatal: every call
 * site degrades to "keep the user's own prompt".
 */
const llmMessage = await loadDeep('@deepseek-ai/dsh-llm', 'lib/types/message.js')
const llmDeps = {
  createUserMessage: llmMessage?.createUserMessage,
  freezeMessage: llmMessage?.freezeMessage
}

/** Services this plugin composes with; absence of a required one fails loud. */
export const inject = ['llm', 'userQuestions', 'commands', 'webServer']

/** HTTP routes owned by this plugin. */
export const STATE_PATH = '/api/prompt-optimizer/state'
export const TOGGLE_PATH = '/api/prompt-optimizer/toggle'
export const ACK_PATH = '/api/prompt-optimizer/ack'

/** Longest generator-loop depth before the plugin gives up and keeps the original. */
const MAX_REGENERATIONS = 3

/**
 * Whether one message is a human prompt this plugin may rewrite.
 * @param message - a message entering the step.
 * @returns true for a direct user message with text content.
 */
function isHumanPrompt(message) {
  return message?.source?.kind === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'text')
}

/**
 * Read the concatenated text blocks of one message.
 * @param message - the message to read.
 * @returns the joined text.
 */
function textOf(message) {
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Replace the text of a message while preserving its identity, ordering, and any
 * non-text blocks (images, files), which the optimizer never touches.
 * @param message - the original user message.
 * @param replacement - the new prompt text.
 * @param marker - a one-line provenance header prefixed to the replacement.
 * @returns a frozen replacement message with the same id.
 */
function rewriteMessage(message, replacement, marker) {
  let written = false
  const content = []
  for (const block of message.content) {
    if (block.type !== 'text' || written) {
      content.push(block)
      continue
    }
    content.push({ type: 'text', text: `${marker}\n\n${replacement}` })
    written = true
  }
  if (!written) content.unshift({ type: 'text', text: `${marker}\n\n${replacement}` })
  const rewritten = { ...message, content }
  // `freezeMessage` is the shipped freeze helper; without it, a plain object
  // still satisfies the loop's read-only contract, so the rewrite survives.
  return typeof llmDeps.freezeMessage === 'function' ? llmDeps.freezeMessage(rewritten) : rewritten
}

/**
 * Write one JSON response and end it.
 * @param res - the HTTP response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 * @returns nothing.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/**
 * Read and parse a JSON request body, bounded so a malformed client cannot
 * exhaust memory.
 * @param req - the HTTP request.
 * @param limitBytes - maximum accepted body size.
 * @returns the parsed value, or `null` when unusable.
 */
async function readJsonBody(req, limitBytes = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) return null
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Plugin body.
 * @param ctx - plugin context carrying the injected services.
 * @param rawConfig - untrusted plugin configuration.
 * @returns nothing.
 */
export async function apply(ctx, rawConfig = {}) {
  const config = { ...resolveConfig(rawConfig), logger: ctx.logger, maxSourceBytes: MAX_SOURCE_BYTES }
  const state = await new OptimizerState(ctx, config).load()
  if (typeof llmDeps.createUserMessage !== 'function') {
    ctx.logger?.warn?.(
      'prompt-optimizer: could not resolve the DSH LLM message module; first-prompt optimization will be skipped and the original prompt kept'
    )
  }

  /** Sessions whose first prompt this plugin has already considered. */
  const handled = new Set()
  /** Serializes the offer flow per session so an overlapping pre-step cannot double-offer. */
  const inFlight = new Map()
  /** Cached personal context per session, so a regenerate reuses the same profile read. */
  const contextCache = new Map()
  /**
   * Why the last prompt of each session was or was not optimized, newest last.
   *
   * The gate at the top of the listener returns before any notice is recorded, so
   * "the plugin decided not to look at my prompt" used to be indistinguishable
   * from "the plugin is not loaded at all" — the exact ambiguity behind a silent
   * no-op. These entries make `/optimize status` state the reason.
   */
  const diagnostics = []

  /**
   * Record one pre-step decision for `/optimize status`.
   * @param agent - the entering agent.
   * @param outcome - short machine-readable verdict.
   * @param facts - optional prompt length, turn, and step.
   * @returns nothing.
   */
  function noteDecision(agent, outcome, facts = {}) {
    diagnostics.push({
      at: Date.now(),
      sessionId: String(agent?.id ?? 'unknown'),
      outcome,
      turn: facts.turn,
      step: facts.step,
      chars: facts.chars
    })
    if (diagnostics.length > 12) diagnostics.splice(0, diagnostics.length - 12)
  }

  /**
   * Render the recent pre-step decisions for the status command.
   * @returns one indented line per decision, oldest first.
   */
  function renderDiagnostics() {
    if (diagnostics.length === 0) return ['  （本进程还没有收到任何首条提示词）']
    return diagnostics.map((entry) => {
      const clock = new Date(entry.at).toLocaleTimeString()
      const facts = [
        entry.turn === undefined ? null : `turn=${entry.turn}`,
        entry.step === undefined ? null : `step=${entry.step}`,
        entry.chars === undefined ? null : `${entry.chars} 字符`
      ].filter((part) => part !== null)
      const tail = facts.length > 0 ? `（${facts.join(', ')}）` : ''
      return `  ${clock}  ${entry.outcome}${tail}  [${entry.sessionId}]`
    })
  }

  /**
   * Run one offer flow per session at a time, replaying the settled result to
   * any overlapping caller. A waiting `agent/pre-step` and a hot-reloaded
   * listener can both reach the same first prompt; without this, the user would
   * be asked twice.
   * @param sessionId - the owning session identity.
   * @param factory - the work to run when this caller wins the race.
   * @returns whatever the winning call produced.
   */
  function withSessionLock(sessionId, factory) {
    const existing = inFlight.get(sessionId)
    if (existing !== undefined) return existing
    const promise = Promise.resolve()
      .then(factory)
      .finally(() => {
        inFlight.delete(sessionId)
      })
    inFlight.set(sessionId, promise)
    return promise
  }

  /**
   * Resolve the session working directory used for `{workspace}` expansion.
   * @param agent - the entering agent.
   * @returns an absolute directory path.
   */
  function workspaceOf(agent) {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  }

  /**
   * Load and cache the personal context for one session.
   * @param agent - the entering agent.
   * @returns the rendered context and contributing paths.
   */
  async function personaFor(agent) {
    const key = String(agent.id)
    const cached = contextCache.get(key)
    if (cached !== undefined) return cached
    const persona = await assemblePersona(config, workspaceOf(agent))
    contextCache.set(key, persona)
    return persona
  }

  /**
   * Record a notice for the Web banner and log it once.
   * @param kind - notice tone.
   * @param summary - one-line account.
   * @param detail - optional comparison text.
   * @param sessionId - the owning session.
   * @param extra - optional durable facts to persist with the notice.
   * @returns the recorded notice.
   */
  function notice(kind, summary, detail, sessionId, extra) {
    const recorded = state.recordChange(kind, summary, detail, sessionId, extra)
    if (kind === 'warn') ctx.logger?.warn?.(`prompt-optimizer: ${summary}`)
    return recorded
  }

  /**
   * Ask the human to choose among the offered variants.
   *
   * The call must go through *this plugin's* `ctx`, never `agent.ctx`. `agent.ctx`
   * is the Agent-scoped context, which does not carry the `userQuestions` seam, so
   * reaching for it there threw `cannot get property "userQuestions" without
   * inject` on every prompt and silently degraded to the original text — which is
   * why optimization looked like it never worked at all. The Agent-scoped
   * *dispatch* is still wanted, and that is exactly what the `agent` field in the
   * request is for: `ask()` routes the question to that agent's scope. This mirrors
   * the shipped `ask_user_question` tool
   * (`ctx.userQuestions.ask({ …, agent: exec.agent, signal })`).
   *
   * @param agent - the entering agent, passed for scope routing only.
   * @param analysis - normalized optimizer output.
   * @param rawPrompt - the original prompt text.
   * @param signal - the turn's cancellation signal.
   * @returns the chosen prompt text, a regenerate request, or null to keep the original.
   */
  async function askForChoice(agent, analysis, rawPrompt, signal) {
    const labelA = `A · ${analysis.A.title}`
    const labelB = `B · ${analysis.B.title}`
    const answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'prompt-variant',
          header: '提示词优化',
          question: '已根据你的个人情况推测意图并优化首条提示词，选择要使用的版本：',
          detail: renderComparison(analysis, rawPrompt),
          options: [
            { label: labelA, description: `最小曲解原意，补齐约束与验收标准。${analysis.A.rationale}` },
            { label: labelB, description: `显式目标/交付物/步骤/验收。${analysis.B.rationale}` },
            { label: '保持原话不变', description: '放弃本次优化，按你原本的提示词继续。' },
            { label: '重新生成两版', description: '换一种思路再优化一次。' }
          ]
        }
      ]
    })
    const item = answer?.answers?.find((entry) => entry.id === 'prompt-variant')
    if (item === undefined) return { kind: 'keep' }
    const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
    if (custom !== '') return { kind: 'use', variant: 'custom', title: '你的改写版', text: custom }
    const selected = Array.isArray(item.selected) ? item.selected[0] : undefined
    if (selected === labelA) return { kind: 'use', variant: 'A', title: analysis.A.title, text: analysis.A.prompt }
    if (selected === labelB) return { kind: 'use', variant: 'B', title: analysis.B.title, text: analysis.B.prompt }
    if (typeof selected === 'string' && selected.startsWith('重新生成')) return { kind: 'regenerate' }
    return { kind: 'keep' }
  }

  /**
   * Run the full offer flow for one prompt and produce the text to enter the step with.
   * @param agent - the entering agent.
   * @param rawPrompt - the original prompt text.
   * @param signal - the turn's cancellation signal.
   * @returns the chosen text plus a provenance label, or null when the prompt stays as typed.
   */
  async function runOffer(agent, rawPrompt, signal) {
    const sessionId = String(agent.id)
    const persona = await personaFor(agent)
    let lastFailure = null
    for (let attempt = 0; attempt < MAX_REGENERATIONS; attempt += 1) {
      const result = await optimizePrompt(ctx, config, persona.text, rawPrompt, workspaceOf(agent), signal, llmDeps)
      if (!result.ok) {
        lastFailure = result
        break
      }
      const choice = await askForChoice(agent, result.analysis, rawPrompt, signal)
      if (choice.kind === 'use') {
        return { text: choice.text, variant: choice.variant, title: choice.title, analysis: result.analysis }
      }
      if (choice.kind === 'keep') {
        noteDecision(agent, '已按你的选择保持原话不变', {})
        notice('muted', '已按你的选择保持原话不变', '', sessionId)
        return null
      }
    }
    // The failure message travels with the summary because a collapsed notice has
    // no way to reveal `detail`: the banner folds any notice this mount did not
    // watch arrive, so a shape failure that already burned its retry would
    // otherwise read as a bare code with no evidence attached.
    const reason =
      lastFailure === null
        ? `已连续重新生成 ${MAX_REGENERATIONS} 次仍未采纳，本次按原话继续`
        : `优化失败（${lastFailure.code}），已按原话继续：${lastFailure.message}`
    noteDecision(
      agent,
      lastFailure === null ? `优化放弃：连续重新生成 ${MAX_REGENERATIONS} 次未采纳` : `优化失败：${lastFailure.code}`,
      {}
    )
    notice('warn', reason, lastFailure === null ? '' : lastFailure.message, sessionId, lastFailure === null ? undefined : { failure: lastFailure.code })
    return null
  }

  ctx.effect(
    () =>
      ctx.on(
        'agent/pre-step',
        async ({ agent, messages, turn, step, signal }, next) => {
          const sessionId = String(agent.id)
          const decision = await next()
          if (decision.kind === 'reject') return decision
          if (turn !== 1) {
            noteDecision(agent, `跳过：只优化会话首条提示词（本条是第 ${turn} 轮）`, { turn, step })
            return decision
          }
          if (handled.has(sessionId)) {
            noteDecision(agent, '跳过：本会话的首条提示词已经判定过', { turn, step })
            return decision
          }
          const index = decision.messages.findIndex(isHumanPrompt)
          if (index === -1) {
            noteDecision(agent, '跳过：这一步没有承载人类文本消息', { turn, step })
            return decision
          }
          // `once` is an explicit one-shot arm from `/optimize once`; it overrides
          // the durable toggle for exactly one session.
          const armedOnce = state.pendingOnce ? state.consumeOnce() : false
          if (!state.enabled && !armedOnce) {
            noteDecision(agent, '跳过：提示词优化开关是关闭的（可用 /optimize on 开启）', { turn, step })
            return decision
          }
          const target = decision.messages[index]
          const raw = textOf(target)
          const rawLength = raw.trim().length
          try {
            const chosen = await withSessionLock(sessionId, async () => {
              if (rawLength < config.minPromptChars) {
                noteDecision(agent, `跳过：提示词短于 ${config.minPromptChars} 字符`, { turn, step, chars: rawLength })
                notice('muted', `提示词过短（${rawLength} 字符），未优化`, '', sessionId)
                return null
              }
              noteDecision(agent, '进入优化流程', { turn, step, chars: rawLength })
              return runOffer(agent, raw, signal)
            })
            // Marked handled only once the prompt was actually considered, so a
            // session skipped while disabled can still be optimized after `/optimize on`.
            handled.add(sessionId)
            if (chosen === null) return decision
            const marker =
              chosen.variant === 'custom'
                ? '<!-- prompt-optimizer: 由你改写的版本 -->'
                : `<!-- prompt-optimizer: 已按 ${chosen.variant} 版《${chosen.title}》优化 -->`
            const rewritten = decision.messages.slice()
            rewritten[index] = rewriteMessage(target, chosen.text, marker)
            notice(
              'success',
              chosen.variant === 'custom'
                ? `首条提示词已按你的改写版替换（${chosen.text.length} 字符）`
                : `首条提示词已优化 → 采用 ${chosen.variant} 版《${chosen.title}》`,
              renderComparison(chosen.analysis, raw),
              sessionId,
              { variant: chosen.variant, original: config.keepOriginal ? raw : undefined }
            )
            return { ...decision, messages: rewritten }
          } catch (error) {
            handled.add(sessionId)
            noteDecision(agent, `优化过程抛出异常：${error instanceof Error ? error.message : String(error)}`, {})
            notice('warn', '优化过程出错，已按原话继续', error instanceof Error ? error.message : String(error), sessionId)
            return decision
          }
        },
        { prepend: true }
      ),
    'prompt-optimizer: pre-step listener'
  )

  ctx.effect(
    () => {
      const disposers = []
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: STATE_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
            const loaded = [...contextCache.values()].flatMap((entry) => entry.loaded)
            const configured = (config.personaFiles ?? []).map((file) => expandPath(file, undefined))
            sendJson(res, 200, state.snapshot(loaded.length > 0 ? loaded : configured))
          }
        })
      )
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: TOGGLE_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
            const body = await readJsonBody(req)
            if (body === null || typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'expected {"enabled": boolean}' })
            const enabled = await state.setEnabled(body.enabled)
            notice('info', enabled ? '提示词优化已开启' : '提示词优化已关闭', '', null)
            const configured = (config.personaFiles ?? []).map((file) => expandPath(file, undefined))
            sendJson(res, 200, state.snapshot(configured))
          }
        })
      )
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: ACK_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
            const body = await readJsonBody(req)
            if (body === null) return sendJson(res, 400, { error: 'invalid body' })
            state.ack(body.at)
            sendJson(res, 200, { ok: true })
          }
        })
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'prompt-optimizer: web routes'
  )

  ctx.effect(
    () => {
      const disposers = []
      disposers.push(
        ctx.commands.register({
          name: 'optimize',
          description: '首条提示词优化开关（on / off / once / status）',
          input: { hint: 'on | off | once | status' },
          handler: async ({ rawInput }) => {
            const action = String(rawInput ?? '').trim().toLowerCase()
            if (action === 'off') {
              await state.setEnabled(false)
              notice('info', '提示词优化已关闭', '', null)
              return { kind: 'success', text: '提示词优化：已关闭（新会话的首条提示词不再被优化）' }
            }
            if (action === 'on') {
              await state.setEnabled(true)
              notice('info', '提示词优化已开启', '', null)
              return { kind: 'success', text: '提示词优化：已开启' }
            }
            if (action === 'once') {
              state.armOnce()
              notice('info', '已设定：仅下一条首条提示词优化一次', '', null)
              return { kind: 'success', text: '提示词优化：仅对下一条首条提示词生效一次' }
            }
            if (action === 'diag') {
              return { kind: 'success', text: ['prompt-optimizer 依赖解析诊断：', ...resolutionDiagnostics()].join('\n') }
            }
            if (action === '' || action === 'status') {
              const workspace = process.cwd()
              const configured = (config.personaFiles ?? []).map((file) => expandPath(file, workspace))
              const introspected = []
              for (const file of configured) {
                try {
                  await readFile(file, 'utf8')
                  introspected.push(`✓ ${file}`)
                } catch {
                  introspected.push(`✗ ${file}（未找到）`)
                }
              }
              return {
                kind: 'success',
                text: [
                  `提示词优化：${state.enabled ? '已开启' : '已关闭'}${state.pendingOnce ? '（已设定仅一次）' : ''}`,
                  `路由：${config.provider} / ${config.model}`,
                  `画像文件：`,
                  ...introspected,
                  '首条提示词判定（最近 12 条，本进程）：',
                  ...renderDiagnostics(),
                  '依赖解析（/optimize diag 可看完整）：',
                  ...resolutionDiagnostics().slice(-4)
                ].join('\n')
              }
            }
            return { kind: 'error', text: `未知参数「${action}」，可用：on / off / once / status / diag` }
          }
        })
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'prompt-optimizer: commands'
  )

  ctx.logger?.info?.(`prompt-optimizer: ready (enabled=${state.enabled}, route=${config.provider}/${config.model})`)
}
