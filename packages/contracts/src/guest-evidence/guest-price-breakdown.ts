// Component subtotals for a plainly stated entry party. A missing/ambiguous party,
// overlapping tariff or activity-participant price leaves arithmetic to source reasoning.
type Member = { label: string; age: number | null; adult: boolean; quantity: number }
const COUNT: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
}
function count(text: string): number {
  return COUNT[text.toLowerCase()] ?? Number(text)
}

const COMPONENT_LABEL = /\b(?:entry|admission|ticket|supplement)\b/iu
const MONEY = String.raw`\$\d+(?:\.\d{2})?`
const AGE_MINIMUM = String.raw`ages? \d{1,2} and (?:older|over)`
const TARIFF_CLAUSE = new RegExp(
  `^(?:Adults?(?: ${AGE_MINIMUM})? ${MONEY}|ages? \\d{1,2} (?:through|to|-) \\d{1,2} ${MONEY}|under \\d{1,2} free(?: with an? adult)?|${MONEY} per person(?: ${AGE_MINIMUM})?)$`,
  'iu',
)
function completeTariffClause(clause: string): boolean {
  return TARIFF_CLAUSE.test(
    clause
      .trim()
      .replace(/[.]$/u, '')
      .replace(/,?\s*(?:including tax|tax included|before tax|plus tax)\b/giu, '')
      .trim(),
  )
}

/** Only recognized non-price metadata is harmless to these listed component subtotals.
 * Unparsed conditions, charges, dates or prose can govern the entire record, so refuse it. */
function harmlessMetadata(line: string): boolean {
  if (/^Kind:\s*(?:ITEM|admission pricing|ticket pricing)\.?$/iu.test(line)) return true
  if (
    /^Tax:\s*(?:Included|Excluded|Extra|(?:(?:All|Listed) )?prices? (?:include|exclude) (?:sales )?tax)\.?$/iu.test(
      line,
    )
  )
    return true
  if (/^Unknown:\s*(?:Student|Member|Resident) discount\.?$/iu.test(line)) return true
  return (
    /^Inclusions:\s*\S/iu.test(line) &&
    !/\$|\d|\b(?:if|when|unless|only|except|before|after|prices?|rates?|fees?|charges?|costs?|tax|doubl\w*|half|halv\w*|surcharg\w*|discount\w*|increas\w*|decreas\w*|week\w*)\b/iu.test(
      line,
    )
  )
}

export function guestEntryPriceBreakdown(question: string, content: string): string[] {
  if (!/\b(?:total|cost|price|pay|entry|admission)\b/iu.test(question)) return []
  if (/\b(?:discount|member|student|resident|coupon|voucher)\b/iu.test(question)) return []
  const adult = question.match(/\b(a|an|one|two|three|four|five|six|\d{1,2}) adults?\b/iu)
  const child = question.match(/\b(?:a|one|1) child (?:aged? )?(\d{1,2})\b/iu)
  if (!adult || !child) return []
  const between = question.slice(adult.index! + adult[0].length, child.index)
  const remainder = question
    .replace(adult[0], '')
    .replace(child[0], '')
    .replace(/\band\b/iu, '')
  if (!/^\s+and\s+$/iu.test(between) || /\b(?:plus|with|and)\b|,/iu.test(remainder)) return []
  // Only one unambiguous child and adult group. Do not silently drop extra people.
  if (
    (question.match(/\b(?:adults?|child|children|kids?|infants?|bab(?:y|ies)|seniors?)\b/giu)
      ?.length ?? 0) !== 2
  )
    return []
  const members: Member[] = [
    { label: 'adults', age: null, adult: true, quantity: count(adult[1]!) },
    { label: `child age ${child[1]}`, age: Number(child[1]), adult: false, quantity: 1 },
  ]
  if (members.some((member) => !Number.isInteger(member.quantity) || member.quantity < 1)) return []
  const components: Array<{ label: string; clauses: string[] }> = []
  for (const line of content
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const labeled = /^([^:]{1,60}):\s*(.+)$/u.exec(line)
    if (labeled && COMPONENT_LABEL.test(labeled[1]!)) {
      const clauses = labeled[2]!.split(/\s*;\s*/u)
      // Every tariff clause must parse, including clauses for people outside this party.
      // Dropping an override/add-on would incorrectly turn the remainder into a complete price.
      if (!clauses.every(completeTariffClause)) return []
      components.push({ label: labeled[1]!, clauses })
    } else if (!harmlessMetadata(line)) return []
  }
  const result: string[] = []
  for (const component of components) {
    const terms: string[] = []
    let total = 0
    for (const member of members) {
      const rates = component.clauses.flatMap((clause) => {
        const amount = clause.match(/\$(\d+)(?:\.(\d{2}))?\b/u)
        const free = /\bfree\b/iu.test(clause)
        if ((!amount && !free) || (clause.match(/\$/gu)?.length ?? 0) > 1) return []
        if (/\b(?:unless|except|discount|member|student|resident)\b/iu.test(clause)) return []
        if (/\bwith an? adult\b/iu.test(clause) && !members.some((m) => m.adult)) return []
        const range = clause.match(/\bages? (\d{1,2}) (?:through|to|-) (\d{1,2})\b/iu)
        const minimum = clause.match(/\bages? (\d{1,2}) (?:and (?:older|over)|\+)\b/iu)
        const under = clause.match(/\bunder (\d{1,2})\b/iu)
        const adults = /\badults?\b/iu.test(clause)
        const age = member.age
        const matches = range
          ? age !== null && age >= Number(range[1]) && age <= Number(range[2])
          : under
            ? age !== null && age < Number(under[1])
            : minimum
              ? age !== null
                ? age >= Number(minimum[1])
                : member.adult && Number(minimum[1]) <= 18
              : adults
                ? member.adult
                : /\bper person\b/iu.test(clause)
        return matches ? [amount ? Number(amount[1]) * 100 + Number(amount[2] ?? 0) : 0] : []
      })
      if (rates.length !== 1) {
        terms.length = 0
        break
      }
      total += rates[0]! * member.quantity
      terms.push(`${member.quantity} ${member.label} x $${(rates[0]! / 100).toFixed(2)}`)
    }
    if (terms.length === members.length)
      result.push(
        `${component.label}: ${terms.join(' + ')} = $${(total / 100).toFixed(2)} listed subtotal. Each rate comes only from this component's own tariff; this does not select the component or establish extra tax.`,
      )
  }
  return result
}
