import { createHash } from 'node:crypto'
import { z } from 'zod'

import { processIntakeUploadAuthoritativeVerification } from '@pathfinder/api/intake-upload-verification'
import { db } from '@pathfinder/db'
import {
  enqueueIntakeUploadVerification,
  type IntakeUploadVerificationJobPayload,
} from '@pathfinder/jobs'

const payloadSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    uploadId: z.string().trim().min(1).max(191),
    observedUpdatedAt: z.string().datetime(),
  })
  .strict()

function deterministicClaimId(systemJobId: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['pathfinder-intake-upload-claim-v1', systemJobId]))
    .digest('hex')
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export async function processIntakeUploadVerificationJob(
  rawPayload: IntakeUploadVerificationJobPayload,
  jobId: string,
) {
  const payload = payloadSchema.parse(rawPayload)
  const systemJobId = `intake-upload-verification:${jobId}`
  return processIntakeUploadAuthoritativeVerification({
    ...payload,
    actor: {
      type: 'SYSTEM',
      actorId: systemJobId,
      role: 'SYSTEM',
      systemJobId,
      capability: 'intake-upload.authoritative-verify',
      idempotencyKey: jobId,
    },
    claimId: deterministicClaimId(systemJobId),
  })
}

export async function reconcileIntakeUploadVerificationJobs(now = new Date()) {
  const uploads = await db.intakeUpload.findMany({
    where: {
      storageVersionId: { not: null },
      OR: [
        { status: 'PRECHECK_PASSED' },
        { status: 'VERIFYING', verificationLeaseUntil: { lte: now } },
      ],
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: 100,
    select: { tenantId: true, venueId: true, id: true, updatedAt: true },
  })
  for (const upload of uploads) {
    await enqueueIntakeUploadVerification({
      tenantId: upload.tenantId,
      venueId: upload.venueId,
      uploadId: upload.id,
      observedUpdatedAt: upload.updatedAt.toISOString(),
    })
  }
  return { discovered: uploads.length }
}
