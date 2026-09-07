const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu
const PHONE_NUMBER = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/gu
const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>()]+/giu

// This bounded filter removes common contact identifiers; it does not guarantee
// anonymity and does not remove names or other identifying context.
export function redactCommonIdentifiers(content: string): string {
  return content
    .replace(EMAIL_ADDRESS, '[email removed]')
    .replace(PHONE_NUMBER, '[phone removed]')
    .replace(WEB_ADDRESS, '[link removed]')
}
