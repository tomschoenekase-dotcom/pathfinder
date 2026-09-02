const DEFAULT_BODY_READ_MS = 5_000

export class BoundedJsonBodyError extends Error {
  constructor(readonly code: 'BODY_TOO_LARGE' | 'BODY_TIMEOUT' | 'INVALID_JSON') {
    super(code)
    this.name = 'BoundedJsonBodyError'
  }
}

function fail(code: BoundedJsonBodyError['code']): never {
  throw new BoundedJsonBodyError(code)
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
  options: { emptyValue?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BODY_READ_MS
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('BODY_TOO_LARGE')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('BODY_TIMEOUT')

  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    fail('BODY_TOO_LARGE')
  }
  if (!request.body) {
    if (Object.hasOwn(options, 'emptyValue')) return options.emptyValue
    fail('INVALID_JSON')
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > maxBytes) fail('BODY_TOO_LARGE')
        chunks.push(value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      } catch {
        fail('INVALID_JSON')
      }
    })()
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new BoundedJsonBodyError('BODY_TIMEOUT')), timeoutMs)
    })
    return await Promise.race([read, deadline])
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    reader.releaseLock()
  }
}
