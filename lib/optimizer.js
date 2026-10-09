/**
 * dsh-prompt-optimizer — the auxiliary optimization call.
 *
 * This is a hand-built one-shot request over `ctx.llm`, the same shape the
 * shipped session-title plugin uses: a fixed provider route, a bounded output,
 * a hard deadline, and a text-only reply. Every failure path here is designed
 * to be survivable — the caller falls back to the user's own prompt rather than
 * blocking the turn, so a flaky auxiliary model can never hold a session
 * hostage.
 *
 * @module dsh-prompt-optimizer/optimizer
 */
import { VARIANT_A, VARIANT_B, buildSystemPrompt, buildUserPrompt } from './prompt.js'

/** Plugin identity stamped on every auxiliary request message. */
const PLUGIN_ID = 'dsh-prompt-optimizer'

/**
 * Extra attempts granted when the optimizer answers with unusable text.
 *
 * A shape failure is ordinary sampling noise, not a broken request: the model
 * occasionally fences its JSON, renames the variant keys, or stops early. One
 * fresh sample clears the overwhelming majority of those, and this is a text
 * call the user never waits on beyond its own deadline, so the retry is cheap
 * next to showing a failure the model would not have repeated.
 */
const MAX_SHAPE_RETRIES = 1

/** Characters of the raw model text retained in a BAD_JSON report. */
const OUTPUT_PREVIEW_CHARS = 200

/**
 * Race an auxiliary call against its own deadline.
 * @param timeoutMs - positive deadline in milliseconds.
 * @param parent - the turn's cancellation signal, when available.
 * @returns an abort signal and a cleanup function.
 */
function makeDeadline(timeoutMs, parent) {
  const controller = new AbortController()
  const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000
  const timer = setTimeout(() => controller.abort(new Error(`prompt-optimizer: timed out after ${bounded}ms`)), bounded)
  if (timer.unref !== undefined) timer.unref()
  const onParentAbort = () => controller.abort(parent?.reason)
  if (parent !== undefined && parent !== null) {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener('abort', onParentAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener?.('abort', onParentAbort)
    }
  }
}

/**
 * Pull one JSON object out of model output that may be fenced or surrounded by prose.
 * @param text - the raw assembled model text.
 * @returns the parsed value, or `null` when no JSON object could be recovered.
 */
function extractJson(text) {
  const direct = tryParse(text)
  if (direct !== null) return direct
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced !== null) {
    const inner = tryParse(fenced[1])
    if (inner !== null) return inner
  }
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return tryParse(text.slice(start, index + 1))
    }
  }
  return null
}

/**
 * Parse one candidate string, returning `null` instead of throwing.
 * @param text - candidate JSON text.
 * @returns the parsed value or `null`.
 */
function tryParse(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Validate and normalize one parsed optimizer response.
 * @param parsed - the parsed JSON value.
 * @returns the normalized analysis, or `null` when the shape is unusable.
 */
export function normalizeAnalysis(parsed) {
  if (parsed === null || typeof parsed !== 'object') return null
  const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : ''
  const missing = Array.isArray(parsed.missing)
    ? parsed.missing.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  const variant = (raw, fallbackTitle) => {
    if (raw === null || typeof raw !== 'object') return null
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    if (prompt === '') return null
    return {
      title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : fallbackTitle,
      rationale: typeof raw.rationale === 'string' ? raw.rationale.trim() : '',
      prompt
    }
  }
  const A = variant(parsed.A, 'A')
  const B = variant(parsed.B, 'B')
  if (A === null || B === null) return null
  return { intent, missing, A, B }
}

/**
 * Accumulate the visible text of one text-only auxiliary stream.
 *
 * The shipped `BlockAssembler` is an internal module rather than a published
 * export, so this plugin reads the same public chunk vocabulary directly: text
 * deltas are the stream, and a completed text block is the fallback for adapters
 * that emit whole blocks instead of deltas. Reasoning, tool, usage, and finish
 * chunks are ignored, which is exactly the text-only contract this call needs.
 *
 * @param ctx - plugin context carrying the LLM runtime.
 * @param options - the frozen request.
 * @returns the joined text.
 */
async function collectText(ctx, options) {
  const deltas = []
  const completed = []
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      deltas.push(chunk.text)
      continue
    }
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      completed.push(chunk.block.text)
    }
  }
  return deltas.length > 0 ? deltas.join('') : completed.join('')
}

/**
 * Re-run one shape failure while the retry budget lasts.
 *
 * Retries stay inside the failed call's own deadline: the overall bound is what
 * the caller promised, so a second sample must not extend the user's wait. Only
 * shape failures reach here — transport failures (`CALL_FAILED`) and aborts
 * (`TIMEOUT_OR_ABORT`) are outcomes the caller would retire differently, and an
 * oversized input is not a sampling accident at all.
 *
 * @param args - the exact arguments of the failed call, minus its retry budget.
 * @param retries - attempts left after the one that just failed.
 * @param deadline - the failed call's deadline, consulted for cancellation.
 * @param failure - the typed failure to repeat, or to return as the verdict.
 * @returns a fresh attempt's result, or the failure when no retry is left.
 */
function retryShape(args, retries, deadline, failure) {
  if (retries <= 0 || deadline.signal.aborted) return failure
  return optimizePrompt(
    args.ctx,
    args.config,
    args.context,
    args.rawPrompt,
    args.workspace,
    args.signal,
    args.deps,
    retries - 1
  )
}

/**
 * Ask the optimizer model for two rewrites of one prompt.
 *
 * @param ctx - plugin context carrying the LLM runtime.
 * @param config - validated plugin configuration, including the route and bounds.
 * @param context - rendered personal-context block, possibly empty.
 * @param rawPrompt - the exact prompt the user typed.
 * @param workspace - session working directory, for orientation.
 * @param signal - the turn's cancellation signal.
 * @param deps - the resolved `@deepseek-ai/dsh-llm` surfaces this call needs.
 * @param retries - shape retries left; callers omit this and get the default.
 * @returns the normalized analysis, or a typed failure the caller can report.
 */
export async function optimizePrompt(ctx, config, context, rawPrompt, workspace, signal, deps = {}, retries = MAX_SHAPE_RETRIES) {
  const { createUserMessage } = deps
  if (typeof createUserMessage !== 'function') {
    return { ok: false, code: 'LLM_UNAVAILABLE', message: 'could not resolve @deepseek-ai/dsh-llm from the plugin location' }
  }
  const system = buildSystemPrompt()
  const user = buildUserPrompt(context, rawPrompt, workspace)
  if (Buffer.byteLength(user, 'utf8') > config.maxInputBytes) {
    return { ok: false, code: 'INPUT_TOO_LARGE', message: 'personal context exceeds maxInputBytes' }
  }
  const deadline = makeDeadline(config.timeoutMs, signal)
  try {
    const options = Object.freeze({
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: PLUGIN_ID }
        })
      ],
      system,
      maxTokens: config.maxOutputTokens,
      purpose: 'session-title',
      signal: deadline.signal
    })
    const text = await collectText(ctx, options)
    if (text.trim() === '') {
      return retryShape({ ctx, config, context, rawPrompt, workspace, signal, deps }, retries, deadline, {
        ok: false,
        code: 'EMPTY_OUTPUT',
        message: 'optimizer produced no text'
      })
    }
    const analysis = normalizeAnalysis(extractJson(text))
    if (analysis === null) {
      // The raw text is the only evidence that distinguishes a truncated answer
      // from one whose keys drifted, and it is exactly what a support question
      // about a failed optimization needs. Sliced by code unit and never by byte:
      // a byte-boundary cut splits a multi-byte character and renders the tail of
      // the preview as a replacement character.
      const preview = text.slice(0, OUTPUT_PREVIEW_CHARS).replace(/\s+/g, ' ').trim()
      return retryShape({ ctx, config, context, rawPrompt, workspace, signal, deps }, retries, deadline, {
        ok: false,
        code: 'BAD_JSON',
        message: `optimizer output was not the required JSON shape; raw output began: ${preview}`
      })
    }
    return { ok: true, analysis, variantIds: [VARIANT_A, VARIANT_B] }
  } catch (error) {
    const aborted = deadline.signal.aborted
    return {
      ok: false,
      code: aborted ? 'TIMEOUT_OR_ABORT' : 'CALL_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    deadline.dispose()
  }
}
