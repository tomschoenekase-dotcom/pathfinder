// Answer shape: what kind of reply the visitor's message asks for, separate from what evidence the
// answer needs. A casual "what's that big yellow coaster?" and "tell me everything about the
// pandas" can need the same records; they need very different amounts said.
//
// Shapes are a small, stable set used for depth guidance, not a taxonomy of venue questions.
// Actionable and permission flags are independent of shape: a short identification can still be
// a question whose answer must carry a restriction.

import { guestResponseIntentForMessage } from './guest-response-intent'

export type GuestAnswerShape = 'IDENTIFY' | 'FACT' | 'COMPARE' | 'PLAN' | 'LIST' | 'DEEP_DIVE'

export type GuestAnswerShapeResult = {
  shape: GuestAnswerShape
  /** The visitor is deciding whether or how to do, buy, use or accept something. */
  actionable: boolean
  /** The visitor asks whether something is allowed, permitted or possible for them. */
  permission: boolean
  /** Appearance words the visitor used to pick something out ("yellow", "big"). */
  descriptors: string[]
}

const DEEP_DIVE =
  /\b(?:tell me (?:everything|all|more|a lot)|everything (?:about|on|there is)|all (?:about|there is to know)|in (?:depth|detail)|deep dive|full story|whole story|history (?:of|behind)|learn (?:more|all|everything) about|what should i know about|give me the (?:full|whole|complete)|walk me through)\b/iu

const IDENTIFY =
  /\b(?:what(?:'s|’s| is| are)\s+(?:that|this|those|these)\b[\s\S]{0,60}\??$|what (?:ride|animal|building|bird|thing|statue|painting|exhibit|coaster|tower|show) is (?:that|this)|which (?:ride|animal|one|exhibit|coaster|building) is (?:that|this|the)\b|is that (?:the|a|an)\b|what am i looking at|what(?:'s| is) (?:it|that) called|name of (?:that|this|the))/iu

const LIST =
  /\b(?:(?:what|which)\s+(?:\w+\s+){0,2}(?:rides|attractions|coasters|animals|exhibits|galleries|restaurants|shows|events|options|things|places|experiences|slides|tickets|passes|offers|tours)\b|what (?:else )?(?:can|could) (?:he|she|they|we|i|you|the kids?|my \w+|\w+) (?:ride|do|see|try|go on)\b|list (?:of |all |the |every )?|all (?:the|of the)\b|every (?:ride|animal|exhibit|show|restaurant)|how many\b)/iu

const PLAN =
  /\b(?:plan (?:our|my|a|the)|itinerary|what order|in what order|best way to spend|how should (?:we|i) (?:spend|do|plan)|what should (?:we|i) do (?:first|today|with)|make (?:us|me) a (?:plan|schedule)|(?:\d|two|three|four|half)[- ]?(?:hours?|day) (?:here|visit|to spend))\b/iu

const ACTIONABLE =
  /\b(?:should (?:i|we)|do (?:i|we) (?:need|have) to|is it worth|worth (?:it|getting|buying)|how (?:do|can|would) (?:i|we) (?:get|buy|use|collect|redeem|book|reserve|claim|return|upgrade)|can (?:i|we) (?:get|use|buy|book|return|come back|re-?enter|leave|take|accept|swap|exchange|upgrade|claim|collect)|what happens if|if (?:i|we) (?:leave|accept|take|buy|use|get)|(?:want|going|plan(?:ning)?) to (?:buy|get|book|use|accept|take|leave)|take the (?:pass|offer|deal|voucher))\b/iu

const PERMISSION =
  /\b(?:(?:can|may|could) (?:i|we|you|my|our|he|she|they|kids?|children)\b[\s\S]{0,40}\b(?:bring|take|have|use|wear|carry|fly|smoke|vape|feed|touch|pet|film|photograph|ride|go|enter|do)|\b(?:allowed|permitted|ok to|okay to|banned|prohibited)\b|\bis (?:it|there) (?:ok|okay|fine)\b)/iu

const DESCRIPTOR_WORDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'white',
  'black',
  'silver',
  'gold',
  'golden',
  'brown',
  'gray',
  'grey',
  'striped',
  'spotted',
  'wooden',
  'tall',
  'big',
  'huge',
  'giant',
  'small',
  'tiny',
  'round',
  'spinning',
  'upside down',
  'loud',
  'glass',
] as const

const DESCRIPTOR_PATTERN = new RegExp(String.raw`\b(?:${DESCRIPTOR_WORDS.join('|')})\b`, 'giu')

export function guestAnswerShape(message: string, requested?: 'DEFAULT' | 'EXPAND'): GuestAnswerShapeResult {
  const text = message.normalize('NFKC').trim()
  const descriptors = [...new Set([...text.matchAll(DESCRIPTOR_PATTERN)].map((match) => match[0].toLocaleLowerCase()))]
  const actionable = ACTIONABLE.test(text)
  const permission = PERMISSION.test(text)
  const shape: GuestAnswerShape =
    requested === 'EXPAND' || DEEP_DIVE.test(text)
      ? 'DEEP_DIVE'
      : guestResponseIntentForMessage(text, undefined) === 'COMPARE'
        ? 'COMPARE'
        : PLAN.test(text)
          ? 'PLAN'
          : IDENTIFY.test(text) && !LIST.test(text)
            ? 'IDENTIFY'
            : LIST.test(text)
              ? 'LIST'
              : 'FACT'
  return { shape, actionable, permission, descriptors }
}

/** Depth guidance for the reply; never a reason to drop a required notice or a condition. */
export function guestAnswerShapeRule(result: GuestAnswerShapeResult): string {
  const keep =
    'Whatever the length, keep every condition, exception or unknown that changes whether the answer holds for this visitor, and every authored notice that NOTICES makes relevant; leave out ones that do not bear on the question. For a participation decision, distinguish meeting a stated requirement from being fully eligible: an unknown requirement remains unresolved. When roles are ambiguous, explain the supported role options briefly or ask who will participate; do not assume everyone is a participant or assign a companion.'
  switch (result.shape) {
    case 'IDENTIFY':
      return `ANSWER DEPTH: The visitor is picking something out. Name it only when a record supports that identification, then give one or two facts that tell it apart (what kind of thing it is, where it is, what it is like). Leave out builder, manufacturer, opening year, technical terms and history unless asked.${result.descriptors.length ? ` The visitor described it as: ${result.descriptors.join(', ')}. Treat a description no record states as unconfirmed; never assert or invent a color, size, shape or feature to make a match.` : ''} If more than one thing could fit, name the candidates briefly or ask one short question. ${keep}`
    case 'DEEP_DIVE':
      return `ANSWER DEPTH: The visitor asked for the full picture. Give a richer, organized answer: start with what it is, then group the supported facts by theme (for example what to see or do, background or history, practical details) in a few short paragraphs of plain text. Use every relevant fact the records support, and stop when they run out; never pad with invented detail or general knowledge presented as the venue's. ${keep}`
    case 'LIST':
      return `ANSWER DEPTH: The visitor asked for a set of things. Follow the coverage line in the evidence focus: name each matching thing briefly with at most one deciding detail, and never call a partial set complete. ${keep}`
    case 'PLAN':
      return `ANSWER DEPTH: The visitor wants a plan. Give a short ordered plan built only from supported facts, with one reason per step. ${keep}`
    case 'COMPARE':
      return `ANSWER DEPTH: The visitor asked for a comparison; compare only on supported facts. ${keep}`
    case 'FACT':
      return `ANSWER DEPTH: Answer the asked fact first and directly; add at most one closely related useful detail. ${keep}`
  }
}
