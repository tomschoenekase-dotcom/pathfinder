import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve(__dirname, '..'),
  artifacts = path.join(root, 'artifacts/crm-first-send-20260921-r001')
const argument = (key: string, fallback = '') => {
  const i = process.argv.indexOf(key)
  return i < 0 ? fallback : process.argv[i + 1]!
}
const mode = argument('--phase', 'inspect')
assert.ok(['stage', 'inspect', 'dispatch', 'receive', 'suppress', 'boundaries'].includes(mode))
const fixtureRevision = argument('--fixture-revision', 'r001')
assert.match(fixtureRevision, /^r\d{3}$/u)
const output = path.resolve(
  argument('--output', path.join(artifacts, `${mode}-${Date.now()}.json`)),
)
const connectedQa = process.env.TORCHIKO_CONNECTED_QA_DIR
assert.ok(
  output.startsWith(artifacts + path.sep) ||
    (connectedQa && output.startsWith(path.resolve(connectedQa) + path.sep)),
)
const prefix = 'SYN-CRM-FIRSTSEND-',
  ids = {
    organizationId: prefix + 'ORG-' + fixtureRevision,
    venueId: prefix + 'VENUE-' + fixtureRevision,
    contactId: prefix + 'CONTACT-' + fixtureRevision,
    accountId: prefix + 'ACCOUNT-' + fixtureRevision,
    sourceId: prefix + 'SOURCE-' + fixtureRevision,
  }
const actor = {
  type: 'SYSTEM' as const,
  role: 'PLATFORM_ADMIN' as const,
  id: 'synthetic:crm-meaning:first-send-foreground-rehearsal',
}
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex')
const requireLocal = createRequire(path.join(root, 'package.json'))
const networkAttempts: string[] = []
function denyNetwork() {
  const fail = (..._args: unknown[]) => {
    networkAttempts.push('external HTTP request refused')
    throw new Error('FIRST_SEND_REHEARSAL_EXTERNAL_NETWORK_DISABLED')
  }
  globalThis.fetch = fail as never
  for (const protocol of ['node:http', 'node:https']) {
    const module = requireLocal(protocol)
    module.request = fail
    module.get = fail
  }
}

async function main() {
  await mkdir(path.dirname(output), { recursive: true })
  const { db } = await import('../packages/db/src/client')
  process.env.NODE_ENV = 'development'
  const { withTenantIsolationBypass } =
    await import('../packages/db/src/middleware/tenant-isolation')
  const { localFirstSendRehearsalEnabled } =
    await import('../packages/db/src/helpers/prospect-native-origin')
  const { readNativeSalesSnapshot, salesHash } =
    await import('../packages/db/src/helpers/prospect-sales-snapshot')
  const {
    assertLocalSalesEnvironment,
    getNativeSalesWorkflow,
    invokeSalesComponents,
    verifyNativeOriginRuntime,
  } = await import('../packages/api/src/prospect-sales-workflow')
  assertLocalSalesEnvironment()
  assert.ok(localFirstSendRehearsalEnabled())
  denyNetwork()
  const checks: { label: string; passed: boolean }[] = [],
    receipt: Record<string, unknown> = {
      mode,
      startedAt: new Date().toISOString(),
      ids,
      checks,
      networkAttempts,
      synthetic: true,
      liveSend: false,
      humanApproval: 'ABSENT',
    }
  const check = (ok: unknown, label: string) => {
    checks.push({ label, passed: Boolean(ok) })
    assert.ok(ok, label)
    console.log('PASS ' + label)
  }
  try {
    await withTenantIsolationBypass(async () => {
      const originals: Record<string, unknown> = {}
      for (const name of ['Centralia Historical Society Museum', 'Evanston History Center']) {
        const venue = await db.prospectVenue.findFirst({ where: { name } })
        assert.ok(venue)
        const n = await readNativeSalesSnapshot(venue.id)
        originals[name] = {
          venueId: n.venue.id,
          organizationId: n.organization.id,
          hash: salesHash({
            venue: n.venue,
            organization: n.organization,
            contacts: n.contacts,
            imports: n.importRecords,
            originalSources: n.sources.filter(
              (s) => !s.sourceType.startsWith('CRM_NATIVE_SOURCE_SELECTION'),
            ),
          }),
        }
      }
      receipt.originals = originals
      const controls = await db.prospectDeliveryControl.findMany(),
        oldAccounts = await db.correspondenceProviderAccount.findMany({
          where: { id: { not: ids.accountId } },
        })
      const controlHash = salesHash(controls),
        accountHash = salesHash(oldAccounts)
      if (mode === 'stage') {
        const owner = path.join(
          process.env.TORCHIKO_CRM_VAULT!,
          '95 AI Staging/Torchiko Outreach Composer 2026-09-20/integration/correspondence-engine-v01/synthetic-reply-source',
        )
        const pins = Object.fromEntries(
          await Promise.all(
            ['pilot.json', 'contacts.json'].map(async (f) => {
              const p = path.join(owner, f)
              return [p, sha(await readFile(p))]
            }),
          ),
        )
        const source = { synthetic: true, fixtureOwnerHashes: pins, SEND_AUTHORIZED: false }
        await db.$transaction(
          async (tx) => {
            const existing = await tx.prospectOrganization.findUnique({
              where: { id: ids.organizationId },
            })
            if (!existing) {
              await tx.prospectOrganization.create({
                data: {
                  id: ids.organizationId,
                  canonicalName: 'SYNTHETIC First Send Fixture Museum',
                  normalizedName: 'synthetic first send fixture museum',
                  source: 'Explicit first-send local rehearsal, not a real venue',
                  createdBy: actor.id,
                  updatedBy: actor.id,
                },
              })
              await tx.prospectVenue.create({
                data: {
                  id: ids.venueId,
                  organizationId: ids.organizationId,
                  name: 'Fixture Museum',
                  normalizedName: 'fixture museum',
                  city: 'Synthetic City',
                  region: 'SYN',
                  website: 'https://example.invalid/museum',
                  createdBy: actor.id,
                  updatedBy: actor.id,
                  notes:
                    'SYNTHETIC source fixture only. No website was fetched; no real import or contact identity is borrowed.',
                },
              })
              await tx.prospectContact.create({
                data: {
                  id: ids.contactId,
                  organizationId: ids.organizationId,
                  venueId: ids.venueId,
                  email: 'fixture@example.invalid',
                  normalizedEmail: 'fixture@example.invalid',
                  emailReadiness: 'VALID',
                  permissionState: 'UNKNOWN',
                  source:
                    'Synthetic initial VALID test value — not a promotion or a human review of a real contact',
                  provenance: { synthetic: true, noHumanReview: true },
                  createdBy: actor.id,
                  updatedBy: actor.id,
                },
              })
              await tx.prospectSourceEvidence.create({
                data: {
                  id: ids.sourceId,
                  organizationId: ids.organizationId,
                  venueId: ids.venueId,
                  sourceType: 'CRM_SYNTHETIC_COMPONENT_FIXTURE_V1',
                  capturedValue: source,
                  sourceLabel:
                    'Existing immutable synthetic Composer source package; NOT public website evidence',
                  createdBy: actor.id,
                },
              })
            } else {
              assert.ok(existing.canonicalName.startsWith('SYNTHETIC '))
              const retained = await tx.prospectSourceEvidence.findUnique({
                where: { id: ids.sourceId },
              })
              assert.equal(salesHash(retained?.capturedValue), salesHash(source))
            }
            if (
              !(await tx.correspondenceProviderAccount.findUnique({ where: { id: ids.accountId } }))
            )
              await tx.correspondenceProviderAccount.create({
                data: {
                  id: ids.accountId,
                  provider: 'FAKE',
                  externalAccountId: prefix + 'MAILBOX-' + fixtureRevision,
                  mailboxAddress: `firstsend-${fixtureRevision}@example.invalid`,
                  displayName: 'SYNTHETIC foreground rehearsal, no external mail',
                  deliveryEnabled: false,
                  connectionStatus: 'DISCONNECTED',
                  capabilities: [],
                  dailySendCap: 10,
                  perDomainDailyCap: 10,
                  minimumDelaySeconds: 0,
                  jitterSeconds: 0,
                  createdBy: actor.id,
                  updatedBy: actor.id,
                },
              })
          },
          { isolationLevel: 'Serializable' },
        )
        check(
          true,
          'Synthetic identity/source retained through existing native owners; no original imports or contacts promoted',
        )
      }
      const account = await db.correspondenceProviderAccount.findUnique({
        where: { id: ids.accountId },
      })
      assert.ok(account)
      check(
        account.provider === 'FAKE' &&
          !account.deliveryEnabled &&
          account.connectionStatus === 'DISCONNECTED' &&
          !account.credentialReferenceId &&
          account.capabilities.length === 0,
        'Existing local database uses a disabled isolated FAKE account with no credentials/capabilities',
      )
      const { createFakeCorrespondenceProvider } =
        await import('../packages/api/src/correspondence/fake')
      const fake = createFakeCorrespondenceProvider({ now: () => new Date() })
      if (mode === 'boundaries') {
        const { firstSendFaultChecks } = await import('./crm-sales/first-send-fault-checks')
        receipt.faultChecks = await firstSendFaultChecks(actor, check)
      }
      if (mode === 'dispatch') {
        const outbox = await db.prospectSendOutbox.findFirst({
          where: {
            providerAccountId: ids.accountId,
            sendItem: { draft: { venueId: ids.venueId } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
        assert.ok(outbox)
        const worker = await import('../apps/workers/src/processors/send-prospect-outreach')
        worker._setProspectCorrespondenceProviderForTesting(fake)
        try {
          await worker.processSendProspectOutreachJob(
            { outboxId: outbox.id },
            { verifyNativeOrigin: verifyNativeOriginRuntime },
          )
          const after = await db.prospectSendOutbox.findUnique({
            where: { id: outbox.id },
            include: { sendItem: { include: { message: true } } },
          })
          assert.ok(after)
          check(
            after.status === 'SENT' &&
              after.sendItem.providerMessageId &&
              after.sendItem.message?.providerMessageId,
            'Existing foreground worker records actual FAKE provider IDs before claiming local acceptance',
          )
          const rows = await db.prospectEmailMessage.count({
            where: { sendItemId: after.sendItemId },
          })
          await worker.processSendProspectOutreachJob(
            { outboxId: outbox.id },
            { verifyNativeOrigin: verifyNativeOriginRuntime },
          )
          check(
            (await db.prospectEmailMessage.count({ where: { sendItemId: after.sendItemId } })) ===
              rows && fake.state.sent.length <= 1,
            'Duplicate worker invocation does not append a draft/message or send again',
          )
          const sent = fake.state.sent[0]
          receipt.dispatched = { outbox: after, frozenProviderRequests: fake.state.sent }
          if (sent?.inReplyTo)
            check(
              sent.providerThreadId &&
                sent.references.includes(sent.inReplyTo) &&
                after.sendItem.message?.inReplyTo === sent.inReplyTo,
              'Actual reply dispatch carries provider thread ID, In-Reply-To and References into canonical correspondence',
            )
        } finally {
          worker._setProspectCorrespondenceProviderForTesting(undefined)
        }
      }
      if (mode === 'receive' || mode === 'suppress') {
        const outbound = await db.prospectEmailMessage.findFirst({
          where: { venueId: ids.venueId, direction: 'OUTBOUND' },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        })
        assert.ok(outbound?.internetMessageId)
        const mapping = await db.prospectEmailThreadProvider.findUnique({
          where: {
            threadId_providerAccountId: {
              threadId: outbound.threadId,
              providerAccountId: ids.accountId,
            },
          },
        })
        assert.ok(mapping)
        const stamp = Date.now(),
          ref = (externalId: string) => ({
            provider: 'FAKE' as const,
            providerAccountId: account.id,
            mailboxId: account.externalAccountId,
            externalId,
          })
        const refMessage = ref(`SYN-firstsend-${mode}-${stamp}`)
        const { normalizeUntrustedCorrespondenceBody } =
          await import('../packages/api/src/correspondence/content-safety')
        const body =
          mode === 'suppress'
            ? 'Please do not contact us again.'
            : 'Could we start with just one room? How much setup time would that need from our staff?'
        fake.state.messages.set(refMessage.externalId, {
          message: refMessage,
          thread: ref(mapping.providerThreadId),
          rfcMessageId: `<syn-firstsend-${stamp}@example.invalid>`,
          inReplyTo: outbound.internetMessageId,
          references: [outbound.internetMessageId],
          from: [{ email: 'fixture@example.invalid' }],
          to: [{ email: account.mailboxAddress }],
          cc: [],
          bcc: [],
          subject: outbound.subject,
          internalDate: new Date(),
          direction: 'INBOUND',
          body: normalizeUntrustedCorrespondenceBody({ text: body }),
          attachments: [],
        })
        const { createInboundCorrespondenceService } =
          await import('../packages/api/src/correspondence/inbound-sync')
        const { createPrismaInboundCorrespondenceStore } =
          await import('../packages/api/src/correspondence/prisma-inbound-store')
        const service = createInboundCorrespondenceService({
          provider: fake,
          store: createPrismaInboundCorrespondenceStore({
            bodyPersistence: { mode: 'TEMPORARY', retentionDays: 1 },
          }),
        })
        const input = {
          mailbox: {
            provider: 'FAKE' as const,
            providerAccountId: account.id,
            mailboxId: account.externalAccountId,
            mailboxAddress: account.mailboxAddress,
            credentialRef: 'SYNTHETIC-NO-CREDENTIAL',
          },
          externalReceiptId: refMessage.externalId,
          message: refMessage,
        }
        const first = await service.receiveNotification(input),
          duplicate = await service.receiveNotification(input)
        check(
          first.state === 'PROCESSED' && duplicate.state === 'DUPLICATE',
          'Original inbound receipt owner associates the synthetic reply and deduplicates its notification',
        )
        const message = await db.prospectEmailMessage.findUnique({
          where: {
            providerAccountId_providerMessageId: {
              providerAccountId: account.id,
              providerMessageId: refMessage.externalId,
            },
          },
        })
        assert.ok(message)
        check(
          message.threadId === outbound.threadId &&
            message.venueId === ids.venueId &&
            message.textBody === body,
          'Inbound provider/RFC evidence returns to the SAME canonical thread and exact synthetic venue',
        )
        receipt.inbound = { first, duplicate, message }
        if (mode === 'suppress') {
          const { recordProspectSuppressionAction } =
            await import('../packages/db/src/helpers/prospect-contactability-actions')
          await recordProspectSuppressionAction({
            contactId: ids.contactId,
            eventType: 'UNSUBSCRIBED',
            source: 'INBOUND_MESSAGE',
            reasonCode: 'SYNTHETIC_EXPLICIT_OPT_OUT',
            reason: 'Explicit fictional opt-out in the isolated FAKE-provider acceptance case',
            provider: 'FAKE',
            evidence: { synthetic: true, messageId: message.id, body },
            actor: { type: 'SYSTEM', role: 'SYSTEM', id: actor.id },
          })
          check(
            (await getNativeSalesWorkflow(ids.venueId)).suppression.blocked,
            'Original suppression owner holds the synthetic prospect after explicit fictional opt-out; no restoration performed',
          )
        }
      }
      receipt.native = await readNativeSalesSnapshot(ids.venueId)
      receipt.component = await invokeSalesComponents({
        action: 'evaluate',
        native: receipt.native as Awaited<ReturnType<typeof readNativeSalesSnapshot>>,
      })
      receipt.view = await getNativeSalesWorkflow(ids.venueId)
      check(
        salesHash(await db.prospectDeliveryControl.findMany()) === controlHash,
        'Global delivery controls remain unchanged and dark',
      )
      check(
        salesHash(
          await db.correspondenceProviderAccount.findMany({
            where: { id: { not: ids.accountId } },
          }),
        ) === accountHash,
        'Every pre-existing non-rehearsal provider account remains unchanged',
      )
      check(networkAttempts.length === 0, 'No HTTP/Gmail network executor was called')
      const names = Object.entries(originals) as [string, { venueId: string; hash: string }][]
      for (const [name, before] of names) {
        const n = await readNativeSalesSnapshot(before.venueId)
        check(
          salesHash({
            venue: n.venue,
            organization: n.organization,
            contacts: n.contacts,
            imports: n.importRecords,
            originalSources: n.sources.filter(
              (s) => !s.sourceType.startsWith('CRM_NATIVE_SOURCE_SELECTION'),
            ),
          }) === before.hash,
          `Original ${name} contact/import/source identity is unchanged by the rehearsal`,
        )
      }
    })
    receipt.passed = true
  } catch (error) {
    receipt.passed = false
    receipt.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    receipt.completedAt = new Date().toISOString()
    await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' })
    await db.$disconnect()
    console.log(
      JSON.stringify({
        output,
        passed: receipt.passed,
        checks: checks.length,
        error: receipt.error,
        ids,
      }),
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
