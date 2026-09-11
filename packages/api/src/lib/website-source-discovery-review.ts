import { WebsiteSourceDiscovery } from '@pathfinder/contracts/intake-engine'

export function projectWebsiteSourceDiscovery(input: {
  receiptId: string
  websiteUri: string | null
  discoverySnapshot: unknown
}) {
  const unavailable = (status: 'NOT_RECORDED' | 'INVALID') => ({
    receiptId: input.receiptId,
    status,
    sourceHost: null,
    inventory: null,
  })
  if (input.discoverySnapshot == null) return unavailable('NOT_RECORDED')
  const parsed = WebsiteSourceDiscovery.safeParse(input.discoverySnapshot)
  if (!parsed.success || !input.websiteUri) return unavailable('INVALID')
  let source: URL
  try {
    source = new URL(input.websiteUri)
  } catch {
    return unavailable('INVALID')
  }
  const normalizedHost = (url: URL) => url.hostname.toLowerCase().replace(/\.$/u, '')
  const sourceHost = normalizedHost(source)
  if (
    !['http:', 'https:'].includes(source.protocol) ||
    source.username ||
    source.password ||
    source.port ||
    parsed.data.items.some((item) =>
      [item.url, item.parentUrl, item.duplicateOf].some(
        (url) => url != null && normalizedHost(new URL(url)) !== sourceHost,
      ),
    )
  )
    return unavailable('INVALID')
  return {
    receiptId: input.receiptId,
    status: 'RECORDED' as const,
    sourceHost,
    inventory: parsed.data,
  }
}
