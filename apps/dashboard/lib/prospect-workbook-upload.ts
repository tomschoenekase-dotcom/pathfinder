import { putBlobWithDeadline } from './bounded-upload'

const PROSPECT_WORKBOOK_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000

export const PROSPECT_WORKBOOK_UPLOAD_ERROR =
  'Workbook upload did not complete. The reserved import was not started; try the dry run again.'

export async function uploadProspectWorkbook(input: {
  url: string
  requiredHeaders: HeadersInit
  file: File
  signal?: AbortSignal
}): Promise<void> {
  try {
    const response = await putBlobWithDeadline({
      url: input.url,
      headers: input.requiredHeaders,
      body: input.file,
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: PROSPECT_WORKBOOK_UPLOAD_TIMEOUT_MS,
    })
    if (!response.ok) throw new Error(PROSPECT_WORKBOOK_UPLOAD_ERROR)
  } catch {
    throw new Error(PROSPECT_WORKBOOK_UPLOAD_ERROR)
  }
}
