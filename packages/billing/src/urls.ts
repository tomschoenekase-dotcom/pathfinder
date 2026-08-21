export function configuredBillingUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  if (
    base.protocol !== 'https:' &&
    base.hostname !== 'localhost' &&
    base.hostname !== '127.0.0.1'
  ) {
    throw new BillingUrlError('INSECURE_ORIGIN')
  }
  if (!path.startsWith('/') || path.startsWith('//')) throw new BillingUrlError('INVALID_PATH')
  const target = new URL(path, base)
  if (target.origin !== base.origin) throw new BillingUrlError('ORIGIN_MISMATCH')
  return target.toString()
}

export class BillingUrlError extends Error {
  constructor(readonly code: 'INSECURE_ORIGIN' | 'INVALID_PATH' | 'ORIGIN_MISMATCH') {
    super('The billing return URL is not allowed')
    this.name = 'BillingUrlError'
  }
}
