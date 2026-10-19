import { createHash } from 'node:crypto'
import { AI_MODEL_REGISTRY, type AiModelKey } from '@pathfinder/ai'

// A single-call "decide, then answer" format for guest chat. The model first writes a
// short private check (one decision per question, with exact quotes), then the guest
// answer. The server removes the check before streaming, persistence and evidence, so
// guests and conversation history only ever see the answer. It is off unless the
// GUEST_CHAT_ANSWER_CHECK environment variable selects it; rollback is unsetting it.

export const GUEST_ANSWER_CHECK_OPEN = '<answer_check>'
export const GUEST_ANSWER_CHECK_CLOSE = '</answer_check>'
export const GUEST_ANSWER_CHECK_VERSION = 'guest-answer-check-v1'

export type GuestAnswerCheckMode = 'off' | 'economy' | 'all'

export const GUEST_ANSWER_CHECK_DISPOSITIONS = [
  'YES',
  'NO',
  'CONDITIONAL',
  'UNKNOWN',
  'INFORMATION',
] as const

export const GUEST_ANSWER_CHECK_INSTRUCTION = `TRUSTED ANSWER CHECK (system rule; the server removes the check before the visitor sees anything):
Start every reply with one private check, then the visitor's answer, in exactly this form:
${GUEST_ANSWER_CHECK_OPEN}{"decisions":[{"question":"","disposition":"","conditions":[],"missingFacts":[],"evidenceQuotes":[],"visitorFactQuotes":[]}]}${GUEST_ANSWER_CHECK_CLOSE}
- Write one decision for each thing the visitor is asking now; use earlier messages only to resolve what they mean. question is a few words. disposition is YES, NO, CONDITIONAL, UNKNOWN or INFORMATION.
- evidenceQuotes are short exact phrases copied from the venue data that settle the decision. visitorFactQuotes are short exact phrases from the visitor's own messages that the decision relies on, such as their time, ages, heights, group or plans. Earlier assistant replies are never evidence.
- Use NO only when a quote says no or the visitor's stated facts fail a quoted limit. When the data does not mention something, that part is UNKNOWN: ruling out one kind of thing does not rule out others.
- Compare the visitor's stated time, date, age, height, group size or amount with each quoted limit exactly.
- Use CONDITIONAL when the outcome depends on a fact about the visitor or someone with them that they have not given, and put what each case means in conditions.
- missingFacts lists facts the decision needs that neither the venue data nor the visitor gives.
- Keep the check compact valid JSON with no markdown. Never mention the check in the answer.
After ${GUEST_ANSWER_CHECK_CLOSE}, write the visitor's answer exactly as the rules above require. It must agree with every decision: never open with "Yes" for a NO or CONDITIONAL decision, give each CONDITIONAL's cases, and say each UNKNOWN once alongside what is known.`

export function guestAnswerCheckMode(
  env: Record<string, string | undefined> = process.env,
): GuestAnswerCheckMode {
  const value = env.GUEST_CHAT_ANSWER_CHECK?.trim().toLowerCase()
  return value === 'economy' || value === 'all' ? value : 'off'
}

/** The check applies to the route's primary model only, so a fallback cannot change format. */
export function isGuestAnswerCheckEnabled(
  mode: GuestAnswerCheckMode,
  primaryModelKey: string | undefined,
): boolean {
  if (mode === 'off' || !primaryModelKey || !(primaryModelKey in AI_MODEL_REGISTRY)) return false
  if (mode === 'all') return true
  return AI_MODEL_REGISTRY[primaryModelKey as AiModelKey].costTier === 'ECONOMY'
}

export function appendGuestAnswerCheckInstruction(dynamicPart: string): string {
  return `${dynamicPart}\n\n${GUEST_ANSWER_CHECK_INSTRUCTION}`
}

export class GuestAnswerCheckFormatError extends Error {
  constructor(readonly code: 'UNTERMINATED_CHECK' | 'EMPTY_ANSWER' | 'REPEATED_CHECK') {
    super(`Guest answer check format failed: ${code}`)
    this.name = 'GuestAnswerCheckFormatError'
  }
}

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
 * Splits a complete provider reply. Throws only when no safe guest answer exists:
 * a check that never closes (truncation), an empty answer, or a second check that
 * would leak into guest text. Malformed check JSON is recorded but does not block
 * an otherwise complete answer: the check informs generation, it is not a gate.
 */
export function splitGuestAnswerCheck(raw: string): GuestAnswerCheckSplit {
  const trimmedStart = raw.trimStart()
  if (!trimmedStart.startsWith(GUEST_ANSWER_CHECK_OPEN)) {
    if (raw.includes(GUEST_ANSWER_CHECK_OPEN) || raw.includes(GUEST_ANSWER_CHECK_CLOSE))
      throw new GuestAnswerCheckFormatError('REPEATED_CHECK')
    if (!raw.trim()) throw new GuestAnswerCheckFormatError('EMPTY_ANSWER')
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
  if (answer.includes(GUEST_ANSWER_CHECK_OPEN) || answer.includes(GUEST_ANSWER_CHECK_CLOSE))
    throw new GuestAnswerCheckFormatError('REPEATED_CHECK')
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
 * Streaming gate in front of the guest projection. Text is held while it could still be
 * the opening tag or is inside the check; after the closing tag, the answer streams as
 * usual. A reply that does not start with the check streams unchanged from the start.
 */
export function createGuestAnswerCheckStreamGate(
  forward: (visibleDelta: string) => void | Promise<void>,
) {
  let buffer = ''
  let state: 'DECIDING' | 'IN_CHECK' | 'ANSWER' | 'PASS_THROUGH' = 'DECIDING'
  let answerStarted = false
  return async function push(delta: string) {
    if (!delta) return
    if (state === 'PASS_THROUGH') return forward(delta)
    if (state === 'ANSWER') {
      if (!answerStarted) {
        // Drop the whitespace between the closing tag and the answer.
        const visible = delta.trimStart()
        if (!visible) return
        answerStarted = true
        return forward(visible)
      }
      return forward(delta)
    }
    buffer += delta
    if (state === 'DECIDING') {
      const leading = buffer.trimStart()
      if (!leading) return
      if (GUEST_ANSWER_CHECK_OPEN.startsWith(leading)) return
      if (!leading.startsWith(GUEST_ANSWER_CHECK_OPEN)) {
        state = 'PASS_THROUGH'
        const held = buffer
        buffer = ''
        return forward(held)
      }
      state = 'IN_CHECK'
    }
    const closeIndex = buffer.indexOf(GUEST_ANSWER_CHECK_CLOSE)
    if (closeIndex < 0) return
    const rest = buffer.slice(closeIndex + GUEST_ANSWER_CHECK_CLOSE.length)
    buffer = ''
    state = 'ANSWER'
    if (rest) return push(rest)
  }
}
