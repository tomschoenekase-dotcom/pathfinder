const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

type GuestChatUrlOptions = {
  allowLoopbackHttp?: boolean
}

export function buildGuestChatUrl(
  configuredOrigin: string | null | undefined,
  venueSlug: string,
  options: GuestChatUrlOptions = {},
): string | null {
  const rawOrigin = configuredOrigin?.trim()
  const rawSlug = venueSlug.trim()

  if (!rawOrigin || !rawSlug || rawSlug === '.' || rawSlug === '..') {
    return null
  }

  try {
    const origin = new URL(rawOrigin)
    const isSecure = origin.protocol === 'https:'
    const isLoopbackDevelopment =
      options.allowLoopbackHttp === true &&
      origin.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(origin.hostname)
    const isExactCanonicalOrigin = rawOrigin === origin.origin || rawOrigin === `${origin.origin}/`

    if (
      (!isSecure && !isLoopbackDevelopment) ||
      !isExactCanonicalOrigin ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== ''
    ) {
      return null
    }

    return new URL(`/${encodeURIComponent(rawSlug)}/chat`, origin.origin).toString()
  } catch {
    return null
  }
}
