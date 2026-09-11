/**
 * Bounded, single-message candidate discovery for later human review.
 *
 * This is deliberately a conservative English heuristic. It identifies useful
 * assertion shapes; it does not establish truth, summarize private text, call a
 * model, or change canonical venue knowledge. Hazard reports stay on the
 * visitor-signal path because they have different escalation semantics.
 */

export type ConversationLearningCandidateKind =
  | 'FACTUAL_CORRECTION'
  | 'FACTUAL_ADDITION'
  | 'ALIAS'
  | 'LOCATION'
  | 'TEMPORARY_UPDATE'

export type ConversationLearningCandidate = {
  kind: ConversationLearningCandidateKind
  summary: string
  verification: 'UNVERIFIED'
  hedged: boolean
  suggestedAction: string
}

const promptInjection =
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|rules?)\b|\b(?:system|developer)\s+prompt\b|\b(?:mark|set|publish|approve|delete|reveal)\s+(?:this|it|the)\s+(?:as|now)\b/iu
const questionOnly =
  /^(?:who|what|when|where|why|how|can|could|would|is|are|do|does|did|may|might|should)\b[^.?!]*\?\s*$/iu
const interrogativeLead =
  /^(?:who|what|when|where|why|how|can|could|would|is|are|do|does|did|may|might|should)\b/iu
const requestOnly =
  /^(?:please\s+)?(?:tell|show|give|find|explain|help|add|remove|change|update|publish|approve|ignore|open|close)\b[^.?!]*[.!]?\s*$/iu
const correction =
  /\b(?:actually|correction|correct(?:ion)?|in fact|the answer is|is wrong|was wrong|should be|rather than|not\s+[^.?!]{1,80}\s+but)\b/iu
const alias =
  /\b(?:also known as|also called|called the same as|goes by|known as|aka\.?|short for)\b|\b(?:the|this)\s+[^.?!]{1,80}\s+is\s+(?:also\s+)?(?:called|known as)\b/iu
const temporary =
  /\b(?:closed|closing|reopening|reopens|open(?:s|ed)?|unavailable|temporarily|temporary|today|tonight|this\s+(?:morning|afternoon|evening|weekend)|until\s+[^.?!]{1,50}|through\s+[^.?!]{1,50})\b/iu
const location =
  /\b(?:first|1st|second|2nd|third|3rd|fourth|4th|ground|upper|lower|basement)\s+floor\b|\b(?:north|south|east|west|front|rear|main|side)\s+(?:entrance|door|stair|stairs|wing|gallery|room|building)\b|\b(?:beside|behind|near|next to|across from|between|at the)\b/iu
const factualLead =
  /^(?:the|this|that|our|a|an|i\s+(?:think|believe|understand|noticed|remember|saw|read|heard|found)|according to|the placard|the sign|staff said)\b/iu
const personalAssertion = /^(?:my\b|i\s+(?:am|'m|was|have|had)\b|i\s+need\b)/iu
const hedge =
  /\b(?:i\s+(?:think|believe|guess)|it\s+seems?|apparently|possibly|probably|may be|might be|if i remember|i'm not sure)\b/iu
const pureCopularOpinion =
  /^(?:the|this|that)\s+(?:[\p{L}][\p{L}'-]*\s+){0,4}[\p{L}][\p{L}'-]*\s+(?:is|are|was|were)\s+(?:(?:really|very|so)\s+)?(?:awful|bad|beautiful|boring|cool|dumb|great|horrible|lame|stupid|terrible|ugly)(?:\s+and\s+(?:(?:really|very|so)\s+)?(?:awful|bad|beautiful|boring|cool|dumb|great|horrible|lame|stupid|terrible|ugly))*[.!]?$/iu
// Keep discovery permissive when an evaluative sentence also contains a source,
// date, material, construction or other concrete factual clause.
const explicitFactualContext =
  /\d|\b(?:according to|the placard|the sign|staff said|made|built|constructed|created|designed|dated|weighs?|contains?|depicts?|installed)\b/iu

function hasAssertion(text: string): boolean {
  const sentences = text
    .split(/[.!?]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
  return sentences.some((sentence) => {
    if (
      questionOnly.test(`${sentence}?`) ||
      requestOnly.test(sentence) ||
      interrogativeLead.test(sentence)
    )
      return false
    return (
      factualLead.test(sentence) ||
      /\b(?:is|are|was|were|has|have|means|says|located)\b/iu.test(sentence)
    )
  })
}

function result(
  kind: ConversationLearningCandidateKind,
  hedged: boolean,
): ConversationLearningCandidate {
  const descriptions: Record<ConversationLearningCandidateKind, string> = {
    FACTUAL_CORRECTION: 'A conversation message may correct an existing venue fact.',
    FACTUAL_ADDITION: 'A conversation message may contain a new venue fact.',
    ALIAS: 'A conversation message may provide an alternate name for a venue item.',
    LOCATION: 'A conversation message may contain a location or wayfinding fact.',
    TEMPORARY_UPDATE: 'A conversation message may contain a temporary venue status update.',
  }
  return {
    kind,
    summary: descriptions[kind],
    verification: 'UNVERIFIED',
    hedged,
    suggestedAction:
      'Review the cited conversation evidence and venue source before accepting, editing, or rejecting this candidate.',
  }
}

/** Classify one message into an unverified candidate for human review. */
export function classifyConversationLearningCandidate(
  message: string | null | undefined,
): ConversationLearningCandidate | null {
  const text = message?.trim()
  if (
    !text ||
    text.length > 4000 ||
    promptInjection.test(text) ||
    personalAssertion.test(text) ||
    (pureCopularOpinion.test(text) &&
      !explicitFactualContext.test(text) &&
      !correction.test(text) &&
      !alias.test(text) &&
      !temporary.test(text) &&
      !location.test(text)) ||
    !hasAssertion(text)
  )
    return null

  const hedged = hedge.test(text)

  if (temporary.test(text)) return result('TEMPORARY_UPDATE', hedged)
  if (alias.test(text)) return result('ALIAS', hedged)
  if (location.test(text)) return result('LOCATION', hedged)
  if (correction.test(text)) return result('FACTUAL_CORRECTION', hedged)
  return result('FACTUAL_ADDITION', hedged)
}
