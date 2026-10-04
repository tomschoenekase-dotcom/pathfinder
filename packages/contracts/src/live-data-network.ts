import { isIP } from 'node:net'

/**
 * Server-only address classification for the live-data fetcher. Called on every address a host
 * name resolves to and again for every redirect target. Fails closed: only globally routable
 * unicast addresses are public.
 */

function ipv4Octets(address: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return null
  return octets as [number, number, number, number]
}

function isPublicIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || // link-local, including 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase()
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value)
  if (embedded) {
    const octets = ipv4Octets(embedded[1]!)
    if (!octets) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    value = `${value.slice(0, -embedded[1]!.length)}${high}:${low}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/u.test(group) ? parseInt(group, 16) : NaN))
  return parsed.some(Number.isNaN) ? null : parsed
}

/** True only for a globally routable address; unparsable input is never public. */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const octets = ipv4Octets(address)
    return octets !== null && isPublicIpv4(octets)
  }
  if (family === 6) {
    const groups = expandIpv6(address)
    if (!groups) return false
    // IPv4-mapped (::ffff:a.b.c.d) inherits the IPv4 verdict; IPv4-compatible and ::/:: are never public.
    if (
      groups.slice(0, 5).every((group) => group === 0) &&
      (groups[5] === 0xffff || groups[5] === 0)
    ) {
      const octets: [number, number, number, number] = [
        groups[6]! >> 8,
        groups[6]! & 0xff,
        groups[7]! >> 8,
        groups[7]! & 0xff,
      ]
      return groups[5] === 0xffff && isPublicIpv4(octets)
    }
    const first = groups[0]!
    if ((first & 0xe000) !== 0x2000) return false // outside 2000::/3
    if (first === 0x2001 && groups[1]! === 0x0db8) return false // documentation
    if (first === 0x3fff && groups[1]! < 0x1000) return false // documentation 3fff::/20 (RFC 9637)
    if (first === 0x2001 && groups[1]! < 0x0200) return false // Teredo and IETF protocol space
    if (first === 0x2002) return false // 6to4 can embed private IPv4
    return true
  }
  return false
}
