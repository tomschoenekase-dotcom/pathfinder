// Decision-first answers for the Luna guest-chat route. Smaller models tend to open with a bare
// "Yes" and then explain a limit that makes the answer "no", or turn one ruled-out option into
// "there is none". This asks for the deciding comparison first, in ordinary prose, so the answer
// still streams immediately and needs no private format or parser. It generalizes the existing
// height-question rule to other "will this work for me" questions. Off unless
// GUEST_CHAT_ANSWER_SHAPE selects it.

export const GUEST_ANSWER_SHAPE_VERSION = 'guest-answer-shape-decision-first-v4'

export type GuestAnswerShapeMode = 'off' | 'decision-first'

// Only routes whose primary model was evaluated with this rule receive it. Other economy models
// (and the platform default) keep their unshaped prompt until they are measured too.
export const GUEST_ANSWER_SHAPE_MODEL_KEYS: ReadonlySet<string> = new Set([
  'guest-chat-luna',
  'guest-chat-luna-reasoning',
])

export const GUEST_ANSWER_SHAPE_INSTRUCTION = `DECISION-FIRST ANSWERS (trusted system rule):
- When the visitor asks whether something will work for them, such as getting in, timing, eligibility, what is allowed or the price for their group, first compare their own stated details with the limit that decides it. For timing, the deciding limit is the latest time to enter, buy or start when one is given, not the closing time.
- Put that fact and what it means for them first, in the reply language. A yes or no word may never come before that fact, and no later sentence may contradict it.
- A person's age, membership or other status is known only when the visitor states it. Never infer an unstated age or status from a height, or from someone being a sibling, child or friend. When an outcome depends on it, give the outcome for each possibility briefly, at most two cases; with more, state the deciding condition instead. A missing measured height is different: ask for it.
- When the visitor asks whether something is available and the facts rule out only one kind of it, answer that part in two pieces: what is ruled out, and that you're not sure about other options, with who can check. Never stop after the first piece, and never conclude that there are none.
- Questions that only ask what something is like are answered as usual. Questions asking which options exist list every matching option with its limit; the rules above still apply to any kind that is ruled out.
- Cover every part of the question before any suggestion or follow-up question.`

export function guestAnswerShapeMode(
  env: Record<string, string | undefined> = process.env,
): GuestAnswerShapeMode {
  return env.GUEST_CHAT_ANSWER_SHAPE?.trim().toLowerCase() === 'decision-first'
    ? 'decision-first'
    : 'off'
}

/**
 * Decided by the configured primary model, not by whichever candidate is first after unhealthy
 * providers are filtered out. The system prompt is shared by every route candidate, so a
 * configured fallback model also receives the rule when the primary is Luna.
 */
export function isGuestAnswerShapeEnabled(
  mode: GuestAnswerShapeMode,
  configuredPrimaryModelKey: string | undefined,
): boolean {
  return (
    mode === 'decision-first' &&
    configuredPrimaryModelKey !== undefined &&
    GUEST_ANSWER_SHAPE_MODEL_KEYS.has(configuredPrimaryModelKey)
  )
}

export function appendGuestAnswerShapeInstruction(dynamicPart: string): string {
  return `${dynamicPart}\n\n${GUEST_ANSWER_SHAPE_INSTRUCTION}`
}
