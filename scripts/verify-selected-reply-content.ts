/** Disposable SOURCE_ONLY reply proof. Requires the isolated loopback CRM DB, a
 * parent-allocated QA directory, and enough free disk. No provider or send path
 * is reachable: the only socket allowed after this script starts is Postgres. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, realpath, statfs } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'

const args = process.argv.slice(2)
const value = (flag: string) => args[args.indexOf(flag) + 1]
assert.deepEqual(args.filter((arg) => arg.startsWith('--')).sort(), ['--mode', '--output'])
const mode = value('--mode')
assert.ok(mode === 'db' || mode === 'full', 'Choose --mode db or --mode full')
const qaDir = process.env.TORCHIKO_CONNECTED_QA_DIR
assert.ok(qaDir, 'TORCHIKO_CONNECTED_QA_DIR must be a parent-allocated external QA directory')
const qaRoot = path.resolve(qaDir)
const outputArg = value('--output')
assert.ok(outputArg, 'An exact --output path is required')
const output = path.resolve(outputArg)
assert.equal(
  path.dirname(output),
  qaRoot,
  'The receipt must be directly under the allocated QA directory',
)
assert.ok(output.endsWith('.json'))

const runId = randomUUID()
const prefix = `SYN-CRM-FIRSTSEND-SELECTED-REPLY-${runId}`
const ids = {
  organization: `${prefix}-org`,
  venue: `${prefix}-venue`,
  contact: `${prefix}-contact`,
  account: `${prefix}-account`,
  source: `${prefix}-source`,
  thread: `${prefix}-thread`,
  mapping: `${prefix}-mapping`,
  outbound: `${prefix}-outbound`,
  providerThread: `${prefix}-provider-thread`,
  providerInbound: `${prefix}-provider-inbound`,
  providerOutbound: `${prefix}-provider-outbound`,
  receipt: `${prefix}-receipt`,
}
const actor = {
  type: 'SYSTEM' as const,
  role: 'PLATFORM_ADMIN' as const,
  id: `synthetic:crm-meaning:selected-reply-${runId}`,
}
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const rawBody =
  'Yes, one room could work. What setup time would our staff need?\n\nOn Monday, the sender wrote:\n> Previous synthetic message.'
const receipt: Record<string, unknown> = {
  schema: 'torchiko.selected-reply-content-proof/1',
  mode,
  runId,
  ids,
  synthetic: true,
  provider: 'FAKE',
  liveProviderRead: false,
  liveSend: false,
  externalNetworkDisabledBeforeProjectImports: false,
  passedDb: false,
  passedReplyPreparation: false,
  startedAt: new Date().toISOString(),
}
let receiptFile: Awaited<ReturnType<typeof open>> | undefined

function installNetworkGuard() {
  const original = net.Socket.prototype.connect
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
      host === '127.0.0.1' && port === 58617,
      'EXTERNAL_SOCKET_DISABLED_FOR_SELECTED_REPLY_PROOF',
    )
    return original.apply(this, connectionArgs as never)
  } as typeof net.Socket.prototype.connect
  const noHttp = () => {
    throw new Error('EXTERNAL_HTTP_DISABLED_FOR_SELECTED_REPLY_PROOF')
  }
  globalThis.fetch = noHttp as never
  const requireLocal = createRequire(import.meta.url)
  for (const protocol of ['node:http', 'node:https']) {
    const module = requireLocal(protocol)
    module.request = noHttp
    module.get = noHttp
  }
  requireLocal('node:tls').connect = noHttp
  receipt.externalNetworkDisabledBeforeProjectImports = true
}

async function preflight() {
  const actualQaRoot = await realpath(qaRoot)
  const machineRoot = await realpath(
    path.resolve(process.env.USERPROFILE ?? 'C:/Users/tomsc', 'MachineWorkspaces'),
  )
  assert.ok(
    actualQaRoot.startsWith(machineRoot + path.sep),
    'The QA directory must resolve inside the external machine workspace',
  )
  const stats = await statfs(qaRoot)
  const freeBytes = Number(stats.bavail) * Number(stats.bsize)
  assert.ok(
    Number.isSafeInteger(freeBytes) && freeBytes >= 5 * 1024 ** 3 + 32 * 1024 ** 2,
    'QA disk is below the 5 GiB plus 32 MiB reserve',
  )
  const database = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(
    database.hostname === '127.0.0.1' &&
      database.port === '58617' &&
      database.pathname === '/pathfinder_disposable_crm_research_20260919' &&
      !database.search &&
      !database.hash,
    'Only the disposable loopback CRM database is allowed',
  )
  assert.ok(
    ['test', 'development'].includes(process.env.NODE_ENV ?? '') &&
      process.env.APP_ENV !== 'production' &&
      process.env.DEPLOYMENT_ENV !== 'production' &&
      process.env.TORCHIKO_LOCAL_CRM_REHEARSAL === '1' &&
      process.env.TORCHIKO_LOCAL_CRM_SALES_ENABLED === '1',
    'The explicit local CRM rehearsal environment is required',
  )
  installNetworkGuard()
}

async function main() {
  await preflight()
  // Claim the exact output before any fixture mutation. An existing receipt or
  // unexpected path conflict cannot strand a new run without proof.
  receiptFile = await open(output, 'wx')
  const { db, withTenantIsolationBypass, localFirstSendRehearsalEnabled, readNativeSalesSnapshot } =
    await import('../packages/db/src/index')
  assert.ok(localFirstSendRehearsalEnabled(), 'Native local rehearsal guard refused this database')
  try {
    const { createFakeCorrespondenceProvider } =
      await import('../packages/api/src/correspondence/fake')
    const { normalizeUntrustedCorrespondenceBody } =
      await import('../packages/api/src/correspondence/content-safety')
    const { createInboundCorrespondenceService } =
      await import('../packages/api/src/correspondence/inbound-sync')
    const { createPrismaInboundCorrespondenceStore } =
      await import('../packages/api/src/correspondence/prisma-inbound-store')
    const { readExactSourceOnlyReplyContent } =
      await import('../packages/api/src/correspondence/exact-reply-content')
    const { retainSelectedSourceOnlyReply } =
      await import('../packages/api/src/correspondence/selected-reply-retention')

    const mailbox = {
      provider: 'FAKE' as const,
      providerAccountId: ids.account,
      mailboxId: `${prefix}-mailbox`,
      mailboxAddress: `selected-reply-${runId}@example.invalid`,
      credentialRef: `${prefix}-NO-REAL-CREDENTIAL`,
    }
    const sourceReference = `synthetic:crm-sales:fake-provider:${ids.providerInbound}`
    const contactEmail =
      mode === 'full' ? 'fixture@example.invalid' : `reply-contact-${runId}@example.invalid`
    let syntheticPins: Record<string, string> | null = null
    if (mode === 'full') {
      const vaultRoot = await realpath(process.env.TORCHIKO_CRM_VAULT ?? '')
      assert.equal(
        vaultRoot,
        await realpath('C:/Users/tomsc/Downloads/AwesomeVault'),
        'Only the installed synthetic correspondence source owner is admitted',
      )
      const owner = path.join(
        vaultRoot,
        '95 AI Staging/Torchiko Outreach Composer 2026-09-20/integration/correspondence-engine-v01/synthetic-reply-source',
      )
      syntheticPins = Object.fromEntries(
        await Promise.all(
          ['pilot.json', 'contacts.json'].map(async (name) => {
            const sourcePath = path.join(owner, name)
            return [
              sourcePath,
              createHash('sha256')
                .update(await readFile(sourcePath))
                .digest('hex'),
            ]
          }),
        ),
      )
    }
    const outboundRfcId = `<selected-outbound-${runId}@example.invalid>`
    const inboundRfcId = `<selected-inbound-${runId}@example.invalid>`
    const subject = 'Re: Synthetic room exhibit'
    const outboundText = 'Synthetic fixture opening question. No email was sent.'
    const now = new Date()
    await withTenantIsolationBypass(() =>
      db.$transaction(
        async (tx) => {
          assert.equal(
            await tx.prospectOrganization.count({ where: { id: ids.organization } }),
            0,
            'Fresh fixture ID already exists',
          )
          await tx.prospectOrganization.create({
            data: {
              id: ids.organization,
              canonicalName: `SYNTHETIC Selected Reply ${runId}`,
              normalizedName: `synthetic selected reply ${runId}`,
              source: 'Isolated FAKE selected-reply proof; no real prospect source',
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          })
          await tx.prospectVenue.create({
            data: {
              id: ids.venue,
              organizationId: ids.organization,
              name: mode === 'full' ? 'Fixture Museum' : 'SYNTHETIC Selected Reply Venue',
              normalizedName:
                mode === 'full' ? 'fixture museum' : `synthetic selected reply venue ${runId}`,
              city: 'Synthetic City',
              region: 'SYN',
              website: 'https://example.invalid/selected-reply',
              notes:
                'Fixture only. No real venue, website visit, account action, approval or send.',
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          })
          await tx.prospectContact.create({
            data: {
              id: ids.contact,
              organizationId: ids.organization,
              venueId: ids.venue,
              email: contactEmail,
              normalizedEmail: contactEmail,
              emailReadiness: 'VALID',
              permissionState: 'UNKNOWN',
              source: 'Synthetic fixture value; no human contact verification',
              provenance: { synthetic: true, noHumanReview: true },
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          })
          await tx.prospectSourceEvidence.create({
            data: {
              id: ids.source,
              organizationId: ids.organization,
              venueId: ids.venue,
              sourceType:
                mode === 'full'
                  ? 'CRM_SYNTHETIC_COMPONENT_FIXTURE_V1'
                  : 'CRM_SYNTHETIC_SELECTED_REPLY_FIXTURE_V1',
              sourceLabel: 'Isolated synthetic selected-reply source; not public evidence',
              capturedValue:
                mode === 'full'
                  ? { synthetic: true, fixtureOwnerHashes: syntheticPins, SEND_AUTHORIZED: false }
                  : { synthetic: true, SEND_AUTHORIZED: false },
              createdBy: actor.id,
            },
          })
          await tx.correspondenceProviderAccount.create({
            data: {
              id: ids.account,
              provider: 'FAKE',
              externalAccountId: mailbox.mailboxId,
              mailboxAddress: mailbox.mailboxAddress,
              credentialReferenceId: mailbox.credentialRef,
              displayName: 'Isolated FAKE source-read fixture; no usable external credentials',
              deliveryEnabled: false,
              connectionStatus: 'CONNECTED',
              capabilities: [],
              dailySendCap: 1,
              perDomainDailyCap: 1,
              minimumDelaySeconds: 0,
              jitterSeconds: 0,
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          })
          await tx.prospectEmailThread.create({
            data: {
              id: ids.thread,
              organizationId: ids.organization,
              venueId: ids.venue,
              contactId: ids.contact,
              subject,
              replyTokenHash: sha(`${prefix}-reply-token`),
            },
          })
          await tx.prospectEmailThreadProvider.create({
            data: {
              id: ids.mapping,
              threadId: ids.thread,
              providerAccountId: ids.account,
              providerThreadId: ids.providerThread,
            },
          })
          await tx.prospectEmailMessage.create({
            data: {
              id: ids.outbound,
              threadId: ids.thread,
              organizationId: ids.organization,
              venueId: ids.venue,
              contactId: ids.contact,
              direction: 'OUTBOUND',
              status: 'SENT',
              providerAccountId: ids.account,
              providerMessageId: ids.providerOutbound,
              internetMessageId: outboundRfcId,
              fromAddress: mailbox.mailboxAddress,
              toAddresses: [contactEmail],
              subject,
              textBody: outboundText,
              bodyRetentionState: 'TEMPORARY',
              bodyExpiresAt: new Date(now.getTime() + 86_400_000),
              sourceReference: `synthetic:crm-sales:fake-provider:${ids.providerOutbound}`,
              occurredAt: new Date(now.getTime() - 60_000),
            },
          })
        },
        { isolationLevel: 'Serializable' },
      ),
    )

    const fake = createFakeCorrespondenceProvider({ now: () => now })
    const messageRef = {
      provider: 'FAKE' as const,
      providerAccountId: ids.account,
      mailboxId: mailbox.mailboxId,
      externalId: ids.providerInbound,
    }
    fake.state.messages.set(ids.providerInbound, {
      message: messageRef,
      thread: { ...messageRef, externalId: ids.providerThread },
      rfcMessageId: inboundRfcId,
      inReplyTo: outboundRfcId,
      references: [outboundRfcId],
      from: [{ email: contactEmail }],
      to: [{ email: mailbox.mailboxAddress }],
      cc: [],
      bcc: [],
      subject,
      internalDate: now,
      direction: 'INBOUND',
      body: normalizeUntrustedCorrespondenceBody({ text: rawBody }),
      attachments: [],
    })
    const service = createInboundCorrespondenceService({
      provider: fake,
      store: createPrismaInboundCorrespondenceStore({
        bodyPersistence: { mode: 'SOURCE_ONLY' },
      }),
    })
    const notification = { mailbox, externalReceiptId: ids.receipt, message: messageRef }
    const first = await service.receiveNotification(notification)
    assert.equal(first.state, 'PROCESSED')
    assert.equal(first.receipt.state, 'PROCESSED')
    const canonical = await withTenantIsolationBypass(() =>
      db.prospectEmailMessage.findUniqueOrThrow({
        where: {
          providerAccountId_providerMessageId: {
            providerAccountId: ids.account,
            providerMessageId: ids.providerInbound,
          },
        },
      }),
    )
    assert.equal(canonical.threadId, ids.thread)
    assert.equal(canonical.textBody, null)
    assert.equal(canonical.bodyRetentionState, 'NOT_STORED')
    assert.equal(canonical.sourceReference, sourceReference)
    const signalKey = `crm:reply_received:ProspectEmailMessage:${canonical.id}`
    const signal = await withTenantIsolationBypass(() =>
      db.platformOperationalEvent.findUniqueOrThrow({
        where: { deduplicationKey: signalKey },
      }),
    )
    assert.equal(signal.occurrenceCount, 1)

    const selected = {
      canonicalMessageId: canonical.id,
      canonicalThreadId: canonical.threadId,
      organizationId: canonical.organizationId,
      provider: 'FAKE' as const,
      providerAccountId: ids.account,
      mailboxId: mailbox.mailboxId,
      providerMessageId: ids.providerInbound,
      providerThreadId: ids.providerThread,
      internetMessageId: canonical.internetMessageId,
      fromAddress: canonical.fromAddress,
      subject: canonical.subject,
      occurredAt: canonical.occurredAt,
      sourceReference,
      direction: 'INBOUND' as const,
      bodyRetentionState: 'NOT_STORED' as const,
    }
    const exact = await readExactSourceOnlyReplyContent({ provider: fake, mailbox, selected })
    assert.equal(exact.rawBodySha256, sha(rawBody))
    assert.ok(exact.replyText.includes('one room could work'))
    assert.ok(!exact.replyText.includes('Previous synthetic message'))
    assert.equal(exact.retention, 'TRANSIENT_SOURCE_READ')
    const expected = {
      canonicalMessageId: canonical.id,
      canonicalThreadId: ids.thread,
      organizationId: ids.organization,
      providerAccountId: ids.account,
      providerMessageId: ids.providerInbound,
      providerThreadId: ids.providerThread,
      sourceReference,
      rawBodySha256: exact.rawBodySha256,
    }
    const retained = await retainSelectedSourceOnlyReply({
      provider: fake,
      mailbox,
      expected,
      retentionDays: 1,
      actor,
    })
    assert.equal(retained.state, 'RETAINED')
    const retainedRow = await withTenantIsolationBypass(() =>
      db.prospectEmailMessage.findUniqueOrThrow({
        where: { id: canonical.id },
      }),
    )
    assert.equal(retainedRow.textBody, rawBody)
    assert.equal(retainedRow.bodyRetentionState, 'TEMPORARY')
    assert.equal(retainedRow.sourceReference, sourceReference)
    assert.equal(retainedRow.bodyExpiresAt?.getTime(), retained.expiresAt.getTime())
    const audit = await withTenantIsolationBypass(() =>
      db.auditLog.findFirst({
        where: { action: 'admin.prospect.reply_body_retained', targetId: canonical.id },
        orderBy: { createdAt: 'desc' },
      }),
    )
    assert.ok(audit && audit.actorType === 'SYSTEM' && audit.actorId === actor.id)
    assert.ok(
      !JSON.stringify(audit).includes(rawBody),
      'Audit must not persist raw provider content',
    )
    const replay = await retainSelectedSourceOnlyReply({
      provider: fake,
      mailbox,
      expected,
      retentionDays: 30,
      actor,
    })
    assert.equal(replay.state, 'REPLAYED')
    assert.equal(replay.expiresAt.getTime(), retained.expiresAt.getTime())
    const duplicate = await service.receiveNotification(notification)
    assert.equal(duplicate.state, 'DUPLICATE')
    assert.equal(duplicate.receipt.state, 'PROCESSED')
    const sync = await service.synchronize(mailbox)
    assert.equal(sync.mode, 'FULL_RECONCILIATION')
    const persistedAfterSync = await withTenantIsolationBypass(() =>
      Promise.all([
        db.correspondenceProviderAccount.findUniqueOrThrow({ where: { id: ids.account } }),
        db.prospectEmailMessage.findUniqueOrThrow({ where: { id: canonical.id } }),
      ]),
    )
    assert.equal(persistedAfterSync[0].syncCursor, sync.cursor)
    assert.equal(persistedAfterSync[1].textBody, rawBody)
    assert.equal(persistedAfterSync[1].bodyExpiresAt?.getTime(), retained.expiresAt.getTime())
    const signalAfter = await withTenantIsolationBypass(() =>
      db.platformOperationalEvent.findUniqueOrThrow({
        where: { deduplicationKey: signalKey },
      }),
    )
    assert.equal(signalAfter.occurrenceCount, 1)
    assert.equal(
      await withTenantIsolationBypass(() =>
        db.prospectEmailEvent.count({
          where: {
            providerAccountId: ids.account,
            providerEventId: `reply-signal:${canonical.id}`,
          },
        }),
      ),
      1,
    )
    receipt.db = {
      canonicalMessageId: canonical.id,
      canonicalThreadId: canonical.threadId,
      sourceReference,
      rawBodySha256: exact.rawBodySha256,
      transientReplySha256: sha(exact.replyText),
      firstReceiptState: first.receipt.state,
      duplicateReceiptState: duplicate.receipt.state,
      retainedState: retained.state,
      replayState: replay.state,
      retentionExpiresAt: retained.expiresAt.toISOString(),
      auditId: audit.id,
      auditActorType: audit.actorType,
      syncMode: sync.mode,
      syncCursorReadBack: persistedAfterSync[0].syncCursor,
      signalOccurrenceBefore: signal.occurrenceCount,
      signalOccurrenceAfter: signalAfter.occurrenceCount,
    }
    receipt.passedDb = true

    if (mode === 'full') {
      // The installed synthetic component owner only accepts a disabled FAKE
      // account. Retention was already proven against CONNECTED; this changes
      // solely the fresh fixture row, after all exact-read/replay assertions.
      const transition = await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.updateMany({
          where: {
            id: ids.account,
            provider: 'FAKE',
            deliveryEnabled: false,
            connectionStatus: 'CONNECTED',
            credentialReferenceId: mailbox.credentialRef,
          },
          data: {
            connectionStatus: 'DISCONNECTED',
            credentialReferenceId: null,
            updatedBy: actor.id,
          },
        }),
      )
      assert.equal(transition.count, 1, 'Synthetic account transition lost its exact fixture scope')
      receipt.syntheticFixtureAccountTransition = 'CONNECTED_TO_DISCONNECTED_AFTER_RETENTION'
      // Match the existing local acceptance owner after the guarded Prisma
      // client is loaded; the private preview gate intentionally rejects test.
      process.env.NODE_ENV = 'development'
      const { assertLocalSalesEnvironment, getNativeSalesWorkflow, applyNativeSalesAction } =
        await import('../packages/api/src/prospect-sales-workflow')
      assertLocalSalesEnvironment()
      const native = await withTenantIsolationBypass(() => readNativeSalesSnapshot(ids.venue))
      const prepared = await applyNativeSalesAction(
        {
          action: 'prepare',
          input: {
            venueId: ids.venue,
            expectedSnapshotHash: native.snapshotHash,
            selectedThreadId: ids.thread,
            answerText: 'The synthetic contact asks about one room and staff setup time.',
          },
        },
        actor,
      )
      const preparedId = 'preparation' in prepared ? prepared.preparation?.id : null
      assert.ok(preparedId, 'Native preparation must persist and read back')
      const readback = await getNativeSalesWorkflow(ids.venue)
      const currentPreparation = readback.preparation
      const writerTask = readback.writerTask
      assert.ok(currentPreparation && currentPreparation.id === preparedId)
      assert.ok(writerTask?.taskId && writerTask.binding.preparationId === preparedId)
      assert.equal(readback.SEND_AUTHORIZED, false)
      receipt.native = {
        preparationId: currentPreparation.id,
        writerTaskId: writerTask.taskId,
        boundCanonicalMessageId: canonical.id,
        sendAuthorized: readback.SEND_AUTHORIZED,
      }
      receipt.passedReplyPreparation = true
    } else {
      receipt.native = {
        status: 'NOT_ATTEMPTED',
        reason:
          'Run --mode full with the private local sales component owner after the DB proof passes',
      }
    }
  } finally {
    await db.$disconnect()
  }
}

async function run() {
  try {
    await main()
  } catch (error) {
    receipt.error = error instanceof Error ? error.message.slice(0, 500) : 'Unknown proof failure'
    process.exitCode = 1
  } finally {
    receipt.finishedAt = new Date().toISOString()
    if (receiptFile) {
      try {
        await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + '\n')
      } finally {
        await receiptFile.close()
      }
    }
  }
}
void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.name : 'UnknownFailure'}\n`)
  process.exitCode = 1
})
