type BrowserCrypto = {
  randomUUID?: (() => string) | undefined
  getRandomValues<T extends ArrayBufferView | null>(array: T): T
}

/**
 * Generates an RFC 4122 version-4 UUID without assuming a secure browser
 * context. `crypto.randomUUID` is unavailable on plain-HTTP LAN origins in
 * several mobile browsers, while `crypto.getRandomValues` remains available.
 */
export function browserUuid(cryptoApi: BrowserCrypto = globalThis.crypto): string {
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}
