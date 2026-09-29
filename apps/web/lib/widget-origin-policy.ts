const MAX_ORIGIN_LENGTH = 2_048
const MAX_FRAME_ANCESTORS_BYTES = 4_096
const VENUE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SELF_ONLY_FRAME_ANCESTORS = "frame-ancestors 'self'"

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

/** Website widget document paths allowed to receive tenant-owned frame ancestors. */
export function extractExactWebsiteEmbedVenueSlug(pathname: string): string | null {
  if (!pathname.startsWith('/embed/')) return null
  const remainder = pathname.slice('/embed/'.length)
  const segments = remainder.split('/')
  if (segments.length === 1) return extractExactEmbedVenueSlug(pathname)
  if (segments.length !== 2 || segments[1] !== 'inline') return null
  return extractExactEmbedVenueSlug(`/embed/${segments[0]}`)
}

export function buildWidgetFrameAncestors(configuredOrigins: readonly string[]): string {
  if (!Array.isArray(configuredOrigins) || configuredOrigins.length > 20)
    return SELF_ONLY_FRAME_ANCESTORS
  const origins = new Set<string>()
  for (const value of configuredOrigins) {
    const origin = normalizeHttpsOrigin(value)
    if (!origin) return SELF_ONLY_FRAME_ANCESTORS
    origins.add(origin)
  }
  if (origins.size === 0) return SELF_ONLY_FRAME_ANCESTORS
  const directive = `${SELF_ONLY_FRAME_ANCESTORS} ${[...origins].sort().join(' ')}`
  return new TextEncoder().encode(directive).byteLength <= MAX_FRAME_ANCESTORS_BYTES
    ? directive
    : SELF_ONLY_FRAME_ANCESTORS
}
