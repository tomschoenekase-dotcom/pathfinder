/**
 * Public-URL guard for source links. Nothing in the operator fetches a source; this exists so a
 * source kind can refuse private or internal targets before it ever creates a proposal.
 */
export class OperatorUrlError extends Error {
  readonly code = 'INVALID_URL'
}

function ipv4Octets(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet <= 255) ? octets : null
}

function privateIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function privateIpv6(host: string): boolean {
  const value = host.slice(1, -1).toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value)
  if (mapped) {
    const octets = ipv4Octets(mapped[1]!)
    return octets === null || privateIpv4(octets)
  }
  // Only global unicast (2000::/3) outside documentation space is treated as public.
  return !/^[23]/u.test(value) || value.startsWith('2001:db8')
}

/** Returns the parsed URL, or throws OperatorUrlError. Ports other than 443 are allowed. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OperatorUrlError('The URL is not valid.')
  }
  if (url.protocol !== 'https:') throw new OperatorUrlError('Only https URLs are allowed.')
  if (url.username !== '' || url.password !== '') {
    throw new OperatorUrlError('URLs with credentials are not allowed.')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (host.startsWith('[')) {
    if (privateIpv6(host)) throw new OperatorUrlError('Private addresses are not allowed.')
    return url
  }
  const octets = ipv4Octets(host)
  if (octets) {
    if (privateIpv4(octets)) throw new OperatorUrlError('Private addresses are not allowed.')
    return url
  }
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    /\.(?:localhost|local|internal|lan|home|corp|test|example|invalid)$/u.test(host)
  ) {
    throw new OperatorUrlError('Internal host names are not allowed.')
  }
  return url
}
