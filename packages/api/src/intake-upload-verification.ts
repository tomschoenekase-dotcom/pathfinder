import {
  claimIntakeUploadVerificationAction,
  releaseIntakeUploadVerificationAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  type IntakeUploadActionClient,
  type IntakeUploadVerificationActor,
} from '@pathfinder/db'

import { configuredIntakeUploadMalwareScanner } from './lib/intake-upload-byte-verifier'
import { readIntakeUploadVersion } from './lib/intake-upload-storage'

export class IntakeUploadScannerUnavailableError extends Error {
  constructor(message = 'Authoritative intake upload scanner is not configured') {
    super(message)
    this.name = 'IntakeUploadScannerUnavailableError'
  }
}

export function intakeUploadScannerAvailable(): boolean {
  return configuredIntakeUploadMalwareScanner() !== null
}

export async function processIntakeUploadAuthoritativeVerification(input: {
  client?: IntakeUploadActionClient
  tenantId: string
  venueId: string
  uploadId: string
  actor: IntakeUploadVerificationActor
  claimId: string
}) {
  const scanner = configuredIntakeUploadMalwareScanner()
  if (!scanner) throw new IntakeUploadScannerUnavailableError()

  const claimed = await claimIntakeUploadVerificationAction(input)
  if (claimed.state === 'AWAITING_REVIEW') return claimed
  if (!claimed.uploadTarget.storageVersionId) {
    throw new Error('Authoritative verification requires an immutable storage version')
  }

  try {
    const bytes = await readIntakeUploadVersion({
      key: claimed.uploadTarget.objectKey,
      versionId: claimed.uploadTarget.storageVersionId,
    })
    const malware = await scanner.scan({
      bytes,
      expectedBytes: claimed.uploadTarget.byteSize,
      expectedSha256: claimed.uploadTarget.sha256,
    })
    return await settleIntakeUploadAuthoritativeVerificationAction({
      ...input,
      malware: {
        ...malware,
        engine: scanner.engine,
        engineVersion: scanner.engineVersion,
      },
    })
  } catch (cause) {
    try {
      await releaseIntakeUploadVerificationAction({
        ...input,
        reasonCode: 'VERIFICATION_UNAVAILABLE',
      })
    } catch {
      // Preserve the scanner/storage failure. The existing claim remains lease-bounded.
    }
    throw cause
  }
}
