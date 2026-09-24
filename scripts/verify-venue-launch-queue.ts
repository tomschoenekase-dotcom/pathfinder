/** Isolated registered BullMQ send-email proof for one frozen venue QR attachment.
 * Requires a fresh r201+ synthetic PENDING outbox; never sends live mail. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'

const args = process.argv.slice(2)
const value = (name: string) => args[args.indexOf(name) + 1]
assert.deepEqual(args.filter((arg) => arg.startsWith('--')).sort(), [
  '--mode',
  '--outbox-id',
  '--output',
])
const mode = value('--mode')
assert.ok(mode && ['success', 'acceptance-fault'].includes(mode))
const outboxId = value('--outbox-id')
const outputArg = value('--output')
assert.ok(outputArg)
const output = path.resolve(outputArg)
const qaRoot = path.resolve(process.env.TORCHIKO_CONNECTED_QA_DIR ?? '')
assert.ok(outboxId && outboxId.length <= 191 && !/[\r\n\0]/u.test(outboxId))
assert.ok(process.env.TORCHIKO_CONNECTED_QA_DIR && output.startsWith(qaRoot + path.sep))

async function main() {
  Object.assign(process.env, { NODE_ENV: 'development' })
  // This process may reach only the disposable Postgres and its own ephemeral
  // Redis. The guard is installed before package imports or DB connections.
  const originalConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...connectionArgs: unknown[]) {
    const raw = connectionArgs[0]
    const first = Array.isArray(raw) ? raw[0] : raw
    const host =
      typeof first === 'object' && first !== null
        ? (first as { host?: string }).host
        : typeof connectionArgs[1] === 'string'
          ? connectionArgs[1]
          : undefined
    const port =
      typeof first === 'object' && first !== null
        ? (first as { port?: number }).port
        : typeof first === 'number'
          ? first
          : undefined
    assert.ok(
      host === '127.0.0.1' && (port === 58617 || port === 58619),
      'EXTERNAL_SOCKET_DISABLED_FOR_CONNECTED_QUEUE_PROOF',
    )
    return originalConnect.apply(this, connectionArgs as never)
  } as typeof net.Socket.prototype.connect
  const requireLocal = createRequire(import.meta.url)
  const noHttp = () => {
    throw new Error('EXTERNAL_HTTP_DISABLED_FOR_CONNECTED_QUEUE_PROOF')
  }
  globalThis.fetch = noHttp as never
  for (const protocol of ['node:http', 'node:https']) {
    const module = requireLocal(protocol)
    module.request = noHttp
    module.get = noHttp
  }
  requireLocal('node:tls').connect = noHttp
  const { assertLocalSalesEnvironment } =
    await import('../packages/api/src/prospect-sales-workflow')
  const {
    db,
    withTenantIsolationBypass,
    localFirstSendRehearsalEnabled,
    requireCurrentProspectLaunchAttachments,
    operationalOrigin,
  } = await import('../packages/db/src/index')
  const { launchAttachmentsFromSnapshot } =
    await import('../packages/contracts/src/venue-launch-asset-node')
  assertLocalSalesEnvironment()
  assert.ok(localFirstSendRehearsalEnabled(), 'Only the isolated local rehearsal can run')
  const redisUrl = new URL(process.env.REDIS_URL ?? '')
  assert.ok(
    redisUrl.hostname === '127.0.0.1' && redisUrl.port === '58619',
    'Only the loopback Redis queue can run this rehearsal',
  )
  const before = await withTenantIsolationBypass(async () => {
    const outbox = await db.prospectSendOutbox.findUnique({ where: { id: outboxId } })
    if (!outbox) return null
    const [providerAccount, sendItem] = await Promise.all([
      db.correspondenceProviderAccount.findUnique({ where: { id: outbox.providerAccountId } }),
      db.prospectSendItem.findUnique({
        where: { id: outbox.sendItemId },
        include: { draft: true },
      }),
    ])
    return { outbox, providerAccount, sendItem }
  })
  assert.ok(
    before?.outbox.status === 'PENDING' &&
      before.sendItem &&
      before.providerAccount &&
      /^SYN-CRM-FIRSTSEND-VENUE-r2\d{2}$/u.test(before.sendItem.draft.venueId ?? '') &&
      operationalOrigin(before.sendItem.draft.groundingSnapshot)?.synthetic === true &&
      before.providerAccount.provider === 'FAKE' &&
      !before.providerAccount.deliveryEnabled &&
      !before.providerAccount.credentialReferenceId &&
      before.providerAccount.mailboxAddress.endsWith('@example.invalid'),
    'An exact pending synthetic native-origin FAKE outbox is required',
  )
  const selected = launchAttachmentsFromSnapshot(before.sendItem.headerSnapshot)
  assert.equal(selected.length, 1, 'Exactly one frozen venue QR required')
  const asset = selected[0]!
  const revision = /^SYN-CRM-FIRSTSEND-VENUE-(r2\d{2})$/u.exec(
    before.sendItem.draft.venueId ?? '',
  )?.[1]
  assert.ok(revision, 'Fresh synthetic r2xx prospect required')
  assert.equal(asset.venueId, `SYN-CRM-FIRSTSEND-PRODUCT-VENUE-${revision}`)
  assert.equal(asset.tenantId, `SYN-CRM-FIRSTSEND-TENANT-${revision}`)
  assert.equal(
    asset.publicUrl,
    `https://guide.example.invalid/synthetic-qr-museum-${revision}/chat?source=qr`,
  )
  assert.deepEqual(
    launchAttachmentsFromSnapshot(before.sendItem.draft.groundingSnapshot),
    selected,
    'Operational draft and send item must retain the same exact QR bytes',
  )
  const assetHash = createHash('sha256')
    .update(Buffer.from(asset.contentBase64, 'base64'))
    .digest('hex')
  assert.equal(assetHash, asset.sha256)
  const beforeCount = await withTenantIsolationBypass(() =>
    db.prospectEmailMessage.count({
      where: { sendItemId: before.outbox.sendItemId },
    }),
  )
  assert.equal(beforeCount, 0, 'This proof must observe a new provider acceptance')

  const workerRequire = createRequire(path.resolve('apps/workers/package.json'))
  const { Queue, Worker, QueueEvents } = workerRequire('bullmq') as typeof import('bullmq')
  const { getBullMQConnection, closeBullMQConnection, SEND_PROSPECT_OUTREACH_JOB } =
    await import('../packages/jobs/src/index')
  const { handleSendEmailQueueJob } =
    await import('../apps/workers/src/processors/send-email-queue')
  const { queueSafeJobProcessor } = await import('../apps/workers/src/lib/job-execution')
  const { createFakeCorrespondenceProvider } =
    await import('../packages/api/src/correspondence/fake')
  const providerHook = await import('../apps/workers/src/processors/send-prospect-outreach')
  const fake = createFakeCorrespondenceProvider({ now: () => new Date() })
  const connection = getBullMQConnection()
  const queueName = `torchiko-connected-qa-${randomUUID()}`
  const queue = new Queue(queueName, { connection })
  const events = new QueueEvents(queueName, { connection })
  const worker = new Worker(
    queueName,
    queueSafeJobProcessor((job: Parameters<typeof handleSendEmailQueueJob>[0]) =>
      handleSendEmailQueueJob(job),
    ),
    { connection, concurrency: 1 },
  )
  providerHook._setProspectCorrespondenceProviderForTesting(fake)
  const receipt: Record<string, unknown> = {
    schema: 'torchiko.venue-launch-send-email-queue-proof/1',
    mode,
    outboxId,
    queueName,
    synthetic: true,
    provider: 'FAKE',
    attachment: {
      filename: asset.filename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      release: asset.release,
    },
    externalHttpDisabled: true,
    externalSocketsRestrictedToLoopbackDbAndRedis: true,
    liveSend: false,
    passed: false,
  }
  try {
    await events.waitUntilReady()
    await worker.waitUntilReady()
    if (mode === 'acceptance-fault') {
      providerHook._setProspectAfterAcceptanceFaultForTesting(() => {
        providerHook._setProspectAfterAcceptanceFaultForTesting(undefined)
        throw new Error('SYNTHETIC_POST_ACCEPTANCE_PERSISTENCE_FAULT')
      })
    }
    const first = await queue.add(
      SEND_PROSPECT_OUTREACH_JOB,
      { outboxId },
      {
        jobId: `first-${randomUUID()}`,
        attempts: 1,
      },
    )
    let recoveryJobId: string | undefined
    if (mode === 'acceptance-fault') {
      await assert.rejects(() => first.waitUntilFinished(events, 30_000))
      const uncertain = await withTenantIsolationBypass(() =>
        db.prospectSendOutbox.findUnique({ where: { id: outboxId } }),
      )
      assert.equal(uncertain?.status, 'AMBIGUOUS')
      assert.equal(fake.state.sent.length, 1)
      await withTenantIsolationBypass(() =>
        db.venue.update({
          where: { id: asset.venueId, tenantId: asset.tenantId },
          data: {
            description: `SYNTHETIC QR source changed after provider acceptance ${queueName}`,
          },
        }),
      )
      await assert.rejects(
        () =>
          withTenantIsolationBypass(() =>
            requireCurrentProspectLaunchAttachments(`SYN-CRM-FIRSTSEND-VENUE-${revision}`, [asset]),
          ),
        /LAUNCH_ASSET_STALE/u,
      )
      const recovery = await queue.add(
        SEND_PROSPECT_OUTREACH_JOB,
        { outboxId },
        {
          jobId: `lookup-after-qr-source-change-${randomUUID()}`,
          attempts: 1,
        },
      )
      recoveryJobId = recovery.id
      await recovery.waitUntilFinished(events, 30_000)
    } else {
      await first.waitUntilFinished(events, 30_000)
    }
    const after = await withTenantIsolationBypass(async () => {
      const outbox = await db.prospectSendOutbox.findUnique({ where: { id: outboxId } })
      if (!outbox) return null
      const sendItem = await db.prospectSendItem.findUnique({
        where: { id: outbox.sendItemId },
        include: { message: true },
      })
      return { outbox, sendItem }
    })
    assert.equal(fake.state.sent.length, 1)
    assert.deepEqual(
      fake.state.sent[0]?.attachments,
      selected,
      'Registered FAKE provider must receive the exact frozen QR bytes',
    )
    assert.ok(after?.outbox.status === 'SENT' && after.sendItem?.message?.providerMessageId)
    if (mode === 'acceptance-fault') assert.equal(after.outbox.attemptCount, 2)
    const second = await queue.add(
      SEND_PROSPECT_OUTREACH_JOB,
      { outboxId },
      {
        jobId: `replay-${randomUUID()}`,
        attempts: 1,
      },
    )
    await second.waitUntilFinished(events, 30_000)
    assert.equal(fake.state.sent.length, 1, 'Queue replay must not send twice')
    assert.equal(
      await withTenantIsolationBypass(() =>
        db.prospectEmailMessage.count({
          where: { sendItemId: before.outbox.sendItemId },
        }),
      ),
      1,
      'Queue replay must not append a duplicate canonical message',
    )
    Object.assign(receipt, {
      passed: true,
      firstJobId: first.id,
      recoveryJobId: recoveryJobId ?? null,
      replayJobId: second.id,
      providerMessageId: after.sendItem.message?.providerMessageId ?? null,
      canonicalMessageId: after.sendItem.message?.id ?? null,
      retainedOutboxStatus: after.outbox.status,
      providerAcceptances: fake.state.sent.length,
      recoveredAfterAcceptanceFault: mode === 'acceptance-fault',
      sourceMovedAfterAcceptance: mode === 'acceptance-fault',
      recoveredByLookupOnly: mode === 'acceptance-fault',
    })
  } finally {
    providerHook._setProspectAfterAcceptanceFaultForTesting(undefined)
    providerHook._setProspectCorrespondenceProviderForTesting(undefined)
    await worker.close()
    await events.close()
    await queue.close()
    await closeBullMQConnection()
    await db.$disconnect()
    await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' })
  }
  assert.equal(receipt.passed, true)
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
