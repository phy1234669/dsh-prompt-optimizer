/**
 * dsh-prompt-optimizer — the optimizer's instructions and its output contract.
 *
 * The two variants are not two rewrites of the same idea; they are two fixed
 * axes the user learns to recognize. Variant A stays as close to the user's
 * words as possible and only closes gaps — constraints, boundaries, acceptance
 * criteria. Variant B restructures the same intent into an explicit contract —
 * goal, deliverables, steps, acceptance, assumptions. Keeping the axes fixed is
 * what makes the choice fast, so they are described here as stable policy
 * rather than as a per-call instruction the model may reinterpret.
 *
 * @module dsh-prompt-optimizer/prompt
 */

/** Stable identifier for the conservative variant, echoed back in the notice. */
export const VARIANT_A = 'A'

/** Stable identifier for the structured variant, echoed back in the notice. */
export const VARIANT_B = 'B'

/**
 * The JSON shape the optimizer must return. Kept in one place so the parser and
 * the instructions cannot drift apart.
 */
export const RESPONSE_SCHEMA_HINT = `{
  "intent": "one paragraph: what you believe the user actually wants to achieve",
  "missing": ["information you could not infer and that materially changes the work"],
  "A": {
    "title": "保守精确",
    "rationale": "one or two sentences: what gaps this variant closes and why",
    "prompt": "the complete rewritten prompt, ready to send verbatim"
  },
  "B": {
    "title": "结构化重述",
    "rationale": "one or two sentences: how this variant restructures the request",
    "prompt": "the complete rewritten prompt, ready to send verbatim"
  }
}`

/**
 * Build the optimizer system prompt.
 * @returns the system prompt text.
 */
export function buildSystemPrompt() {
  return [
    'You rewrite a single user prompt so that a coding agent can act on it correctly on the first attempt.',
    '',
    'You are given the user personal profile and workspace instructions, then the raw prompt they typed.',
    'Infer what they are actually trying to achieve from that combination, then produce exactly two rewrites on two fixed axes.',
    '',
    'Variant A — 保守精确 (conservative and precise):',
    '- Preserve the user wording and intent as closely as possible. Do not add goals they did not express.',
    '- Close the gaps a competent engineer would otherwise have to guess at: implicit constraints, scope boundaries,',
    '  edge cases, acceptance criteria, and the specific files or subsystems involved when the profile makes them identifiable.',
    '- Prefer tightening and making explicit over reorganising.',
    '',
    'Variant B — 结构化重述 (structured restatement):',
    '- Restate the same intent as an explicit contract: goal, deliverables, constraints, ordered steps, acceptance criteria, assumptions.',
    '- Rewriting structure is expected; changing intent is not. Every requirement in B must trace back to the raw prompt or the profile.',
    '',
    'Rules for both variants:',
    '- The "prompt" field must be the complete, self-contained prompt, ready to send verbatim. Never a diff, never an outline, never a placeholder.',
    '- Write each prompt in the same language the user wrote their raw prompt in.',
    '- Never invent facts about the codebase, the user, or their environment. When something material cannot be inferred,',
    '  list it in "missing" instead of guessing, and keep the corresponding prompt wording neutral about it.',
    '- Do not pad with generic advice, disclaimers, or restatements of the profile. Every sentence must change what the agent would do.',
    '- Keep each prompt under roughly 700 words. Dense and specific beats long.',
    '',
    'Return ONLY a single JSON object, with no markdown fence and no prose around it, in exactly this shape:',
    RESPONSE_SCHEMA_HINT
  ].join('\n')
}

/**
 * Build the optimizer user message: personal context, then the raw prompt.
 * @param context - rendered personal-context block, possibly empty.
 * @param rawPrompt - the exact prompt the user typed.
 * @param workspace - session working directory, for orientation.
 * @returns the user message text.
 */
export function buildUserPrompt(context, rawPrompt, workspace) {
  const parts = []
  if (typeof workspace === 'string' && workspace.length > 0) {
    parts.push(`Working directory: ${workspace}`)
  }
  if (typeof context === 'string' && context.trim() !== '') {
    parts.push(`Personal profile and workspace instructions:\n\n${context.trim()}`)
  } else {
    parts.push('Personal profile and workspace instructions: (none available — infer from the raw prompt alone.)')
  }
  parts.push(`The raw prompt the user just typed:\n\n"""\n${rawPrompt}\n"""`)
  parts.push('Return the JSON object described in your instructions.')
  return parts.join('\n\n')
}

/**
 * Render the variant-comparison markdown shown in the selection card and reused
 * as the audit detail in the Web banner.
 * @param analysis - parsed optimizer output.
 * @param rawPrompt - the original prompt text.
 * @returns markdown text.
 */
export function renderComparison(analysis, rawPrompt) {
  const lines = []
  lines.push(`**推测意图**：${analysis.intent}`)
  if (Array.isArray(analysis.missing) && analysis.missing.length > 0) {
    lines.push('', '**无法推断、需要你补充的信息**：')
    for (const item of analysis.missing) lines.push(`- ${item}`)
  }
  for (const variant of [analysis.A, analysis.B]) {
    lines.push('', `---`, '', `### ${variant.title}`, '', `_${variant.rationale}_`, '', '```text', variant.prompt, '```')
  }
  lines.push('', '---', '', '**你的原话**', '', '```text', rawPrompt, '```')
  return lines.join('\n')
}
