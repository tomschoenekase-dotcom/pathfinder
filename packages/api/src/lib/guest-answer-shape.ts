import { AI_MODEL_REGISTRY, type AiModelKey } from '@pathfinder/ai'

// Decision-first answers for economy guest-chat routes. Smaller models tend to open with a bare
// "Yes" and then explain a limit that makes the answer "no", or turn one ruled-out option into
// "there is none". This asks for the deciding comparison first, in ordinary prose, so the answer
// still streams immediately and needs no private format or parser. It generalizes the existing
// height-question rule to every outcome question. Off unless GUEST_CHAT_ANSWER_SHAPE selects it.

export const GUEST_ANSWER_SHAPE_VERSION = 'guest-answer-shape-decision-first-v1'

export type GuestAnswerShapeMode = 'off' | 'decision-first'

export const GUEST_ANSWER_SHAPE_INSTRUCTION = `DECISION-FIRST ANSWERS (trusted system rule):
- Before writing, settle each thing the visitor asked. Compare their own stated details, such as a time, date, age, height, group or amount, with the exact limit that governs it. A last entry, last sale, last departure or booking cutoff is the limit, not the closing time.
- Open with that comparison stated as a fact together with its outcome, in the visitor's language, for example "The last tour leaves at 2 pm, so a 2:30 arrival misses it." Never open with a bare "Yes" or "No", and never let a later sentence contradict the outcome you stated.
- If an outcome depends on something about the visitor or someone with them that they have not said, such as an age or a membership, give the outcome for each case in one short clause.
- If the venue facts rule out only one option the visitor asked about, say what is ruled out and that other options are not known, rather than concluding there are none.
- Answer every part of the question before adding anything extra.`

export function guestAnswerShapeMode(
  env: Record<string, string | undefined> = process.env,
): GuestAnswerShapeMode {
  return env.GUEST_CHAT_ANSWER_SHAPE?.trim().toLowerCase() === 'decision-first'
    ? 'decision-first'
    : 'off'
}

/** Decided by the route's primary model; only economy-tier routes receive the rule. */
export function isGuestAnswerShapeEnabled(
  mode: GuestAnswerShapeMode,
  primaryModelKey: string | undefined,
): boolean {
  if (mode === 'off' || !primaryModelKey || !(primaryModelKey in AI_MODEL_REGISTRY)) return false
  return AI_MODEL_REGISTRY[primaryModelKey as AiModelKey].costTier === 'ECONOMY'
}

export function appendGuestAnswerShapeInstruction(dynamicPart: string): string {
  return `${dynamicPart}\n\n${GUEST_ANSWER_SHAPE_INSTRUCTION}`
}
