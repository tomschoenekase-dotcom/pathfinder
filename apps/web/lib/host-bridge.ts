export const HOST_BRIDGE_VERSION = 1
const MAX_MESSAGE_BYTES = 1_024
const MAX_ASK_LENGTH = 200
const MAX_PLACE_LENGTH = 191

export type HostPrefill = { ask?: string; place?: string }
export type HostBridgeMessage = {
  source: 'torchiko'
  v: 1
  type: 'open' | 'close' | 'prefill' | 'ready' | 'close-requested' | 'height'
  payload: HostPrefill | { height: number } | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point < 32 || point === 127
  })
}

export function parseHostAsk(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (containsControl(value)) return undefined
  const ask = value.trim().replace(/\s+/gu, ' ')
  if (!ask || [...ask].length > MAX_ASK_LENGTH) return undefined
  return ask
}

export function parseHostPlace(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const place = value.trim()
  if (!place || place.length > MAX_PLACE_LENGTH || containsControl(place)) return undefined
  return place
}

export function parseHostStartParams(query: Record<string, string | string[] | undefined>) {
  return {
    ask: parseHostAsk(query.ask),
    place: parseHostPlace(query.place),
  }
}

export function parseHostPrefill(value: unknown): HostPrefill | null {
  if (!record(value) || Object.keys(value).some((key) => key !== 'ask' && key !== 'place'))
    return null
  const ask = value.ask === undefined ? undefined : parseHostAsk(value.ask)
  const place = value.place === undefined ? undefined : parseHostPlace(value.place)
  if ((value.ask !== undefined && !ask) || (value.place !== undefined && !place)) return null
  return ask || place ? { ...(ask ? { ask } : {}), ...(place ? { place } : {}) } : null
}

export function parseHostToGuideMessage(value: unknown): HostBridgeMessage | null {
  if (!record(value)) return null
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_MESSAGE_BYTES) return null
  } catch {
    return null
  }
  if (
    Object.keys(value).length !== 4 ||
    Object.keys(value).some((key) => !['source', 'v', 'type', 'payload'].includes(key))
  )
    return null
  if (value.source !== 'torchiko' || value.v !== HOST_BRIDGE_VERSION) return null
  if (value.type === 'open' || value.type === 'close')
    return value.payload === null
      ? { source: 'torchiko', v: 1, type: value.type, payload: null }
      : null
  if (value.type === 'prefill') {
    const payload = parseHostPrefill(value.payload)
    return payload ? { source: 'torchiko', v: 1, type: 'prefill', payload } : null
  }
  return null
}

export function normalizeBridgeOrigins(origins: readonly string[]): string[] {
  if (origins.length > 20) return []
  const result = new Set<string>()
  for (const value of origins) {
    if (typeof value !== 'string' || value.length > 2048) return []
    try {
      const url = new URL(value)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.origin + (value.endsWith('/') ? '/' : '') !== value
      )
        return []
      result.add(url.origin)
    } catch {
      return []
    }
  }
  return [...result]
}
