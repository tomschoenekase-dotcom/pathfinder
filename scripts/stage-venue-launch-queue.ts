/** A single synthetic converted venue QR through native preparation and FAKE queue staging.
 * Requires the matching r201+ first-send seed; this process stops before dispatch. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const qa = path.resolve(process.env.TORCHIKO_CONNECTED_QA_DIR ?? '')
const revision = process.argv[2]
assert.match(revision ?? '', /^r2\d{2}$/u)
const output = path.resolve(process.argv[3] ?? '')
assert.ok(process.env.TORCHIKO_CONNECTED_QA_DIR && output.startsWith(qa + path.sep))
const venueId = `SYN-CRM-FIRSTSEND-VENUE-${revision}`
const accountId = `SYN-CRM-FIRSTSEND-ACCOUNT-${revision}`
const tenantId = `SYN-CRM-FIRSTSEND-TENANT-${revision}`
const productVenueId = `SYN-CRM-FIRSTSEND-PRODUCT-VENUE-${revision}`
const placeId = `SYN-CRM-FIRSTSEND-PRODUCT-PLACE-${revision}`
const relationshipId = `SYN-CRM-FIRSTSEND-RELATIONSHIP-${revision}`
const conversionId = `SYN-CRM-FIRSTSEND-CONVERSION-${revision}`
const publicOrigin = 'https://guide.example.invalid'
const actor = {
  type: 'SYSTEM' as const,
  role: 'PLATFORM_ADMIN' as const,
  id: `synthetic:crm-meaning:connected-readiness-${revision}-queue-proof`,
}
const receipt: Record<string, unknown> = {
  schema: 'torchiko.venue-launch-queue-staging-proof/1',
  venueId,
  accountId,
  tenantId,
  productVenueId,
  synthetic: true,
  provider: 'FAKE',
  SEND_AUTHORIZED: false,
}

async function main() {
  Object.assign(process.env, { NODE_ENV: 'development' })
  const requireLocal = createRequire(import.meta.url)
  const noHttp = () => {
    throw new Error('EXTERNAL_HTTP_DISABLED_FOR_VENUE_LAUNCH_QUEUE_PROOF')
  }
  globalThis.fetch = noHttp as never
  for (const protocol of ['node:http', 'node:https']) {
    const module = requireLocal(protocol)
    module.request = noHttp
    module.get = noHttp
  }
  const { assertLocalSalesEnvironment, getNativeSalesWorkflow, applyNativeSalesAction } =
    await import('../packages/api/src/prospect-sales-workflow')
  const { readProspectLaunchAssets } = await import('../packages/api/src/prospect-launch-assets')
  const { nativeWriterResult } = await import('../packages/api/src/prospect-writer-contract')
  const { db, withTenantIsolationBypass } = await import('../packages/db/src/index')
  assertLocalSalesEnvironment()
  assert.ok(
    !process.env.NEXT_PUBLIC_WEB_URL || process.env.NEXT_PUBLIC_WEB_URL === publicOrigin,
    'Only the synthetic public QR origin is allowed',
  )
  process.env.NEXT_PUBLIC_WEB_URL = publicOrigin
  const account = await db.correspondenceProviderAccount.findUnique({ where: { id: accountId } })
  assert.ok(
    account?.provider === 'FAKE' &&
      account.mailboxAddress.endsWith('@example.invalid') &&
      !account.deliveryEnabled &&
      !account.credentialReferenceId,
  )
  let step = 'read'
  try {
    step = 'seed-converted-public-venue'
    await withTenantIsolationBypass(() =>
      db.$transaction(async (tx) => {
        const prospect = await tx.prospectVenue.findUnique({ where: { id: venueId } })
        assert.ok(prospect?.organizationId === `SYN-CRM-FIRSTSEND-ORG-${revision}`)
        for (const present of [
          await tx.tenant.findUnique({ where: { id: tenantId } }),
          await tx.venue.findUnique({ where: { id: productVenueId } }),
          await tx.prospectCustomerRelationship.findUnique({ where: { id: relationshipId } }),
          await tx.prospectLocationConversion.findUnique({ where: { id: conversionId } }),
        ])
          assert.equal(
            present,
            null,
            'New revision required; synthetic product fixture already exists',
          )
        await tx.tenant.create({
          data: {
            id: tenantId,
            name: `SYNTHETIC QR Tenant ${revision}`,
            slug: `synthetic-venue-launch-${revision}`,
          },
        })
        await tx.venue.create({
          data: {
            id: productVenueId,
            tenantId,
            name: `SYNTHETIC QR Museum ${revision}`,
            slug: `synthetic-qr-museum-${revision}`,
            description: 'Synthetic public visitor guide, no real venue.',
            isActive: true,
          },
        })
        await tx.place.create({
          data: {
            id: placeId,
            tenantId,
            venueId: productVenueId,
            name: 'Synthetic Gallery',
            type: 'EXHIBIT',
            tags: ['synthetic'],
            shortDescription: 'A synthetic public exhibit.',
            isActive: true,
            visibility: 'PUBLIC',
          },
        })
        await tx.prospectCustomerRelationship.create({
          data: {
            id: relationshipId,
            organizationId: prospect.organizationId,
            tenantId,
            idempotencyKey: `synthetic-venue-launch-relationship-${revision}`,
            createdBy: actor.id,
            evidence: { synthetic: true },
          },
        })
        await tx.prospectLocationConversion.create({
          data: {
            id: conversionId,
            tenantId,
            relationshipId,
            prospectVenueId: venueId,
            venueId: productVenueId,
            idempotencyKey: `synthetic-venue-launch-conversion-${revision}`,
            convertedBy: actor.id,
            evidence: { synthetic: true },
          },
        })
      }),
    )
    const available = await withTenantIsolationBypass(() => readProspectLaunchAssets(venueId))
    assert.equal(available.length, 1)
    const asset = available[0]!
    assert.equal(asset.venueId, productVenueId)
    assert.equal(asset.publicUrl, `${publicOrigin}/synthetic-qr-museum-${revision}/chat?source=qr`)
    receipt.attachment = {
      filename: asset.filename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      publicUrl: asset.publicUrl,
      release: asset.release,
      contentSha256: createHash('sha256')
        .update(Buffer.from(asset.contentBase64, 'base64'))
        .digest('hex'),
    }
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
          launchAssetSelection: {
            tenantId: asset.tenantId,
            venueId: asset.venueId,
            release: asset.release,
            publicUrl: asset.publicUrl,
            sha256: asset.sha256,
          },
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.writerTask && view.preparation && !view.preparation.stale)
    assert.deepEqual(
      view.writerTask.launchAttachments?.map((item) => item.sha256),
      [asset.sha256],
    )
    assert.ok(
      !JSON.stringify(view.writerTask).includes(asset.contentBase64),
      'Writer task must carry descriptor only',
    )
    const task = view.writerTask
    const subject = 'SYNTHETIC storage and queue check'
    const body =
      'This synthetic note tests one venue QR in the isolated FAKE-provider queue and addresses no real venue.'
    const identity = 'Synthetic QR queue fixture'
    const annotations = []
    const assessments = []
    for (const [section, value] of [
      ['subject', subject],
      ['body', body],
    ] as const) {
      let start = 0
      for (const quote of value.split('\n\n')) {
        const end = start + Array.from(quote).length
        const annotation_id = `${section}-${start}-${end}`
        const reason =
          'Isolated synthetic queue diagnostic, not a real venue claim or send approval.'
        annotations.push({
          annotation_id,
          section,
          start,
          end,
          quote,
          category: 'TASK CONSTRAINT' as const,
          claim_ids: ['T-DIAGNOSTIC'],
          reason,
          answers: [],
        })
        assessments.push({ annotation_id, verdict: 'supported' as const, reason })
        start = end + 2
      }
    }
    const result = nativeWriterResult.parse({
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
    })
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
          campaignName: `SYNTHETIC venue launch queue ${revision}`,
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
    const outbox = await withTenantIsolationBypass(() =>
      db.prospectSendOutbox.findUnique({
        where: { id: receipt.outboxId as string },
        include: { sendItem: { include: { draft: true } } },
      }),
    )
    assert.ok(outbox)
    const snapshot = outbox.sendItem.draft.groundingSnapshot as { launchAttachments?: unknown[] }
    assert.deepEqual(
      snapshot.launchAttachments,
      [asset],
      'Frozen queue draft must retain exact generated QR bytes',
    )
    const headerSnapshot = outbox.sendItem.headerSnapshot as { launchAttachments?: unknown[] }
    assert.deepEqual(
      headerSnapshot.launchAttachments,
      [asset],
      'Frozen send item must retain exact generated QR bytes',
    )
    receipt.frozenAttachmentSha256 = asset.sha256
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
