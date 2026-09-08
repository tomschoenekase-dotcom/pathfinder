export const INTAKE_V1_FILE_EXTRACTION_POLICY_VERSION = 'intake-v1-file-extraction-v1'
export const INTAKE_V1_FILE_EXTRACTION_PDF_MAX_BYTES = 10_485_760
export const INTAKE_V1_FILE_EXTRACTION_TEXT_MAX_BYTES = 2_097_152

const textMimeTypes = new Set(['application/json', 'text/plain', 'text/markdown', 'text/csv'])

/** Bounded, provider-free formats the V1 file worker may extract. */
export function isIntakeV1FileExtractionSupported(mimeType: string, byteSize: number) {
  if (!Number.isInteger(byteSize) || byteSize < 1) return false
  if (mimeType === 'application/pdf') return byteSize <= INTAKE_V1_FILE_EXTRACTION_PDF_MAX_BYTES
  return textMimeTypes.has(mimeType) && byteSize <= INTAKE_V1_FILE_EXTRACTION_TEXT_MAX_BYTES
}
