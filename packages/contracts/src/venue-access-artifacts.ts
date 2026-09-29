const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/gu, (character) => HTML_ESCAPE[character]!)
}

export type VenueAccessArtifactOptions = {
  allowLoopbackHttp?: boolean
  appBackground?: string
  hostGuideUrl?: string
}

export type VenueAccessArtifacts = {
  publicUrl: string
  qrUrl: string
  launcherSnippet: string
  inlineSnippet: string
  appUrl: string
  compactAppUrl: string
  appBackground: string | null
  hostGuideUrl: string | null
}

/** Derive every public entry artifact from one exact web origin and venue slug. */
export function buildVenueAccessArtifacts(
  webOrigin: string | null | undefined,
  venueSlug: string,
  options: VenueAccessArtifactOptions = {},
): VenueAccessArtifacts | null {
  const rawOrigin = webOrigin?.trim()
  const slug = venueSlug.trim()
  if (
    !rawOrigin ||
    venueSlug !== slug ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ||
    (options.appBackground !== undefined && !/^#[0-9a-f]{6}$/iu.test(options.appBackground))
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
    ) {
      return null
    }

    const slugPath = encodeURIComponent(slug)
    const safeSlugAttribute = escapeHtmlAttribute(slug)
    const publicUrl = new URL(`/${slugPath}/chat`, origin.origin).toString()
    const qr = new URL(publicUrl)
    qr.searchParams.set('source', 'qr')
    const loaderUrl = new URL('/widget.js', origin.origin).toString()
    const hostGuideUrl = options.hostGuideUrl ?? null
    return {
      publicUrl,
      qrUrl: qr.toString(),
      launcherSnippet: `<script src="${loaderUrl}" data-torchiko-venue="${safeSlugAttribute}" async></script>`,
      inlineSnippet: `<div data-torchiko-inline="${safeSlugAttribute}" style="height: 720px"></div>\n<script src="${loaderUrl}" async></script>`,
      appUrl: new URL(`/app/${slugPath}`, origin.origin).toString(),
      compactAppUrl: new URL(`/app/${slugPath}?header=compact`, origin.origin).toString(),
      appBackground: options.appBackground ?? null,
      hostGuideUrl,
    }
  } catch {
    return null
  }
}
