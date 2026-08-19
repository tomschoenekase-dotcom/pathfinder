type BrowserCrypto = {
  randomUUID?: (() => string) | undefined
  getRandomValues?: ((array: Uint8Array) => Uint8Array) | undefined
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/**
 * Returns an RFC 4122 version-4 UUID without assuming `crypto.randomUUID`
 * exists. Plain-HTTP LAN origins and older embedded mobile browsers may expose
 * `getRandomValues` but not `randomUUID`.
 */
export function browserUuid(
  cryptoApi: BrowserCrypto | undefined = globalThis.crypto,
): string | null {
  if (!cryptoApi) return null

  if (typeof cryptoApi.randomUUID === 'function') {
    try {
      const value = cryptoApi.randomUUID()
      if (UUID_V4.test(value)) return value
    } catch {
      // Fall through to cryptographic bytes when the platform method fails.
    }
  }

  if (typeof cryptoApi.getRandomValues !== 'function') return null

  try {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return null
  }
}
