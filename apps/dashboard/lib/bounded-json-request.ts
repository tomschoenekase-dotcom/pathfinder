const DEFAULT_MAX_BODY_BYTES = 64 * 1024
const DEFAULT_BODY_READ_MS = 5_000

export type BoundedJsonRequestErrorCode =
  | 'INVALID_CONTENT_LENGTH'
  | 'BODY_TOO_LARGE'
  | 'BODY_TIMEOUT'
  | 'INVALID_JSON'

export class BoundedJsonRequestError extends Error {
  constructor(readonly code: BoundedJsonRequestErrorCode) {
    super(code)
    this.name = 'BoundedJsonRequestError'
  }
}

function fail(code: BoundedJsonRequestErrorCode): never {
  throw new BoundedJsonRequestError(code)
}

export async function readBoundedJsonRequest(
  request: Request,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_BODY_READ_MS
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('BODY_TOO_LARGE')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('BODY_TIMEOUT')

  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) fail('INVALID_CONTENT_LENGTH')
    if (Number(declaredLength) > maxBytes) fail('BODY_TOO_LARGE')
  }
  if (!request.body) fail('INVALID_JSON')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const body = (async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        totalBytes += chunk.value.byteLength
        if (totalBytes > maxBytes) fail('BODY_TOO_LARGE')
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(totalBytes)
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
      timeout = setTimeout(() => reject(new BoundedJsonRequestError('BODY_TIMEOUT')), timeoutMs)
    })
    return await Promise.race([body, deadline])
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    reader.releaseLock()
  }
}
