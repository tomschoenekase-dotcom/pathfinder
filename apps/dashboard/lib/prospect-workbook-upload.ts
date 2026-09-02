const PROSPECT_WORKBOOK_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000

export const PROSPECT_WORKBOOK_UPLOAD_ERROR =
  'Workbook upload did not complete. The reserved import was not started; try the dry run again.'

function cancelResponse(response: Response) {
  void response.body?.cancel('prospect-workbook-response-consumed').catch(() => undefined)
}

export async function uploadProspectWorkbook(input: {
  url: string
  requiredHeaders: HeadersInit
  file: File
}): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const request = fetch(input.url, {
      method: 'PUT',
      headers: input.requiredHeaders,
      body: input.file,
      signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) {
        cancelResponse(response)
        throw new Error(PROSPECT_WORKBOOK_UPLOAD_ERROR)
      }
      return response
    })
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error(PROSPECT_WORKBOOK_UPLOAD_ERROR))
      }, PROSPECT_WORKBOOK_UPLOAD_TIMEOUT_MS)
    })
    const response = await Promise.race([request, deadline])
    cancelResponse(response)
    if (!response.ok) throw new Error(PROSPECT_WORKBOOK_UPLOAD_ERROR)
  } catch {
    throw new Error(PROSPECT_WORKBOOK_UPLOAD_ERROR)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
