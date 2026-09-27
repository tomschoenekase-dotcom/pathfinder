import type { IntakeUploadCategory } from '@pathfinder/contracts/intake-upload'

import { browserUuid } from './browser-uuid'
import { putBlobWithDeadline } from './bounded-upload'
import { identifyIntakeFile, intakeFileFingerprint } from './intake-file-identity'

/**
 * One reserve → store → verify handoff for a client file. Shared by the material uploader,
 * the Home "Send us information" area, Help replies and appearance-asset uploads so every
 * entry point keeps the same idempotency, resume and server-verification rules.
 *
 * A successful storage response never counts as success on its own: only the server's
 * verification result decides whether Torchiko accepted the file.
 */

export type IntakeTransferUpload = {
  id: string
  status: string
}

export type IntakeTransferReserveResult = {
  upload: IntakeTransferUpload
  uploadRequest:
    | { kind: 'single'; url: string; requiredHeaders: Record<string, string> }
    | {
        kind: 'multipart'
        partSize: number
        partCount: number
        completedParts: Array<{ partNumber: number; size: number }>
      }
    | null
}

export type IntakeTransferApi = {
  reserve: (input: {
    venueId: string
    requestId: string
    displayName: string
    fileName: string
    mimeType: string
    byteSize: number
    sha256: string
    category: IntakeUploadCategory
  }) => Promise<IntakeTransferReserveResult>
  verify: (input: { venueId: string; uploadId: string; claimId: string }) => Promise<{
    upload: IntakeTransferUpload
    nextAction: string
  }>
  signMultipartPart: (input: {
    venueId: string
    uploadId: string
    partNumber: number
    checksumSha256: string
  }) => Promise<{ url: string; requiredHeaders: Record<string, string> }>
  completeMultipart: (input: { venueId: string; uploadId: string }) => Promise<unknown>
}

export type IntakeTransferAttempt = { fingerprint: string; requestId: string; claimId: string }

export type IntakeTransferOutcome =
  | { kind: 'awaiting-review'; uploadId: string }
  | { kind: 'security-pending'; uploadId: string }
  | { kind: 'rejected'; uploadId: string; stage: 'reserve' | 'verify' }

export class IntakeTransferError extends Error {}

/** Thrown when the caller's scope changed mid-transfer; the result must be ignored. */
export class IntakeTransferSuperseded extends Error {}

export function inferIntakeCategory(file: File): IntakeUploadCategory {
  if (file.type.startsWith('video/') || file.type.startsWith('audio/')) return 'VIDEO_AUDIO'
  if (file.type.startsWith('image/')) return 'PHOTO'
  if (
    file.type === 'application/pdf' ||
    file.type === 'application/json' ||
    file.type.startsWith('text/')
  )
    return 'DOCUMENT'
  return 'OTHER'
}

export async function transferIntakeFile({
  venueId,
  file,
  category,
  api,
  signal,
  priorAttempt,
  isCurrent = () => true,
  onAttempt,
  onUploading,
  onProgress,
  onVerifying,
}: {
  venueId: string
  file: File
  category: IntakeUploadCategory
  api: IntakeTransferApi
  signal?: AbortSignal
  /** Reuse the same request identity when retrying the same bytes. */
  priorAttempt?: IntakeTransferAttempt | undefined
  isCurrent?: () => boolean
  onAttempt?: (attempt: IntakeTransferAttempt) => void
  onUploading?: (upload: { id: string; multipart: boolean }) => void
  onProgress?: (uploadedBytes: number) => void
  onVerifying?: () => void
}): Promise<IntakeTransferOutcome> {
  const current = () => {
    if (!isCurrent()) throw new IntakeTransferSuperseded('Upload scope changed.')
  }
  const identity = await identifyIntakeFile(file)
  current()
  const fingerprint = intakeFileFingerprint(file, identity)
  const storageKey = `torchiko:intake-upload:v1:${venueId}:${identity.sha256Hex}:${file.size}`
  let persisted: { requestId: string; claimId: string } | null = null
  try {
    const raw = globalThis.localStorage?.getItem(storageKey)
    if (raw) persisted = JSON.parse(raw) as { requestId: string; claimId: string }
  } catch {
    persisted = null
  }
  const attempt: IntakeTransferAttempt =
    priorAttempt?.fingerprint === fingerprint
      ? priorAttempt
      : {
          fingerprint,
          requestId: persisted?.requestId ?? browserUuid(),
          claimId: persisted?.claimId ?? browserUuid(),
        }
  onAttempt?.(attempt)
  try {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify({ requestId: attempt.requestId, claimId: attempt.claimId }),
    )
  } catch {
    // Resume remains available for this page even if browser storage is unavailable.
  }
  const reserved = await api.reserve({
    venueId,
    requestId: attempt.requestId,
    displayName: file.name,
    fileName: file.name,
    mimeType: file.type,
    byteSize: file.size,
    sha256: identity.sha256Hex,
    category,
  })
  current()
  if (reserved.upload.status === 'AWAITING_REVIEW') {
    return { kind: 'awaiting-review', uploadId: reserved.upload.id }
  }
  if (reserved.upload.status === 'REJECTED') {
    return { kind: 'rejected', uploadId: reserved.upload.id, stage: 'reserve' }
  }
  if (reserved.uploadRequest) {
    onUploading?.({
      id: reserved.upload.id,
      multipart: reserved.uploadRequest.kind === 'multipart',
    })
    if (reserved.uploadRequest.kind === 'single') {
      const response = await putBlobWithDeadline({
        url: reserved.uploadRequest.url,
        headers: reserved.uploadRequest.requiredHeaders,
        body: file,
        ...(signal ? { signal } : {}),
        timeoutMs: 2 * 60 * 1000,
      })
      // A lost successful PUT can replay as precondition-failed because the immutable object now
      // exists. Reconcile it through server-side generation/checksum verification; never infer
      // success from the storage response alone.
      if (!response.ok && response.status !== 412) {
        throw new IntakeTransferError('The file could not be sent. Please try again.')
      }
    } else {
      const completed = new Set(
        reserved.uploadRequest.completedParts.map((part) => part.partNumber),
      )
      let uploadedBytes = reserved.uploadRequest.completedParts.reduce(
        (total, part) => total + part.size,
        0,
      )
      onProgress?.(uploadedBytes)
      for (let partNumber = 1; partNumber <= reserved.uploadRequest.partCount; partNumber++) {
        if (completed.has(partNumber)) continue
        const start = (partNumber - 1) * reserved.uploadRequest.partSize
        const part = file.slice(start, Math.min(file.size, start + reserved.uploadRequest.partSize))
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', await part.arrayBuffer()),
        )
        const checksumSha256 = [...digest]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
        const signed = await api.signMultipartPart({
          venueId,
          uploadId: reserved.upload.id,
          partNumber,
          checksumSha256,
        })
        const response = await putBlobWithDeadline({
          url: signed.url,
          headers: signed.requiredHeaders,
          body: part,
          ...(signal ? { signal } : {}),
          timeoutMs: 2 * 60 * 1000,
        })
        if (!response.ok)
          throw new IntakeTransferError(
            `Part ${partNumber} could not be sent. Retry to continue from saved parts.`,
          )
        uploadedBytes += part.size
        onProgress?.(uploadedBytes)
      }
      await api.completeMultipart({ venueId, uploadId: reserved.upload.id })
    }
    current()
  }
  onVerifying?.()
  const verified = await api.verify({
    venueId,
    uploadId: reserved.upload.id,
    claimId: attempt.claimId,
  })
  current()
  if (verified.upload.status === 'AWAITING_REVIEW') {
    return { kind: 'awaiting-review', uploadId: reserved.upload.id }
  }
  if (verified.upload.status === 'PRECHECK_PASSED') {
    return { kind: 'security-pending', uploadId: reserved.upload.id }
  }
  if (verified.upload.status === 'REJECTED' || verified.nextAction === 'RESELECT_FILE') {
    return { kind: 'rejected', uploadId: reserved.upload.id, stage: 'verify' }
  }
  throw new IntakeTransferError('Torchiko could not confirm the latest check. Please try again.')
}
