import { createHash } from 'node:crypto'

const LEGAL_SUFFIXES = new Set([
  'association',
  'co',
  'company',
  'corp',
  'corporation',
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'nonprofit',
  'the',
])

export function normalizeProspectName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((part, index, all) => !(LEGAL_SUFFIXES.has(part) && index === all.length - 1))
    .join(' ')
}

export function normalizeProspectDomain(value: string | null | undefined): string | null {
  const candidate = value?.trim()
  if (!candidate) return null
  try {
    const parsed = new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '')
    return hostname || null
  } catch {
    return null
  }
}

export function normalizeProspectEmail(value: string | null | undefined): string | null {
  const candidate = value?.trim().toLowerCase()
  return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function prospectSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export type DuplicateSignals = {
  organizationName?: boolean
  venueName?: boolean
  domain?: boolean
  address?: boolean
  contactEmail?: boolean
}

export function scoreProspectDuplicate(signals: DuplicateSignals): {
  confidence: number
  reasons: string[]
} {
  const reasons: string[] = []
  if (signals.contactEmail) reasons.push('exact-contact-email')
  if (signals.domain) reasons.push('exact-domain')
  if (signals.address) reasons.push('exact-address')
  if (signals.organizationName) reasons.push('normalized-organization-name')
  if (signals.venueName) reasons.push('normalized-venue-name')

  let confidence = 0
  if (signals.contactEmail) confidence = 1
  else if (signals.domain && (signals.organizationName || signals.venueName)) confidence = 0.98
  else if (signals.domain) confidence = 0.92
  else if (signals.address && signals.venueName) confidence = 0.94
  else if (signals.organizationName && signals.venueName) confidence = 0.9
  else if (signals.venueName) confidence = 0.78
  else if (signals.organizationName) confidence = 0.72

  return { confidence, reasons }
}
