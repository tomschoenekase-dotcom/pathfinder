export const MAX_MEDIA_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024
export const mediaIngestionModes = ['ECONOMY', 'BALANCED', 'FORENSIC'] as const

export function safeMediaFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-180)
}

export function isNoSuchMediaUpload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown }
  return (
    candidate.name === 'NoSuchUpload' ||
    candidate.Code === 'NoSuchUpload' ||
    candidate.code === 'NoSuchUpload'
  )
}

export const mediaIngestionProjectSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  name: true,
  context: true,
  mode: true,
  status: true,
  stage: true,
  progress: true,
  sourceFileName: true,
  sourceBytes: true,
  uploadAttemptId: true,
  settings: true,
  coverage: true,
  questions: true,
  findings: true,
  draftJson: true,
  estimatedCostCents: true,
  actualCostCents: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
} as const

export function serializeMediaIngestionProject<T extends { sourceBytes: bigint | null }>(row: T) {
  return { ...row, sourceBytes: row.sourceBytes === null ? null : Number(row.sourceBytes) }
}
