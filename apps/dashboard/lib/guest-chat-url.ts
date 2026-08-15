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

export function buildGuideItemEntryUrl(
  guestChatUrl: string | null,
  guideItem: { id: string; name: string },
): string | null {
  const id = guideItem.id.trim()
  const name = guideItem.name.trim()

  if (!guestChatUrl || !id || !name || name.length > 120) return null

  try {
    const url = new URL(guestChatUrl)
    if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/chat')) {
      return null
    }

    url.searchParams.set('entry', 'guide-item')
    url.searchParams.set('item', id)
    url.searchParams.set('prompt', `Tell me about ${name}.`)
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
  const guestUrl = buildGuestChatUrl(configuredOrigin, venueSlug, options)
  const key = accessKey?.trim()
  if (!guestUrl || !key || !/^[0-9a-f-]{36}$/iu.test(key)) return null
  const url = new URL(guestUrl)
  url.pathname = `/${encodeURIComponent(venueSlug.trim())}/layer/${encodeURIComponent(key)}/chat`
  return url.toString()
}
