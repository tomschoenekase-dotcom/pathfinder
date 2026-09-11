import { createHash } from 'node:crypto'

export type VisitorSignalCandidate =
  | { kind: 'CLOSURE_REPORT'; summary: string; suggestedAction: string }
  | { kind: 'URGENT_HAZARD'; summary: string; suggestedAction: string }

export function visitorHazardDeduplicationKey(params: {
  tenantId: string
  venueId: string
  guestChatTurnId: string | null
  messageId: string
}): string {
  const target = params.guestChatTurnId ?? params.messageId
  const digest = createHash('sha256')
    .update(JSON.stringify([params.tenantId, params.venueId, target]))
    .digest('hex')
  return `visitor-feedback-hazard:${digest}`
}

const urgentHazard =
  /\b(?:fire|smoke|gas leak|carbon monoxide|broken glass|active shooter|weapon|collapse(?:d)?|flood(?:ing|ed)?|electrical (?:hazard|shock)|exposed wire|slippery|unsafe|dangerous|injur(?:y|ed))\b/iu
const closureReport = /\b(?:closed|closure|shut(?:\s+down)?|not open)\b/iu
const reportShape =
  /^(?:(?:there|here)\s+(?:is|are|was|were)\b|i\s+(?:see|saw|smell|found)\b|(?:please\s+)?help\b|someone\s+(?:is|was|got)\b|(?:the|a|an)\s+.{0,70}\s+(?:is|are|was|were)\b)/iu
const hypothetical = /^(?:what if|if\b|is there|could there|would there|do you)/iu
const educationalContext =
  /\b(?:fire|smoke)\s+safety\s+(?:exhibit|display|lesson)|\bweapon(?:s)?\s+(?:exhibit|display)\b/iu

function hasUnnegatedUrgentHazard(text: string): boolean {
  if (!reportShape.test(text) || hypothetical.test(text) || educationalContext.test(text))
    return false
  const matcher = new RegExp(urgentHazard.source, 'giu')
  for (const match of text.matchAll(matcher)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 30), match.index)
    if (!/\b(?:no|not|without)\s+(?:(?:a|an|any)\s+)?$/iu.test(prefix)) return true
  }
  return false
}

function hasUnnegatedClosureReport(text: string): boolean {
  const matcher = new RegExp(closureReport.source, 'giu')
  for (const match of text.matchAll(matcher)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index)
    // Negation applies only immediately before this match. A later affirmative
    // closure in the same feedback must still become an unverified candidate.
    // "not open" is itself a closure match, so its own "not" is not a negator.
    if (!/\b(?:no\s+longer|no|not|without|\w+n['\u2019]t)\s+(?:(?:a|an|any)\s+)?$/iu.test(prefix))
      return true
  }
  return false
}

/**
 * Classifies a single visitor's optional feedback reason into an unverified review candidate.
 * It never changes venue knowledge, operational updates, or visitor-visible content.
 */
export function classifyVisitorSignalCandidate(
  reason: string | null | undefined,
): VisitorSignalCandidate | null {
  const text = reason?.trim()
  if (!text) return null
  if (hasUnnegatedUrgentHazard(text)) {
    return {
      kind: 'URGENT_HAZARD',
      summary:
        'An unverified visitor feedback report may describe an immediate venue safety hazard.',
      suggestedAction:
        'Review the current feedback record and its cited public conversation immediately, then follow the venue safety escalation procedure.',
    }
  }
  if (hasUnnegatedClosureReport(text)) {
    return {
      kind: 'CLOSURE_REPORT',
      summary: 'A visitor feedback report may describe a closure or unavailable attraction.',
      suggestedAction:
        'Verify this report against current official venue information before proposing a temporary notice or knowledge correction.',
    }
  }
  return null
}
