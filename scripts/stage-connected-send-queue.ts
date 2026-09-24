/** One new synthetic FAKE outbox through the same native actions as the app.
 * This stops before worker dispatch and cannot address a real venue/account. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const qa = path.resolve(process.env.TORCHIKO_CONNECTED_QA_DIR ?? '')
const revision = process.argv[2]
assert.match(revision ?? '', /^r\d{3}$/u)
assert.notEqual(revision, 'r003', 'r003 is reserved for foreground/UI proof')
const output = path.resolve(process.argv[3] ?? '')
assert.ok(process.env.TORCHIKO_CONNECTED_QA_DIR && output.startsWith(qa + path.sep))
const venueId = `SYN-CRM-FIRSTSEND-VENUE-${revision}`
const accountId = `SYN-CRM-FIRSTSEND-ACCOUNT-${revision}`
const actor = {
  type: 'SYSTEM' as const,
  role: 'PLATFORM_ADMIN' as const,
  id: `synthetic:crm-meaning:connected-readiness-${revision}-queue-proof`,
}
const receipt: Record<string, unknown> = {
  schema: 'torchiko.queue-staging-proof/1',
  venueId,
  accountId,
  synthetic: true,
  provider: 'FAKE',
  SEND_AUTHORIZED: false,
}

async function main() {
  process.env.NODE_ENV = 'development'
  const { assertLocalSalesEnvironment, getNativeSalesWorkflow, applyNativeSalesAction } =
    await import('../packages/api/src/prospect-sales-workflow')
  const { db } = await import('../packages/db/src/index')
  assertLocalSalesEnvironment()
  const account = await db.correspondenceProviderAccount.findUnique({ where: { id: accountId } })
  assert.ok(
    account?.provider === 'FAKE' &&
      account.mailboxAddress.endsWith('@example.invalid') &&
      !account.deliveryEnabled &&
      !account.credentialReferenceId,
  )
  let step = 'read'
  try {
    let view = await getNativeSalesWorkflow(venueId)
    assert.equal(view.suppression.blocked, false)
    assert.equal(view.draft, null)
    step = 'prepare'
    view = (await applyNativeSalesAction(
      {
        action: 'prepare',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.writerTask && view.preparation && !view.preparation.stale)
    const task = view.writerTask
    const subject = 'SYNTHETIC storage and queue check'
    const body =
      'Hello,\n\nThis synthetic note tests the isolated FAKE-provider queue. It is not a message to any real venue.\n\nThanks,\nTom'
    const identity = 'GPT-5.6 Sol — synthetic queue proof'
    const annotations = []
    const assessments = []
    for (const [section, value] of [
      ['subject', subject],
      ['body', body],
    ] as const) {
      let start = 0
      for (const quote of value.split('\n\n')) {
        const end = start + Array.from(quote).length
        const nonfactual = quote === 'Hello,' || quote === 'Thanks,\nTom'
        const annotation_id = `${section}-${start}-${end}`
        const reason = nonfactual
          ? 'Ordinary greeting or closing, without approval or send authority.'
          : 'Isolated synthetic queue diagnostic, not a real venue claim.'
        annotations.push({
          annotation_id,
          section,
          start,
          end,
          quote,
          category: nonfactual ? ('NONFACTUAL' as const) : ('TASK CONSTRAINT' as const),
          claim_ids: nonfactual ? [] : ['T-DIAGNOSTIC'],
          reason,
          answers: [],
        })
        assessments.push({
          annotation_id,
          verdict: nonfactual ? ('nonfactual' as const) : ('supported' as const),
          reason,
        })
        start = end + 2
      }
    }
    const result = {
      schema: 'torchiko.native-writer-result/1' as const,
      taskId: task.taskId,
      binding: task.binding,
      generatedBy: { kind: 'model' as const, identity },
      subject,
      body,
      annotations,
      languageUses: [],
      assessment: {
        reviewer: { kind: 'model' as const, identity },
        assessments,
        answers: [],
        unsupportedClaims: [],
      },
    }
    step = 'import'
    view = (await applyNativeSalesAction(
      {
        action: 'importWriterResult',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          result,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.draft && view.claimReview?.current && view.draft.body === body)
    receipt.draftId = view.draft.id
    receipt.meaningReviewId = view.claimReview.current.id
    step = 'read-acknowledge'
    view = (await applyNativeSalesAction(
      {
        action: 'review',
        input: {
          venueId,
          draftId: view.draft.id,
          contentHash: view.draft.contentHash,
          expectedSnapshotHash: view.snapshotHash,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.draft)
    step = 'operational-handoff'
    view = (await applyNativeSalesAction(
      {
        action: 'handoffOperational',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          draftId: view.draft.id,
          contentHash: view.draft.contentHash,
          meaningReviewId: receipt.meaningReviewId as string,
          providerAccountId: accountId,
          campaignName: 'SYNTHETIC connected queue acceptance r002',
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.operational?.candidate)
    let candidate = view.operational.candidate
    receipt.candidateId = candidate.id
    step = 'operational-review'
    view = (await applyNativeSalesAction(
      {
        action: 'reviewOperational',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          draftId: candidate.id,
          expectedContentHash: candidate.contentHash,
          acknowledgedEscalations: candidate.escalationFlags,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.operational?.candidate)
    candidate = view.operational.candidate
    step = 'stage-batch'
    view = (await applyNativeSalesAction(
      {
        action: 'stageOperational',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          draftId: candidate.id,
          campaignId: candidate.campaignId,
          expectedContentHash: candidate.contentHash,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.operational?.candidate?.batch)
    candidate = view.operational.candidate
    let batch = candidate.batch!
    receipt.batchId = batch.id
    step = 'approve-batch'
    view = (await applyNativeSalesAction(
      {
        action: 'approveOperationalBatch',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          batchId: batch.id,
          expectedRecipientCount: 1,
          expectedBatchHash: batch.hash,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.operational?.candidate?.batch)
    batch = view.operational.candidate.batch
    step = 'release-FAKE-only'
    view = (await applyNativeSalesAction(
      {
        action: 'releaseSyntheticBatch',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          batchId: batch.id,
          expectedRecipientCount: 1,
          expectedBatchHash: batch.hash,
          providerAccountId: accountId,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.operational?.candidate?.batch?.outboxId)
    receipt.outboxId = view.operational.candidate.batch.outboxId
    receipt.outboxStatus = view.operational.candidate.batch.deliveryState
    assert.equal(receipt.outboxStatus, 'PENDING')
    receipt.passed = true
  } catch (error) {
    receipt.passed = false
    receipt.failedStep = step
    receipt.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' })
    await db.$disconnect()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
