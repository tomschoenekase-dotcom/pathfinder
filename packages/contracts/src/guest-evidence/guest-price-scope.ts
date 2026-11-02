import type { GuestRecordSemantics } from './guest-record-semantics'

export type GuestTaxStatus = 'included' | 'excluded' | 'unstated' | 'mixed'
export type GuestPriceItem = { name: string; cents: number; quantity: number; tax: GuestTaxStatus }

/** Tax belongs to the exact price clause, or a record-wide Tax line with explicit broad scope.
 * A scoped tax sentence about admission must not qualify rentals/menu items on the same record.
 */
export function guestTaxStatus(semantics: GuestRecordSemantics, priceText: string): GuestTaxStatus {
  if (
    /\btax\b/iu.test(priceText) &&
    /\b(?:may|might|unknown|unstated|not stated|not known|whether|ask|confirm)\b/iu.test(priceText)
  )
    return 'unstated'
  if ((priceText.match(/\$\d/gu)?.length ?? 0) > 1 && /\btax\b/iu.test(priceText)) return 'mixed'
  const classify = (text: string): GuestTaxStatus => {
    if (/\b(?:may|might|unknown|unstated|not stated|not known|whether|ask|confirm)\b/iu.test(text))
      return 'unstated'
    const negatedInclude =
      /\b(?:does? not|doesn't|don't|not) includ(?:e[sd]?|ing) (?:sales )?tax\b/giu
    const negated = negatedInclude.test(text)
    const affirmativeText = text.replace(negatedInclude, '')
    const excluded =
      negated ||
      /\b(?:before|excluding|excludes?|plus|without) (?:sales )?tax\b|\btax (?:is )?(?:extra|not included)\b/iu.test(
        text,
      )
    const included =
      /\b(?:including|includes?|inclusive of) (?:sales )?tax\b|\btax[- ]included\b/iu.test(
        affirmativeText,
      )
    if ((included || excluded) && /\b(?:but|except|only)\b/iu.test(text)) return 'mixed'
    return included && excluded
      ? 'mixed'
      : included
        ? 'included'
        : excluded
          ? 'excluded'
          : 'unstated'
  }
  const own = classify(priceText)
  if (own !== 'unstated') return own
  const taxLines = semantics.facts
    .filter((fact) => /^tax$/iu.test(fact.label))
    .map((fact) => fact.value)
  if (!taxLines.length) return 'unstated'
  // Only a whole-record declaration is safe to inherit. Other scope stays in source prose.
  if (
    taxLines.some(
      (text) =>
        !/^(?:(?:all |listed |all listed )?prices? (?:here )?(?:include|exclude) (?:sales )?tax\.?|(?:included|excluded|extra)\.?)$/iu.test(
          text.trim(),
        ),
    )
  )
    return 'unstated'
  const statuses = new Set(
    taxLines.map((text) =>
      /^(?:included)\.?$/iu.test(text)
        ? 'included'
        : /^(?:excluded|extra)\.?$/iu.test(text)
          ? 'excluded'
          : classify(text),
    ),
  )
  return statuses.size === 1 ? [...statuses][0]! : 'mixed'
}

/** Exact arithmetic over explicitly selected items. No guessed tax rates or discount eligibility. */
export function guestPriceTotal(
  items: ReadonlyArray<GuestPriceItem>,
  discountCents = 0,
): {
  cents: number
  qualifier: string
} | null {
  if (
    !items.length ||
    !Number.isSafeInteger(discountCents) ||
    discountCents < 0 ||
    items.some(
      (item) =>
        !Number.isSafeInteger(item.cents) ||
        item.cents < 0 ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1,
    )
  )
    return null
  const cents = items.reduce((sum, item) => sum + item.cents * item.quantity, 0) - discountCents
  if (!Number.isSafeInteger(cents) || cents < 0) return null
  const qualifier = items.every((item) => item.tax === 'included')
    ? 'including tax'
    : items.every((item) => item.tax === 'excluded')
      ? 'before tax'
      : 'sum of listed prices; final tax treatment is not established for every item'
  return { cents, qualifier }
}

export function guestPriceScopeFacts(semantics: GuestRecordSemantics): string[] {
  const prices = semantics.facts
    .filter((fact) => /\$\d/u.test(fact.value))
    .map((fact) => {
      const tax = guestTaxStatus(semantics, fact.value)
      const simple =
        /^\$(\d+)(?:\.(\d{2}))?(?:\s*(?:including tax|plus tax|before tax))?\.?$/iu.exec(
          fact.value.trim(),
        )
      const total = simple
        ? guestPriceTotal([
            {
              name: fact.label,
              cents: Number(simple[1]) * 100 + Number(simple[2] ?? 0),
              quantity: 1,
              tax,
            },
          ])
        : null
      return `${fact.label}: ${fact.value} [tax scope: ${tax}; applies only to this price record${total ? `; one listed charge: $${(total.cents / 100).toFixed(2)} ${total.qualifier}` : ''}]`
    })
  // Tax/fee declarations can explicitly cover named product categories in other records.
  // Keep that authored scope intact; neither infer a venue-wide rule nor falsely say unstated.
  const declarations = semantics.facts
    .filter((fact) => /\btax\b/iu.test(fact.value) && !/\$\d/u.test(fact.value))
    .map(
      (fact) =>
        `${fact.label}: ${fact.value} [explicit tax declaration: covers only the prices or categories this statement names; an unqualified declaration applies only within this record]`,
    )
  return [...prices, ...declarations]
}
