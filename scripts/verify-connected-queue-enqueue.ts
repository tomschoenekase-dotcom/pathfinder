/** Isolated proof of the production enqueue helper and registered send-email handler.
 * It uses one already staged SYN native-origin FAKE outbox, owns no account setup,
 * and never clears Redis, resets a fixture, or opens an external network socket.
 *
 * Modes:
 *   preclaim        failed retained stable job on PENDING -> fresh first acceptance
 *   expired-claimed accepted FAKE attempt with expired CLAIMED lease -> lookup only
 *   retryable       accepted FAKE attempt recorded RETRYABLE -> lookup only
 * Retained completed/failed jobs from prior modes remain in this isolated queue.
 * Each mode needs a distinct newly staged PENDING outbox and unique output filename:
 * pnpm exec tsx scripts/verify-connected-queue-enqueue.ts --mode preclaim \
 *   --outbox-id <synthetic-outbox-id> --output <external-qa-root>/enqueue-preclaim.json
 * Required environment: the exact disposable CRM DB on 127.0.0.1:58617,
 * REDIS_URL on 127.0.0.1:58619, RAILWAY_ENVIRONMENT=preview,
 * TORCHIKO_LOCAL_CRM_REHEARSAL=1, TORCHIKO_LOCAL_CRM_SALES_ENABLED=1,
 * TORCHIKO_CONNECTED_QA_DIR under C:/Users/tomsc/MachineWorkspaces.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'

const args = process.argv.slice(2)
assert.deepEqual(args.filter((arg) => arg.startsWith('--')).sort(), [
  '--mode',
  '--outbox-id',
  '--output',
])
const value = (name: string) => args[args.indexOf(name) + 1]
const mode = value('--mode')
assert.ok(mode === 'preclaim' || mode === 'expired-claimed' || mode === 'retryable')
const outboxId = value('--outbox-id') ?? ''
assert.ok(outboxId && outboxId.length <= 191 && !/[\r\n\0]/u.test(outboxId))
const qaRootArg = process.env.TORCHIKO_CONNECTED_QA_DIR
const outputArg = value('--output')
assert.ok(qaRootArg && outputArg)
const output = path.resolve(outputArg)

async function main() {
  const qaRoot = await realpath(qaRootArg!)
  const machineRoot = await realpath('C:/Users/tomsc/MachineWorkspaces')
  assert.ok(
    qaRoot.startsWith(machineRoot + path.sep),
    'The QA root must remain under the external machine workspace',
  )
  assert.equal(
    await realpath(path.dirname(output)),
    qaRoot,
    'The new proof receipt must be a direct child of the external QA root',
  )
  await assert.rejects(
    access(output),
    { code: 'ENOENT' },
    'The proof receipt must be new; existing receipts are immutable',
  )

  Reflect.set(process.env, 'NODE_ENV', 'development')
  assert.notEqual(
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED,
    'true',
    'Live prospect delivery must stay disabled',
  )
  // Install every outbound transport guard before importing DB, jobs or worker code.
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
      'EXTERNAL_SOCKET_DISABLED_FOR_CONNECTED_ENQUEUE_PROOF',
    )
    return originalConnect.apply(this, connectionArgs as never)
  } as typeof net.Socket.prototype.connect
  const requireLocal = createRequire(import.meta.url)
  const noHttp = () => {
    throw new Error('EXTERNAL_HTTP_DISABLED_FOR_CONNECTED_ENQUEUE_PROOF')
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
    operationalOrigin,
    claimProspectSendOutboxAction,
    recordProspectSendFailureAction,
    verifyStoredNativeOrigin,
  } = await import('../packages/db/src/index')
  assertLocalSalesEnvironment()
  assert.ok(localFirstSendRehearsalEnabled(), 'Only the isolated local rehearsal can run')
  const redisUrl = new URL(process.env.REDIS_URL ?? '')
  assert.ok(
    redisUrl.protocol === 'redis:' &&
      redisUrl.hostname === '127.0.0.1' &&
      redisUrl.port === '58619' &&
      !redisUrl.username &&
      !redisUrl.password,
    'Only the uncredentialed loopback Redis queue can run this rehearsal',
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
      before.attemptCount === 0 &&
      before.sendItem.draft.venueId?.startsWith('SYN-CRM-FIRSTSEND-') &&
      operationalOrigin(before.sendItem.draft.groundingSnapshot)?.synthetic === true &&
      before.providerAccount.provider === 'FAKE' &&
      !before.providerAccount.deliveryEnabled &&
      !before.providerAccount.credentialReferenceId &&
      before.providerAccount.mailboxAddress.endsWith('@example.invalid') &&
      before.sendItem.recipientEmailSnapshot.endsWith('@example.invalid'),
    'An exact unattempted PENDING synthetic native-origin FAKE outbox is required',
  )
  assert.equal(
    await withTenantIsolationBypass(() =>
      db.prospectEmailMessage.count({
        where: { sendItemId: before.sendItemId },
      }),
    ),
    0,
    'No canonical message may exist before this proof',
  )

  const workerRequire = createRequire(path.resolve('apps/workers/package.json'))
  // Shared job configuration validates these unused fields. Synthetic sentinels
  // avoid loading any account credential; the network guard is already active.
  process.env.CLERK_SECRET_KEY = 'test-secret'
  process.env.CLERK_PUBLISHABLE_KEY = 'test-publishable'
  const { Queue, Worker, QueueEvents } = workerRequire(
    'bullmq',
  ) as typeof import('../apps/workers/node_modules/bullmq')
  const {
    enqueueProspectOutreach,
    getBullMQConnection,
    closeJobQueues,
    closeBullMQConnection,
    SEND_EMAIL_QUEUE,
    SEND_PROSPECT_OUTREACH_JOB,
    SEND_PROSPECT_OUTREACH_RETRY_BACKOFF,
  } = await import('../packages/jobs/src/index')
  assert.equal(
    process.env.RAILWAY_ENVIRONMENT,
    'preview',
    'Only the isolated preview queue namespace is accepted',
  )
  assert.equal(
    SEND_EMAIL_QUEUE,
    'preview--send-email',
    'The production helper must resolve its preview send-email queue',
  )
  const { handleSendEmailQueueJob } =
    await import('../apps/workers/src/processors/send-email-queue')
  type SendQueueJob = Parameters<typeof handleSendEmailQueueJob>[0]
  type SendQueueData = SendQueueJob['data']
  const { queueSafeJobProcessor } = await import('../apps/workers/src/lib/job-execution')
  const { createFakeCorrespondenceProvider } =
    await import('../packages/api/src/correspondence/fake')
  const providerHook = await import('../apps/workers/src/processors/send-prospect-outreach')
  const fake = createFakeCorrespondenceProvider({ now: () => new Date() })
  let providerLookups = 0
  const countingProvider = {
    ...fake,
    async lookupSendOperation(input: Parameters<typeof fake.lookupSendOperation>[0]) {
      providerLookups++
      return fake.lookupSendOperation(input)
    },
  }
  const connection = getBullMQConnection()
  const queue = new Queue(SEND_EMAIL_QUEUE, { connection })
  const events = new QueueEvents(SEND_EMAIL_QUEUE, { connection })
  const identity = createHash('sha256')
    .update(`torchiko-prospect-outbox-v2:${outboxId}`)
    .digest('hex')
  const stableId = `send-prospect-outbox-${identity}`
  const workerSettings = {
    backoffStrategy: (attemptsMade: number, type: string | undefined) =>
      type === SEND_PROSPECT_OUTREACH_RETRY_BACKOFF
        ? Math.min(60_000, 2_000 * 2 ** Math.max(0, attemptsMade - 1))
        : 0,
  }
  let worker:
    | import('../apps/workers/node_modules/bullmq').Worker<SendQueueData, void, string>
    | undefined
  let step = 'queue-preflight'
  const receipt: Record<string, unknown> = {
    schema: 'torchiko.connected-production-enqueue-proof/1',
    mode,
    outboxId,
    queueName: SEND_EMAIL_QUEUE,
    synthetic: true,
    provider: 'FAKE',
    externalHttpDisabled: true,
    externalSocketsRestrictedToLoopbackDbAndRedis: true,
    liveSend: false,
    queueKeysPreserved: true,
    passed: false,
  }
  try {
    await queue.waitUntilReady()
    await events.waitUntilReady()
    const counts = await queue.getJobCounts(
      'wait',
      'active',
      'delayed',
      'prioritized',
      'paused',
      'waiting-children',
    )
    assert.ok(
      Object.values(counts).every((count) => count === 0),
      'The owned preview send-email queue must have no nonterminal jobs',
    )
    assert.equal(
      await queue.getWorkersCount(),
      0,
      'No other worker may own the isolated preview send-email queue',
    )
    assert.equal(
      await queue.getJobSchedulersCount(),
      0,
      'No existing scheduler may target the owned send-email queue',
    )
    assert.equal(await queue.isPaused(), false, 'The owned send-email queue must be running')
    assert.ok(
      !(await queue.getJob(stableId)),
      'This exact outbox must have no previously retained stable job',
    )
    providerHook._setProspectCorrespondenceProviderForTesting(countingProvider)

    if (mode !== 'preclaim') {
      step = 'durable-prior-attempt'
      const priorWorkerId = `synthetic-enqueue-prior:${randomUUID()}`
      const claimed = await withTenantIsolationBypass(() =>
        claimProspectSendOutboxAction(
          {
            outboxId,
            workerId: priorWorkerId,
          },
          db,
          verifyStoredNativeOrigin,
        ),
      )
      assert.ok(
        claimed && claimed.provider === 'FAKE' && claimed.attemptCount === 1,
        'The real DB owner must record the first provider attempt',
      )
      const headers =
        claimed.headers && typeof claimed.headers === 'object'
          ? (claimed.headers as Record<string, unknown>)
          : {}
      const reply = (
        headers.nativeSalesOrigin as
          | { reply?: { providerThreadId: string; inReplyTo: string; references: string[] } }
          | undefined
      )?.reply
      const frozen: import('../packages/api/src/correspondence').FrozenCorrespondence = {
        operationId: claimed.operationId,
        providerIdempotencyKey: claimed.idempotencyKey,
        mailbox: {
          provider: 'FAKE',
          providerAccountId: claimed.providerAccountId,
          mailboxId: claimed.externalAccountId,
          mailboxAddress: claimed.mailboxAddress,
          credentialRef: claimed.credentialReferenceId,
        },
        recipient: { email: claimed.recipient },
        from: { email: claimed.mailboxAddress },
        subject: claimed.subject,
        textBody: claimed.textBody,
        rfcMessageId: `<torchiko.${claimed.operationId}@torchiko.com>`,
        references: reply?.references ?? [],
        ...(reply ? { inReplyTo: reply.inReplyTo, providerThreadId: reply.providerThreadId } : {}),
      }
      await fake.sendOne(frozen)
      assert.equal(fake.state.sent.length, 1)
      if (mode === 'expired-claimed') {
        const expired = await withTenantIsolationBypass(() =>
          db.prospectSendOutbox.updateMany({
            where: { id: outboxId, status: 'CLAIMED', claimOwner: priorWorkerId, attemptCount: 1 },
            data: { claimExpiresAt: new Date(Date.now() - 1_000) },
          }),
        )
        assert.equal(expired.count, 1, 'Only the synthetic first claim may be expired')
      } else {
        await withTenantIsolationBypass(() =>
          recordProspectSendFailureAction({
            outboxId,
            workerId: priorWorkerId,
            code: 'TRANSIENT',
            retryable: true,
            acceptanceAmbiguous: false,
            retryAt: new Date(Date.now() - 1_000),
          }),
        )
      }
    }

    step = 'retained-stable-preclaim-failure'
    await enqueueProspectOutreach({ outboxId })
    const stable = await queue.getJob(stableId)
    assert.ok(stable && stable.name === SEND_PROSPECT_OUTREACH_JOB)
    let stableGuardUsed = false
    worker = new Worker<SendQueueData, void, string>(
      SEND_EMAIL_QUEUE,
      queueSafeJobProcessor(async (job: SendQueueJob) => {
        if (job.id === stableId) {
          assert.equal(stableGuardUsed, false, 'Only one stable preclaim failure is allowed')
          stableGuardUsed = true
          job.discard() // Keep the production job's four-attempt policy but make this fixture failure terminal.
          const rehearsalFlag = process.env.TORCHIKO_LOCAL_CRM_REHEARSAL
          process.env.TORCHIKO_LOCAL_CRM_REHEARSAL = '0'
          try {
            return await handleSendEmailQueueJob(job)
          } finally {
            process.env.TORCHIKO_LOCAL_CRM_REHEARSAL = rehearsalFlag
          }
        }
        return handleSendEmailQueueJob(job)
      }),
      { connection, concurrency: 1, settings: workerSettings },
    )
    await worker.waitUntilReady()
    await assert.rejects(() => stable.waitUntilFinished(events, 30_000))
    assert.equal(await stable.getState(), 'failed', 'Failed stable job must remain inspectable')
    assert.equal(stableGuardUsed, true)
    const afterStable = await withTenantIsolationBypass(() =>
      db.prospectSendOutbox.findUnique({
        where: { id: outboxId },
        select: { status: true, attemptCount: true },
      }),
    )
    assert.equal(
      afterStable?.status,
      mode === 'preclaim' ? 'PENDING' : mode === 'expired-claimed' ? 'CLAIMED' : 'RETRYABLE',
    )
    assert.equal(afterStable?.attemptCount, mode === 'preclaim' ? 0 : 1)
    assert.equal(fake.state.sent.length, mode === 'preclaim' ? 0 : 1)
    assert.equal(
      await withTenantIsolationBypass(() =>
        db.prospectEmailMessage.count({
          where: { sendItemId: before.sendItemId },
        }),
      ),
      0,
      'A failed stable job must not produce a canonical send message',
    )

    step = 'production-reenqueue'
    await worker.close()
    worker = undefined
    await enqueueProspectOutreach({ outboxId }, { recovery: mode !== 'preclaim' })
    const jobs = (
      await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])
    ).filter((job) => job.data?.outboxId === outboxId)
    const next = jobs.find((job) => job.id !== stableId && job.name === SEND_PROSPECT_OUTREACH_JOB)
    assert.ok(next && jobs.length === 2, 'One distinct production-helper retry job is required')
    assert.ok(
      next.id?.startsWith(
        mode === 'preclaim'
          ? `send-prospect-outbox-retry-${identity}-`
          : `send-prospect-outbox-recovery-${identity}-`,
      ),
    )
    worker = new Worker<SendQueueData, void, string>(
      SEND_EMAIL_QUEUE,
      queueSafeJobProcessor(handleSendEmailQueueJob),
      { connection, concurrency: 1, settings: workerSettings },
    )
    await worker.waitUntilReady()
    await next.waitUntilFinished(events, 30_000)

    step = 'canonical-readback'
    const after = await withTenantIsolationBypass(() =>
      db.prospectSendOutbox.findUnique({
        where: { id: outboxId },
        include: { sendItem: { include: { message: true } } },
      }),
    )
    assert.ok(
      after?.status === 'SENT' && after.sendItem.message?.providerMessageId,
      'Registered worker must retain one exact canonical acceptance',
    )
    assert.equal(after.attemptCount, mode === 'preclaim' ? 1 : 2)
    assert.equal(fake.state.sent.length, 1, 'Recovery must use lookup only; no second sendOne')
    assert.equal(
      providerLookups,
      mode === 'preclaim' ? 0 : 1,
      'Only a durable prior attempt may perform one exact provider lookup',
    )
    assert.equal(
      await withTenantIsolationBypass(() =>
        db.prospectEmailMessage.count({
          where: { sendItemId: before.sendItemId },
        }),
      ),
      1,
    )
    assert.equal(
      await stable.getState(),
      'failed',
      'Original failed stable job remains as evidence',
    )
    Object.assign(receipt, {
      passed: true,
      stableJobId: stableId,
      retryJobId: next.id,
      retainedStableState: 'failed',
      priorDurableAttempt: mode !== 'preclaim',
      recoveredByLookupOnly: mode !== 'preclaim',
      providerAcceptances: fake.state.sent.length,
      providerLookups,
      canonicalMessageId: after.sendItem.message.id,
      canonicalMessages: 1,
      retainedOutboxStatus: after.status,
      attemptCount: after.attemptCount,
    })
  } catch (error) {
    receipt.failedStep = step
    receipt.errorClass = error instanceof Error ? error.name : 'UnknownFailure'
    throw error
  } finally {
    providerHook._setProspectCorrespondenceProviderForTesting(undefined)
    providerHook._setProspectAfterAcceptanceFaultForTesting(undefined)
    const cleanup = [
      () => worker?.close(),
      () => events.close(),
      () => queue.close(),
      () => closeJobQueues(),
      () => closeBullMQConnection(),
      () => db.$disconnect(),
    ]
    for (const close of cleanup) {
      try {
        await close()
      } catch {
        receipt.cleanupFailed = true
      }
    }
    await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' })
  }
  assert.equal(receipt.passed, true)
  assert.equal(receipt.cleanupFailed, undefined, 'All owned connections must close cleanly')
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.name : 'UnknownFailure'}\n`)
  // Configuration diagnostics must identify fields without printing input values.
  const issues = error && typeof error === 'object' && 'issues' in error ? error.issues : null
  if (Array.isArray(issues))
    process.stderr.write(
      JSON.stringify(
        issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
        })),
      ) + '\n',
    )
  process.exitCode = 1
})
