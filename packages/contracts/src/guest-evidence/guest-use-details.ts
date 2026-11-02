/** Exact source lines whose obligations can accompany affirmative use advice. This is a
 * highlight, not a new policy: all scopes, conditions, permissions and negations stay intact. */
export function guestUseSourceDetails(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line.length <= 1_200 &&
        !/^(?:Unknown|Not stated|Unconfirmed|Notice class|Kind|Type|Also called|Does not apply to)\s*:/iu.test(
          line,
        ) &&
        (/^(?:Price|Prices|Fare|Fares|Fee|Fees|Tax|Booking|Reservation|Permission|Equipment|Entry|Admission|Deadline|Collection)\s*:/iu.test(
          line,
        ) ||
          /\$\s*\d|\b(?:sales tax|before tax|including tax|separate (?:\w+ )?(?:entry|admission)|advance (?:booking|reservation)|must (?:buy|book|reserve|pay|collect)|enter free)\b/iu.test(
            line,
          )),
    )
}
