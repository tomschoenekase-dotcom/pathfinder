import type { GuestRecordSemantics } from './guest-record-semantics'

/** Preserve explicit access requirements even in ordinary prose. This quotes the complete
 * source line, including qualifications; it does not infer a new restriction or venue-wide rule.
 */
export function guestAccessSourceNotices(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length <= 1_200 &&
        /\b(?:stairs?|steps?|transfer|wheelchair|ramp|lift|elevator|ladder)\b/iu.test(line) &&
        /\b(?:only|must|requires?|need(?:s)?|no|cannot|can't|not)\b/iu.test(line),
    )
}

/** Infer only a whole-route restriction with an explicit unavailable alternative.
 * Incidental stairs, partial routes and conditional/contradictory records stay in source prose.
 */
export function guestAccessFacts(semantics: GuestRecordSemantics, content: string): string[] {
  if (semantics.conditions.length || semantics.exceptions.length) return []
  const route = semantics.facts.find(
    (fact) =>
      /^(?:route|access|accessibility)$/iu.test(fact.label) &&
      /^(?:(?:the |this )?route )?(?:includes|requires|uses) stairs[.;,] ?(?:and )?(?:there is )?no (?:lift|elevator)(?: alternative)?\.?$/iu.test(
        fact.value.trim(),
      ),
  )
  if (!route) return []
  const otherLines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && line !== `${route.label}: ${route.value}`)
  // Only the ordinary identity sentence and clearly unrelated structured fields can accompany
  // this entailment. Unparsed prose may qualify the route; do not guess its scope.
  const harmlessLabel =
    /^(?:Price|Tax|Hours|Opening|Booking|Governed by|Also called|Notice class|Must mention|Location):/iu
  if (
    otherLines.some(
      (line, index) =>
        !harmlessLabel.test(line) && !(index === 0 && /^[^.:]+ is [^.:]+\.$/u.test(line)),
    )
  )
    return []
  if (
    /\b(?:stairs?|steps?|ramp|lift|elevator|step[- ]free|stair[- ]free|wheelchair|alternative|bypass|optional|unless|except|conditional|only|if|when|during|partial|portion|section)\b/iu.test(
      otherLines.join('\n'),
    )
  )
    return []
  return [
    `stepFree: false; wheelchairWithoutTransfer: false. This complete stated route cannot be completed while remaining in a wheelchair. Basis: ${route.label}: ${route.value} This does not establish whether staff can offer a different arrangement.`,
  ]
}
