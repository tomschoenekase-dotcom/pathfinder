export class UploadDeadlineError extends Error {
  constructor() {
    super('UPLOAD_DEADLINE_EXCEEDED')
    this.name = 'UploadDeadlineError'
  }
}

function abortError() {
  return new DOMException('Upload was cancelled.', 'AbortError')
}

function cancelResponse(response: Response) {
  void response.body?.cancel('upload-response-consumed').catch(() => undefined)
}

export async function putBlobWithDeadline(input: {
  url: string
  headers?: HeadersInit
  body: Blob
  signal?: AbortSignal
  timeoutMs: number
}): Promise<{ ok: boolean; status: number; headers: Headers }> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new UploadDeadlineError()
  }
  if (input.signal?.aborted) throw abortError()

  const controller = new AbortController()
  let deadlineElapsed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortFromCaller = () => undefined
  const callerCancellation = new Promise<never>((_, reject) => {
    abortFromCaller = () => {
      controller.abort()
      reject(abortError())
    }
    input.signal?.addEventListener('abort', abortFromCaller, { once: true })
  })
  try {
    const request = fetch(input.url, {
      method: 'PUT',
      ...(input.headers ? { headers: input.headers } : {}),
      body: input.body,
      signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) {
        cancelResponse(response)
        throw input.signal?.aborted ? abortError() : new UploadDeadlineError()
      }
      return response
    })
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        deadlineElapsed = true
        controller.abort()
        reject(new UploadDeadlineError())
      }, input.timeoutMs)
    })
    const response = await Promise.race([request, deadline, callerCancellation])
    cancelResponse(response)
    return { ok: response.ok, status: response.status, headers: response.headers }
  } catch (error) {
    if (deadlineElapsed) throw new UploadDeadlineError()
    if (input.signal?.aborted) throw abortError()
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abortFromCaller)
  }
}
