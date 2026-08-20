import { randomUUID } from 'node:crypto'

import { commitProspectImportBatchAction, db, publishCrmOperationalSignal } from '@pathfinder/db'
import type { ProspectImportCommitJobPayload } from '@pathfinder/jobs'

import { inspectProspectImportSource, stageProspectImportSource } from './prospect-import-source'

async function recordSourceFailure(
  importId: string,
  phase: 'inspection' | 'staging',
  error: unknown,
) {
  const detail = error instanceof Error ? error.message : 'Unknown workbook processing failure'
  await db.prospectImport.updateMany({
    where: { id: importId, status: 'DRAFT' },
    data: { reconciliation: { phase, error: detail.slice(0, 2_000), failedAt: new Date() } },
  })
  await publishCrmOperationalSignal({
    input: {
      signal: 'import_completed_with_issues',
      scope: { kind: 'platform' },
      linkedObjectType: 'ProspectImport',
      linkedObjectId: importId,
      summary: `Prospect workbook ${phase} failed: ${detail}`,
    },
  })
}

async function withSourceJobClaim<T>(
  importId: string,
  phase: 'inspection' | 'staging',
  operation: (renew: () => Promise<void>) => Promise<T>,
) {
  const token = randomUUID()
  const owner = `prospect-import-source:${process.pid}`
  const now = new Date()
  const claimed = await db.prospectImport.updateMany({
    where: {
      id: importId,
      status: 'DRAFT',
      OR: [{ jobClaimToken: null }, { jobClaimExpiresAt: { lt: now } }],
    },
    data: {
      jobClaimToken: token,
      jobClaimPhase: phase,
      jobClaimOwner: owner,
      jobClaimExpiresAt: new Date(now.getTime() + 15 * 60_000),
    },
  })
  if (claimed.count !== 1) throw new Error(`Prospect import ${phase} job is already claimed`)
  const renew = async () => {
    const renewed = await db.prospectImport.updateMany({
      where: { id: importId, jobClaimToken: token, status: 'DRAFT' },
      data: { jobClaimExpiresAt: new Date(Date.now() + 15 * 60_000) },
    })
    if (renewed.count !== 1) throw new Error(`Prospect import ${phase} lease was lost`)
  }
  try {
    return await operation(renew)
  } finally {
    await db.prospectImport.updateMany({
      where: { id: importId, jobClaimToken: token },
      data: {
        jobClaimToken: null,
        jobClaimPhase: null,
        jobClaimOwner: null,
        jobClaimExpiresAt: null,
      },
    })
  }
}

export async function processProspectImportInspectionJob(importId: string) {
  try {
    return await withSourceJobClaim(importId, 'inspection', () =>
      inspectProspectImportSource(importId),
    )
  } catch (error) {
    await recordSourceFailure(importId, 'inspection', error)
    throw error
  }
}

export async function processProspectImportStagingJob(importId: string) {
  try {
    return await withSourceJobClaim(importId, 'staging', (renew) =>
      stageProspectImportSource(importId, renew),
    )
  } catch (error) {
    await recordSourceFailure(importId, 'staging', error)
    throw error
  }
}

const MAX_BATCHES_PER_JOB = 1_000

/**
 * Resumable import commit driver. Durable progress is the terminal state of each
 * ProspectImportRow, not BullMQ progress; a retry always reloads Postgres and
 * continues from remaining VALID/WARNING rows.
 */
export async function processProspectImportCommitJob(
  payload: ProspectImportCommitJobPayload,
): Promise<{ batches: number; processed: number; failed: number; status: string }> {
  return (async () => {
    const prospectImport = await db.prospectImport.findUnique({
      where: { id: payload.importId },
      select: { id: true, status: true, approvedBy: true },
    })
    if (!prospectImport) throw new Error('Prospect import does not exist')
    if (!prospectImport.approvedBy)
      throw new Error('Prospect import has no human approval identity')

    let batches = 0
    let processed = 0
    let failed = 0
    let status = prospectImport.status
    while (batches < MAX_BATCHES_PER_JOB) {
      const result = await commitProspectImportBatchAction({
        importId: payload.importId,
        limit: 100,
        workerId: `prospect-import-worker:${process.pid}`,
        actor: { type: 'HUMAN', id: prospectImport.approvedBy, role: 'PLATFORM_ADMIN' },
      })
      batches += 1
      processed += result.processed
      failed += result.failed
      status = result.prospectImport.status
      if (result.done) {
        if (failed > 0) {
          await publishCrmOperationalSignal({
            input: {
              signal: 'import_completed_with_issues',
              scope: { kind: 'platform' },
              linkedObjectType: 'ProspectImport',
              linkedObjectId: payload.importId,
              summary: `Import commit finished with ${failed} failed rows requiring review.`,
            },
          })
        }
        return { batches, processed, failed, status }
      }
      if (result.processed === 0 && result.failed === 0) {
        throw new Error('Prospect import made no progress and requires reconciliation')
      }
    }
    throw new Error('Prospect import exceeded the bounded worker batch limit')
  })()
}
