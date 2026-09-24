/** Isolated BullMQ proof of the SAME registered send-email handler as workers/index.
 * Requires one already staged synthetic FAKE outbox; never stages/approves or sends live mail. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
assert.ok(
  [
    'success',
    'concurrent',
    'stale',
    'acceptance-fault',
    'acceptance-fault-state-change',
    'lookup-absent',
  ].includes(mode),
)
const outboxId = value('--outbox-id')
const outputArg = value('--output')
assert.ok(outputArg)
const output = path.resolve(outputArg)
const qaRoot = path.resolve(process.env.TORCHIKO_CONNECTED_QA_DIR ?? '')
assert.ok(outboxId && outboxId.length <= 191 && !/[\r\n\0]/u.test(outboxId))
assert.ok(process.env.TORCHIKO_CONNECTED_QA_DIR && output.startsWith(qaRoot + path.sep))

async function main() {
  process.env.NODE_ENV = 'development'
  // This process may reach only the disposable Postgres and its own ephemeral
  // Redis. The guard is installed before package imports or DB connections.
  const originalConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...connectionArgs: unknown[]) {
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
  const { db, withTenantIsolationBypass, localFirstSendRehearsalEnabled, operationalOrigin } =
    await import('../packages/db/src/index')
  assertLocalSalesEnvironment()
  assert.ok(localFirstSendRehearsalEnabled(), 'Only the isolated local rehearsal can run')
  const redisUrl = new URL(process.env.REDIS_URL ?? '')
  assert.ok(
    redisUrl.hostname === '127.0.0.1' && redisUrl.port === '58619',
    'Only the loopback Redis queue can run this rehearsal',
  )
  const before = await withTenantIsolationBypass(() =>
    db.prospectSendOutbox.findUnique({
      where: { id: outboxId },
      include: { providerAccount: true, sendItem: { include: { draft: true } } },
    }),
  )
  assert.ok(
    before &&
      before.status === 'PENDING' &&
      before.sendItem.draft.venueId?.startsWith('SYN-CRM-FIRSTSEND-') &&
      operationalOrigin(before.sendItem.draft.groundingSnapshot)?.synthetic === true &&
      before.providerAccount.provider === 'FAKE' &&
      !before.providerAccount.deliveryEnabled &&
      !before.providerAccount.credentialReferenceId &&
      before.providerAccount.mailboxAddress.endsWith('@example.invalid'),
    'An exact pending synthetic native-origin FAKE outbox is required',
  )
  const beforeCount = await withTenantIsolationBypass(() =>
    db.prospectEmailMessage.count({
      where: { sendItemId: before.sendItemId },
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
  let concurrentStarts = 0
  let releaseConcurrent!: () => void
  const concurrentBarrier = new Promise<void>((resolve) => {
    releaseConcurrent = resolve
  })
  const worker = new Worker(
    queueName,
    queueSafeJobProcessor(async (job) => {
      if (mode === 'concurrent' && concurrentStarts < 2) {
        concurrentStarts++
        if (concurrentStarts === 2) releaseConcurrent()
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            concurrentBarrier,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Concurrent jobs did not both start')),
                5000,
              )
            }),
          ])
        } finally {
          if (timeout) clearTimeout(timeout)
        }
      }
      // The barrier schedules concurrent arrivals; the production handler still
      // owns every claim, provider call, receipt and finalization.
      return handleSendEmailQueueJob(job)
    }),
    {
      connection,
      concurrency: mode === 'concurrent' ? 2 : 1,
    },
  )
  providerHook._setProspectCorrespondenceProviderForTesting(fake)
  const receipt: Record<string, unknown> = {
    schema: 'torchiko.connected-send-email-queue-proof/1',
    mode,
    outboxId,
    queueName,
    synthetic: true,
    provider: 'FAKE',
    externalHttpDisabled: true,
    externalSocketsRestrictedToLoopbackDbAndRedis: true,
    liveSend: false,
    passed: false,
  }
  try {
    await events.waitUntilReady()
    await worker.waitUntilReady()
    if (mode === 'stale') {
      await withTenantIsolationBypass(() =>
        db.prospectVenue.update({
          where: { id: before.sendItem.draft.venueId! },
          data: { notes: `SYNTHETIC queue stale-source negative ${queueName}` },
        }),
      )
    }
    if (
      mode === 'acceptance-fault' ||
      mode === 'acceptance-fault-state-change' ||
      mode === 'lookup-absent'
    ) {
      providerHook._setProspectAfterAcceptanceFaultForTesting(() => {
        providerHook._setProspectAfterAcceptanceFaultForTesting(undefined)
        if (mode === 'lookup-absent') fake.state.messages.clear()
        throw new Error('SYNTHETIC_POST_ACCEPTANCE_PERSISTENCE_FAULT')
      })
    }
    const first = await queue.add(
      SEND_PROSPECT_OUTREACH_JOB,
      { outboxId },
      {
        jobId: `first-${randomUUID()}`,
        attempts: ['acceptance-fault', 'lookup-absent'].includes(mode) ? 2 : 1,
        ...(['acceptance-fault', 'lookup-absent'].includes(mode)
          ? { backoff: { type: 'fixed', delay: 100 } }
          : {}),
      },
    )
    if (mode === 'concurrent') {
      const competing = await queue.add(
        SEND_PROSPECT_OUTREACH_JOB,
        { outboxId },
        {
          jobId: `concurrent-${randomUUID()}`,
          attempts: 1,
        },
      )
      await Promise.all([
        first.waitUntilFinished(events, 30_000),
        competing.waitUntilFinished(events, 30_000),
      ])
      assert.equal(concurrentStarts, 2, 'Two registered-handler jobs must overlap before claims')
      Object.assign(receipt, { concurrentJobId: competing.id, concurrentStarts })
    }
    if (mode === 'stale') {
      // The normal handler treats a held claim as a completed no-op job; its
      // durable outbox state carries the cancellation, not BullMQ failure.
      await first.waitUntilFinished(events, 30_000)
      assert.equal(fake.state.sent.length, 0, 'Stale source cannot reach FAKE provider')
      assert.equal(
        await withTenantIsolationBypass(() =>
          db.prospectEmailMessage.count({
            where: { sendItemId: before.sendItemId },
          }),
        ),
        0,
      )
      const held = await withTenantIsolationBypass(() =>
        db.prospectSendOutbox.findUnique({ where: { id: outboxId } }),
      )
      assert.ok(held?.status === 'CANCELLED' || held?.status === 'AMBIGUOUS')
      Object.assign(receipt, {
        passed: true,
        firstJobId: first.id,
        providerAcceptances: 0,
        retainedOutboxStatus: held.status,
        retainedErrorCode: held.lastErrorCode,
      })
    } else if (mode === 'acceptance-fault-state-change') {
      await assert.rejects(() => first.waitUntilFinished(events, 30_000))
      const uncertain = await withTenantIsolationBypass(() =>
        db.prospectSendOutbox.findUnique({
          where: { id: outboxId },
        }),
      )
      assert.equal(uncertain?.status, 'AMBIGUOUS')
      assert.equal(fake.state.sent.length, 1)
      await withTenantIsolationBypass(() =>
        db.prospectVenue.update({
          where: { id: before.sendItem.draft.venueId! },
          data: { notes: `SYNTHETIC source moved after provider acceptance ${queueName}` },
        }),
      )
      const retry = await queue.add(
        SEND_PROSPECT_OUTREACH_JOB,
        { outboxId },
        {
          jobId: `lookup-after-source-change-${randomUUID()}`,
          attempts: 1,
        },
      )
      await retry.waitUntilFinished(events, 30_000)
      const recovered = await withTenantIsolationBypass(() =>
        db.prospectSendOutbox.findUnique({
          where: { id: outboxId },
          include: { sendItem: { include: { message: true } } },
        }),
      )
      assert.ok(recovered?.status === 'SENT' && recovered.sendItem.message)
      assert.equal(recovered.attemptCount, 2)
      assert.equal(fake.state.sent.length, 1, 'Recovery must not call provider sendOne again')
      assert.equal(
        await withTenantIsolationBypass(() =>
          db.prospectEmailMessage.count({
            where: { sendItemId: before.sendItemId },
          }),
        ),
        1,
      )
      Object.assign(receipt, {
        passed: true,
        firstJobId: first.id,
        recoveryJobId: retry.id,
        providerAcceptances: 1,
        canonicalMessages: 1,
        retainedOutboxStatus: recovered.status,
        sourceMovedAfterAcceptance: true,
        recoveredByLookupOnly: true,
      })
    } else if (mode === 'lookup-absent') {
      await assert.rejects(() => first.waitUntilFinished(events, 30_000))
      const held = await withTenantIsolationBypass(() =>
        db.prospectSendOutbox.findUnique({
          where: { id: outboxId },
        }),
      )
      assert.equal(held?.status, 'AMBIGUOUS')
      assert.equal(fake.state.sent.length, 1)
      assert.equal(
        await withTenantIsolationBypass(() =>
          db.prospectEmailMessage.count({
            where: { sendItemId: before.sendItemId },
          }),
        ),
        0,
      )
      Object.assign(receipt, {
        passed: true,
        firstJobId: first.id,
        providerAcceptances: 1,
        canonicalMessages: 0,
        retainedOutboxStatus: held.status,
        retainedErrorCode: held.lastErrorCode,
      })
    } else {
      await first.waitUntilFinished(events, 30_000)
      const after = await withTenantIsolationBypass(() =>
        db.prospectSendOutbox.findUnique({
          where: { id: outboxId },
          include: { sendItem: { include: { message: true } } },
        }),
      )
      assert.equal(fake.state.sent.length, 1)
      assert.ok(after?.status === 'SENT' && after.sendItem.message?.providerMessageId)
      if (mode === 'acceptance-fault') assert.equal(after.attemptCount, 2)
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
            where: { sendItemId: before.sendItemId },
          }),
        ),
        1,
        'Queue replay must not append a duplicate canonical message',
      )
      Object.assign(receipt, {
        passed: true,
        firstJobId: first.id,
        replayJobId: second.id,
        providerMessageId: after.sendItem.message?.providerMessageId ?? null,
        canonicalMessageId: after.sendItem.message?.id ?? null,
        retainedOutboxStatus: after.status,
        providerAcceptances: fake.state.sent.length,
        recoveredAfterAcceptanceFault: mode === 'acceptance-fault',
      })
    }
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
