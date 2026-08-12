export const MAX_MEDIA_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024

export function isMediaIngestionActionError(
  error: unknown,
): error is Error & { code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATUS' | 'INVALID_INPUT' } {
  return (
    error instanceof Error &&
    error.name === 'MediaIngestionActionError' &&
    'code' in error &&
    ['NOT_FOUND', 'CONFLICT', 'INVALID_STATUS', 'INVALID_INPUT'].includes(
      String((error as { code?: unknown }).code),
    )
  )
}
export const mediaIngestionModes = ['ECONOMY', 'BALANCED', 'FORENSIC'] as const
export const MEDIA_SOURCE_FINGERPRINT_ALGORITHM = 'pathfinder-sha256-part-manifest-v1' as const

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
  sourceLastModified: true,
  sourceFingerprintAlgorithm: true,
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

export function serializeMediaIngestionProject<
  T extends { sourceBytes: bigint | null; sourceLastModified: bigint | null },
>(
  row: T,
): Omit<T, 'sourceBytes' | 'sourceLastModified'> & {
  sourceBytes: number | null
  sourceLastModified: number | null
} {
  const { sourceBytes, sourceLastModified, ...project } = row
  return {
    ...project,
    sourceBytes: sourceBytes === null ? null : Number(sourceBytes),
    sourceLastModified: sourceLastModified === null ? null : Number(sourceLastModified),
  }
}
