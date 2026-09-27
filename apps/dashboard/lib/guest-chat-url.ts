import { buildVenueAccessArtifacts } from '@pathfinder/contracts/venue-access-artifacts'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const STAGING_WEB_ORIGIN = 'https://staging-web-staging-bbeb.up.railway.app'

/** Keep the approved staging visitor origin usable when its optional public URL is unset. */
export function resolveGuestWebOrigin(
  configuredOrigin: string | null | undefined,
  environment: string | undefined,
): string | null | undefined {
  if (configuredOrigin?.trim()) return configuredOrigin
  return environment === 'staging' ? STAGING_WEB_ORIGIN : configuredOrigin
}

type GuestChatUrlOptions = {
  allowLoopbackHttp?: boolean
}

export function buildGuestChatUrl(
  configuredOrigin: string | null | undefined,
  venueSlug: string,
  options: GuestChatUrlOptions = {},
): string | null {
  const artifacts = buildVenueAccessArtifacts(configuredOrigin, venueSlug, options)
  if (artifacts) return artifacts.publicUrl

  // Existing dashboard URLs encoded legacy venue slugs; the new artifact contract only
  // emits canonical slugs, while this wrapper keeps previously usable one-segment URLs.
  const rawOrigin = configuredOrigin?.trim()
  const rawSlug = venueSlug.trim()
  if (
    !rawOrigin ||
    !rawSlug ||
    rawSlug === '.' ||
    rawSlug === '..' ||
    rawSlug.includes('/') ||
    rawSlug.includes('\\') ||
    rawSlug.includes('?') ||
    rawSlug.includes('#') ||
    Array.from(rawSlug).some((character) => character.codePointAt(0)! < 32)
  )
    return null

  try {
    const origin = new URL(rawOrigin)
    const isSecure = origin.protocol === 'https:'
    const isLoopbackDevelopment =
      options.allowLoopbackHttp === true &&
      origin.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(origin.hostname)
    const isExactOrigin = rawOrigin === origin.origin || rawOrigin === `${origin.origin}/`
    if (
      (!isSecure && !isLoopbackDevelopment) ||
      !isExactOrigin ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== ''
    )
      return null

    return new URL(`/${encodeURIComponent(rawSlug)}/chat`, origin.origin).toString()
  } catch {
    return null
  }
}

export function buildQrEntryUrl(guestChatUrl: string | null): string | null {
  try {
    if (!guestChatUrl) return null
    const url = new URL(guestChatUrl)
    if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/chat'))
      return null
    url.searchParams.set('source', 'qr')
    return url.toString()
  } catch {
    return null
  }
}

export function buildSecondLayerChatUrl(
  configuredOrigin: string | null | undefined,
  venueSlug: string,
  accessKey: string | null | undefined,
  options: GuestChatUrlOptions = {},
): string | null {
  const key = accessKey?.trim()
  const guestUrl = buildGuestChatUrl(configuredOrigin, venueSlug, options)
  if (!guestUrl || !key || !/^[0-9a-f-]{36}$/iu.test(key)) return null
  const url = new URL(guestUrl)
  url.pathname = `/${encodeURIComponent(venueSlug.trim())}/layer/${encodeURIComponent(key)}/chat`
  return url.toString()
}
