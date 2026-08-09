import { isEmbedPreviewEnabled } from '@pathfinder/config/feature-flags'

const MAX_POLICY_BYTES = 16_384
const MAX_VENUES = 100
const MAX_ORIGINS_PER_VENUE = 20
const MAX_ORIGIN_LENGTH = 2_048
const MAX_FRAME_ANCESTORS_BYTES = 4_096
const VENUE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SELF_ONLY_FRAME_ANCESTORS = "frame-ancestors 'self'"

type WidgetOriginPolicy = ReadonlyMap<string, readonly string[]>

function normalizeHttpsOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ORIGIN_LENGTH ||
    value.trim() !== value ||
    /[^\x21-\x7e]/.test(value) ||
    value.includes('*')
  ) {
    return null
  }

  try {
    const url = new URL(value)
    const authorityAndPath = value.slice(value.indexOf('://') + 3)
    const authority = authorityAndPath.endsWith('/')
      ? authorityAndPath.slice(0, -1)
      : authorityAndPath
    if (
      url.protocol !== 'https:' ||
      url.hostname.includes('*') ||
      /[/?#]/.test(authority) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function parseWidgetOriginPolicy(rawPolicy: string | undefined): WidgetOriginPolicy | null {
  if (rawPolicy === undefined || rawPolicy.trim().length === 0) {
    return new Map()
  }
  if (new TextEncoder().encode(rawPolicy).byteLength > MAX_POLICY_BYTES) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawPolicy)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }

  const entries = Object.entries(parsed)
  if (entries.length > MAX_VENUES) {
    return null
  }

  const policy = new Map<string, readonly string[]>()
  for (const [venueSlug, configuredOrigins] of entries) {
    if (
      venueSlug.length > 200 ||
      !VENUE_SLUG_PATTERN.test(venueSlug) ||
      !Array.isArray(configuredOrigins) ||
      configuredOrigins.length > MAX_ORIGINS_PER_VENUE
    ) {
      return null
    }

    const origins = new Set<string>()
    for (const configuredOrigin of configuredOrigins) {
      const origin = normalizeHttpsOrigin(configuredOrigin)
      if (!origin) return null
      origins.add(origin)
    }
    policy.set(venueSlug, [...origins].sort())
  }

  return policy
}

export function extractExactEmbedVenueSlug(pathname: string): string | null {
  if (!pathname.startsWith('/embed/')) return null
  const encodedSlug = pathname.slice('/embed/'.length)
  if (
    encodedSlug.length === 0 ||
    encodedSlug.length > 200 ||
    encodedSlug.includes('/') ||
    encodedSlug.includes('%') ||
    !VENUE_SLUG_PATTERN.test(encodedSlug)
  ) {
    return null
  }
  return encodedSlug
}

export function buildWidgetFrameAncestors(
  pathname: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') return SELF_ONLY_FRAME_ANCESTORS
  if (!isEmbedPreviewEnabled(environment)) return SELF_ONLY_FRAME_ANCESTORS

  const venueSlug = extractExactEmbedVenueSlug(pathname)
  if (!venueSlug) return SELF_ONLY_FRAME_ANCESTORS

  const policy = parseWidgetOriginPolicy(environment.WIDGET_PREVIEW_ORIGINS_JSON)
  const origins = policy?.get(venueSlug)
  if (!origins || origins.length === 0) return SELF_ONLY_FRAME_ANCESTORS

  const directive = `${SELF_ONLY_FRAME_ANCESTORS} ${origins.join(' ')}`
  return new TextEncoder().encode(directive).byteLength <= MAX_FRAME_ANCESTORS_BYTES
    ? directive
    : SELF_ONLY_FRAME_ANCESTORS
}
