import { createHash } from 'node:crypto'
import { AI_MODEL_REGISTRY, type AiModelKey } from '@pathfinder/ai'
import { z } from 'zod'

// A single-call "decide, then answer" format for guest chat. The model first writes a
// short private check (one decision per question, with exact quotes), then the guest
// answer. The server removes the check before streaming, persistence and evidence, so
// guests and conversation history only ever see the answer. It is off unless the
// GUEST_CHAT_ANSWER_CHECK environment variable selects it; rollback is unsetting it.

export const GUEST_ANSWER_CHECK_OPEN = '<answer_check>'
export const GUEST_ANSWER_CHECK_CLOSE = '</answer_check>'
export const GUEST_ANSWER_CHECK_VERSION = 'guest-answer-check-v3'
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
    readonly code:
      | 'UNTERMINATED_CHECK'
      | 'EMPTY_ANSWER'
      | 'MISSING_CHECK'
      | 'MALFORMED_CHECK'
      | 'UNSUPPORTED_ANSWER_FORMAT',
  ) {
    super(`Guest answer check format failed: ${code}`)
    this.name = 'GuestAnswerCheckFormatError'
  }
}

// The envelope is a format boundary, not a factual or quote-provenance validator.
// Keep logged dispositions typed: arbitrary provider strings must never become log fields.
const CheckSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            question: z.string().min(1),
            disposition: z.enum(GUEST_ANSWER_CHECK_DISPOSITIONS),
            conditions: z.array(z.string()),
            missingFacts: z.array(z.string()),
            evidenceQuotes: z.array(z.string()),
            visitorFactQuotes: z.array(z.string()),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

export type GuestAnswerCheckSplit = {
  answer: string
  checkStatus: 'PRESENT'
  checkText: string
  checkJson: 'VALID'
  decisions: Array<{ disposition: (typeof GUEST_ANSWER_CHECK_DISPOSITIONS)[number] }>
}

/** Find the closing tag outside JSON strings; quoted tag bytes are private data. */
function checkCloseIndex(body: string): number {
  let quoted = false
  let escaped = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (body.startsWith(GUEST_ANSWER_CHECK_CLOSE, index)) return index
  }
  return -1
}

/**
 * Supported answer grammar: plain prose, plain URLs, Markdown links and the existing
 * engagement/action markers. Braces, angle brackets, backticks, tildes and other square
 * bracket forms are reserved, even in innocent quotations. This deliberately conservative
 * boundary rejects serialized JSON, tags and fences wherever they occur, including after
 * a normal prose preface. It does not detect private information rewritten as plain prose.
 */
function assertPlainAnswer(answer: string): void {
  if (/[{}<>`~]/u.test(answer)) throw new GuestAnswerCheckFormatError('UNSUPPORTED_ANSWER_FORMAT')
  const prose = answer.replace(
    /\[\[(?:ENGAGEMENT_ASKED|button:[a-z0-9-]{1,63}|link:[a-z0-9-]{1,63}\|[^[\]|\n]{1,120})\]\]|\[[^[\]\n]+\]\(https?:\/\/[^\s[\]]+\)/gu,
    '',
  )
  if (/[[\]]/u.test(prose)) throw new GuestAnswerCheckFormatError('UNSUPPORTED_ANSWER_FORMAT')
}

/**
 * Only called for the flagged route. Require exactly the supported envelope: an initial
 * canonical tag, valid decision JSON, its closing tag, and a nonempty plain answer.
 * Missing/malformed checks are format failures, never plain-model success. Complete
 * validation must precede visitor emission, storage and answer evidence.
 */
export function splitGuestAnswerCheck(raw: string): GuestAnswerCheckSplit {
  const trimmedStart = raw.trimStart()
  if (!trimmedStart) throw new GuestAnswerCheckFormatError('EMPTY_ANSWER')
  if (!trimmedStart.startsWith(GUEST_ANSWER_CHECK_OPEN))
    throw new GuestAnswerCheckFormatError('MISSING_CHECK')
  const body = trimmedStart.slice(GUEST_ANSWER_CHECK_OPEN.length)
  const closeIndex = checkCloseIndex(body)
  if (closeIndex < 0) throw new GuestAnswerCheckFormatError('UNTERMINATED_CHECK')
  const checkText = body.slice(0, closeIndex).trim()
  let check: z.infer<typeof CheckSchema>
  try {
    check = CheckSchema.parse(JSON.parse(checkText))
  } catch {
    // Never include schema diagnostics containing provider text in this error.
    throw new GuestAnswerCheckFormatError('MALFORMED_CHECK')
  }
  const answer = body.slice(closeIndex + GUEST_ANSWER_CHECK_CLOSE.length).trim()
  if (!answer) throw new GuestAnswerCheckFormatError('EMPTY_ANSWER')
  assertPlainAnswer(answer)
  return {
    answer,
    checkStatus: 'PRESENT',
    checkText,
    checkJson: 'VALID',
    decisions: check.decisions.map(({ disposition }) => ({ disposition })),
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
 * Completion gate in front of the guest projection. Provider deltas are deliberately
 * withheld, preserving the streaming transport without claiming incremental visitor text.
 * A valid prefix cannot certify its unseen suffix (or the provider's final status).
 * Only the gateway-accepted final response is released; deltas from a failed attempt or
 * an incomplete provider response can never contaminate a later answer or fallback.
 * First visible text on this route is therefore at or after provider completion.
 */
export function createGuestAnswerCheckStreamGate(
  forward: (visibleDelta: string) => void | Promise<void>,
) {
  return Object.assign(
    async function push(delta: string) {
      void delta
      // The provider gateway owns accumulation and completion validation.
    },
    {
      async complete(raw: string) {
        await forward(splitGuestAnswerCheck(raw).answer)
      },
    },
  )
}
