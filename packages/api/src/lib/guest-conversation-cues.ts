import { isGuestHeightOrAgeRideQuestion } from './venue-context'

// What a reply says when it gives a seasonal or long closure.
const SEASON_NOTICE =
  /closed for (?:the )?(?:\d{4} )?(?:season|year|winter)|season (?:has )?ended|(?:re)?opens? (?:again )?(?:in|next) (?:\d{4}|spring|summer|may|april|june)|returning (?:in|next) \d{4}|back (?:in|next) \d{4}|closed until|off-season|out of season/iu
// What a reply says when it gives a rider height rule.
const HEIGHT_RULE =
  /\b\d{2,3}\s?(?:-|\u2011)?\s?(?:inch|inches|in\.|")|minimum height|height (?:requirement|minimum|rule)|tall to ride|tall enough/iu
// Questions where hours, dates or a closure belong in the answer again.
const SCHEDULE_QUESTION =
  /\b(?:open|opens|opening|close|closes|closed|closing|hours|when|today|tonight|tomorrow|weekend|season|date|dates|visit|going|trip|plan|planning|next year|reopen\w*)\b/iu
// Questions where a rider rule belongs in the answer again.
const RIDER_QUESTION =
  /\b(?:kids?|child|children|toddler|baby|son|daughter|grandkids?|\d+\s*(?:years?|yrs?)[\s-]*old|tall|height|inches|ride it|ride that|can (?:he|she|they|we|i) ride)\b/iu

/**
 * A note about what this conversation has already told the visitor, so a follow-up does not
 * repeat a seasonal closure or a rider height rule that has nothing to do with the new question.
 * Economy models repeat these notices turn after turn even when told to say them once; the
 * server can see the earlier replies, so it says so plainly instead.
 */
export function guestAlreadySaidCue(params: {
  question: string
  previousReplies: readonly string[]
}): string {
  if (params.previousReplies.length === 0) return ''
  const said: string[] = []
  if (
    params.previousReplies.some((reply) => SEASON_NOTICE.test(reply)) &&
    !SCHEDULE_QUESTION.test(params.question)
  )
    said.push('the seasonal closure or reopening')
  if (
    params.previousReplies.some((reply) => HEIGHT_RULE.test(reply)) &&
    !isGuestHeightOrAgeRideQuestion(params.question) &&
    !RIDER_QUESTION.test(params.question)
  )
    said.push('rider height rules')
  if (said.length === 0) return ''
  return `ALREADY SAID: Earlier in this conversation you already told the visitor about ${said.join(' and ')}. Do not repeat ${said.length > 1 ? 'them' : 'it'} in this answer; this question is about something else.`
}
