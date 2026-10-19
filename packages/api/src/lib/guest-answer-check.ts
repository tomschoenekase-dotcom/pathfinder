import { createHash } from 'node:crypto'
import { AI_MODEL_REGISTRY, type AiModelKey } from '@pathfinder/ai'

// A single-call "decide, then answer" format for guest chat. The model first writes a
// short private check (one decision per question, with exact quotes), then the guest
// answer. The server removes the check before streaming, persistence and evidence, so
// guests and conversation history only ever see the answer. It is off unless the
// GUEST_CHAT_ANSWER_CHECK environment variable selects it; rollback is unsetting it.

export const GUEST_ANSWER_CHECK_OPEN = '<answer_check>'
export const GUEST_ANSWER_CHECK_CLOSE = '</answer_check>'
export const GUEST_ANSWER_CHECK_VERSION = 'guest-answer-check-v2'
// The check itself can take a few hundred output tokens; routes capped below this would
// truncate answers into fallback replies.
export const GUEST_ANSWER_CHECK_MIN_OUTPUT_TOKENS = 1024

export type GuestAnswerCheckMode = 'off' | 'economy' | 'all'

export const GUEST_ANSWER_CHECK_DISPOSITIONS = [
  'YES',
  'NO',
  'CONDITIONAL',
  'UNKNOWN',
  'INFORMATION',
] as const

export const GUEST_ANSWER_CHECK_INSTRUCTION = `TRUSTED ANSWER CHECK (system rule; the server removes the check before the visitor sees anything):
Begin every reply directly with one private check, then the visitor's answer, in exactly this form:
${GUEST_ANSWER_CHECK_OPEN}{"decisions":[{"question":"","disposition":"","conditions":[],"missingFacts":[],"evidenceQuotes":[],"visitorFactQuotes":[]}]}${GUEST_ANSWER_CHECK_CLOSE}
- The check is the one exception to the plain-text and hidden-context rules above. Write nothing before it, never put it in a code block, and never mention it in the answer.
- Write one decision for each thing the visitor is asking now; use earlier messages only to resolve what they mean. question is a few words. disposition is YES, NO, CONDITIONAL, UNKNOWN or INFORMATION.
- evidenceQuotes are short exact phrases copied from the venue data that the decision rests on; INFORMATION may combine several or need none. visitorFactQuotes are short exact phrases from the visitor's own messages that the decision relies on, such as their time, ages, heights, group or plans. Earlier assistant replies are never evidence.
- Use NO only when a quote says no or the visitor's stated facts fail a quoted limit. When the data does not mention something the visitor asked about, that part is UNKNOWN: ruling out one kind of thing does not rule out others.
- Compare the visitor's stated time, date, age, height, group size or amount with each quoted limit exactly.
- Use CONDITIONAL when the outcome depends on a fact about the visitor or someone with them that they have not given, and put what each case means in conditions.
- missingFacts lists facts the decision needs that neither the venue data nor the visitor gives.
- Keep the check compact valid JSON.
After ${GUEST_ANSWER_CHECK_CLOSE}, write the visitor's answer exactly as the rules above require, in the language they require. It must agree with every decision: lead with the fact or comparison a decision rests on rather than a bare yes or no, give each CONDITIONAL's cases, and say each UNKNOWN once alongside what is known.`

export function guestAnswerCheckMode(
  env: Record<string, string | undefined> = process.env,
): GuestAnswerCheckMode {
  const value = env.GUEST_CHAT_ANSWER_CHECK?.trim().toLowerCase()
  return value === 'economy' || value === 'all' ? value : 'off'
}

/**
 * Decided by the route's primary model and its effective output cap. The system prompt and
 * parser are shared by every route candidate, so a configured fallback model also receives
 * the instruction and pays for the check.
 */
export function isGuestAnswerCheckEnabled(
  mode: GuestAnswerCheckMode,
  primaryModelKey: string | undefined,
  effectiveMaxOutputTokens?: number | null,
): boolean {
  if (mode === 'off' || !primaryModelKey || !(primaryModelKey in AI_MODEL_REGISTRY)) return false
  const spec = AI_MODEL_REGISTRY[primaryModelKey as AiModelKey]
  if ((effectiveMaxOutputTokens ?? spec.maxOutputTokens) < GUEST_ANSWER_CHECK_MIN_OUTPUT_TOKENS)
    return false
  return mode === 'all' || spec.costTier === 'ECONOMY'
}

export function appendGuestAnswerCheckInstruction(dynamicPart: string): string {
  return `${dynamicPart}\n\n${GUEST_ANSWER_CHECK_INSTRUCTION}`
}

export class GuestAnswerCheckFormatError extends Error {
  constructor(
    readonly code: 'UNTERMINATED_CHECK' | 'EMPTY_ANSWER' | 'REPEATED_CHECK' | 'MALFORMED_CHECK',
  ) {
    super(`Guest answer check format failed: ${code}`)
    this.name = 'GuestAnswerCheckFormatError'
  }
}

// Any tag that looks like the check, in any case or spelling, opening or closing.
const CHECK_LIKE_TAG = /<\s*\/?\s*answer[\s_-]*check/iu
// A reply that opens with a code fence or a JSON object may be a wrapped check; it is held
// back and decided on the complete text.
const MAYBE_WRAPPED_CHECK = /^(?:`|\{)/u

export type GuestAnswerCheckSplit = {
  answer: string
  // MISSING: the model skipped the check and answered directly; the answer is delivered
  // unchanged (plain-model behavior) and the miss is recorded, never repaired.
  checkStatus: 'PRESENT' | 'MISSING'
  checkText: string | null
  checkJson: 'VALID' | 'INVALID' | 'ABSENT'
  decisions: Array<{ disposition: string }> | null
}

function parseCheckJson(text: string): GuestAnswerCheckSplit['decisions'] {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const decisions = (value as { decisions?: unknown }).decisions
    if (!Array.isArray(decisions) || decisions.length === 0) return null
    return decisions.map((decision) => ({
      disposition:
        decision && typeof decision === 'object' && 'disposition' in decision
          ? String((decision as { disposition: unknown }).disposition)
          : 'MISSING',
    }))
  } catch {
    return null
  }
}

/**
 * Splits a complete provider reply. Throws only when no safe guest answer exists: a check
 * that never closes (truncation), an empty answer, a check in the wrong form (wrong tag
 * spelling, code fence or bare JSON) or a second check that would leak into guest text.
 * Malformed check JSON inside correct tags is recorded but does not block an otherwise
 * complete answer: the check informs generation, it is not a gate.
 */
export function splitGuestAnswerCheck(raw: string): GuestAnswerCheckSplit {
  const trimmedStart = raw.trimStart()
  if (!trimmedStart.startsWith(GUEST_ANSWER_CHECK_OPEN)) {
    if (!raw.trim()) throw new GuestAnswerCheckFormatError('EMPTY_ANSWER')
    if (CHECK_LIKE_TAG.test(raw)) throw new GuestAnswerCheckFormatError('MALFORMED_CHECK')
    if (MAYBE_WRAPPED_CHECK.test(trimmedStart) && /"decisions"/u.test(raw))
      throw new GuestAnswerCheckFormatError('MALFORMED_CHECK')
    return {
      answer: raw.trim(),
      checkStatus: 'MISSING',
      checkText: null,
      checkJson: 'ABSENT',
      decisions: null,
    }
  }
  const body = trimmedStart.slice(GUEST_ANSWER_CHECK_OPEN.length)
  const closeIndex = body.indexOf(GUEST_ANSWER_CHECK_CLOSE)
  if (closeIndex < 0) throw new GuestAnswerCheckFormatError('UNTERMINATED_CHECK')
  const checkText = body.slice(0, closeIndex).trim()
  const answer = body.slice(closeIndex + GUEST_ANSWER_CHECK_CLOSE.length).trim()
  if (CHECK_LIKE_TAG.test(answer)) throw new GuestAnswerCheckFormatError('REPEATED_CHECK')
  if (!answer) throw new GuestAnswerCheckFormatError('EMPTY_ANSWER')
  const decisions = parseCheckJson(checkText)
  return {
    answer,
    checkStatus: 'PRESENT',
    checkText,
    checkJson: decisions ? 'VALID' : 'INVALID',
    decisions,
  }
}

/** Hash-and-count summary for logs; quotes and visitor text stay out of operational logs. */
export function summarizeGuestAnswerCheck(split: GuestAnswerCheckSplit) {
  return {
    version: GUEST_ANSWER_CHECK_VERSION,
    checkStatus: split.checkStatus,
    checkJson: split.checkJson,
    decisionCount: split.decisions?.length ?? 0,
    dispositions: split.decisions?.map((decision) => decision.disposition) ?? [],
    checkSha256: split.checkText
      ? createHash('sha256').update(split.checkText).digest('hex')
      : null,
  }
}

/**
 * Streaming gate in front of the guest projection.
 * - Text is held while it could still be the opening tag, and inside the check.
 * - A reply opening with a check-like tag in the wrong form, a code fence or a JSON object is
 *   held entirely; the final split decides whether it is a plain answer or a format failure.
 * - Visible answer text stops at any later check-like tag, and a trailing "<" that could start
 *   one waits for the next delta, so check text never streams to the visitor.
 */
export function createGuestAnswerCheckStreamGate(
  forward: (visibleDelta: string) => void | Promise<void>,
) {
  let buffer = ''
  let state: 'DECIDING' | 'IN_CHECK' | 'VISIBLE' | 'HOLD_ALL' | 'STOPPED' = 'DECIDING'
  let visible = ''
  let emitted = 0

  async function forwardVisible(delta: string) {
    if (!visible) delta = delta.trimStart()
    visible += delta
    const tag = visible.search(CHECK_LIKE_TAG)
    let safe = tag >= 0 ? tag : visible.length
    if (tag < 0) {
      const lastOpen = visible.lastIndexOf('<')
      if (lastOpen >= 0 && !visible.slice(lastOpen).includes('>') && visible.length - lastOpen < 24)
        safe = lastOpen
    } else {
      state = 'STOPPED'
    }
    if (safe <= emitted) return
    const next = visible.slice(emitted, safe)
    emitted = safe
    await forward(next)
  }

  return async function push(delta: string) {
    if (!delta || state === 'HOLD_ALL' || state === 'STOPPED') return
    if (state === 'VISIBLE') return forwardVisible(delta)
    buffer += delta
    if (state === 'DECIDING') {
      const leading = buffer.trimStart()
      if (!leading) return
      if (leading.startsWith('<') && !leading.includes('>') && leading.length < 32) return
      if (leading.startsWith(GUEST_ANSWER_CHECK_OPEN)) {
        state = 'IN_CHECK'
      } else if (CHECK_LIKE_TAG.test(leading.slice(0, 32)) || MAYBE_WRAPPED_CHECK.test(leading)) {
        state = 'HOLD_ALL'
        return
      } else {
        state = 'VISIBLE'
        const held = buffer
        buffer = ''
        return forwardVisible(held)
      }
    }
    const closeIndex = buffer.indexOf(GUEST_ANSWER_CHECK_CLOSE)
    if (closeIndex < 0) return
    const rest = buffer.slice(closeIndex + GUEST_ANSWER_CHECK_CLOSE.length)
    buffer = ''
    state = 'VISIBLE'
    if (rest) return forwardVisible(rest)
  }
}
