/** Fictional fixtures only: the entire local DB is the closed provider source under test.
 * This helper is never an attestation about an external mailbox or a real account.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  db,
  planProspectOutreachEvidence,
  recordProspectOutreachEvidenceAction,
} from '@pathfinder/db'
const actor = { type: 'HUMAN' as const, id: 'user_owner', role: 'PLATFORM_ADMIN' as const }
export async function reviewEmptyFictionalOutreachHistory(organizationId: string) {
  const target = new URL(process.env.DATABASE_URL ?? '')
  if (
    process.env.RUN_OPERATOR_DB_INTEGRATION !== '1' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !/^\/pathfinder_disposable_[a-z0-9_]+$/u.test(target.pathname)
  )
    throw new Error('Fictional completeness requires explicit local disposable integration target')
  const stamp = new Date()
  await db.correspondenceProviderAccount.upsert({
    where: { id: 'fictional-outreach-complete-fixture' },
    create: {
      id: 'fictional-outreach-complete-fixture',
      provider: 'GMAIL',
      externalAccountId: 'fictional-outreach-complete-fixture',
      mailboxAddress: 'fictional-history-source@example.test',
      capabilities: ['RECEIVE'],
      connectionStatus: 'CONNECTED',
      lastSuccessfulSyncAt: stamp,
      deliveryEnabled: false,
      createdBy: 'disposable-test',
      updatedBy: 'disposable-test',
    },
    update: {
      lastSuccessfulSyncAt: stamp,
      connectionStatus: 'CONNECTED',
      capabilities: ['RECEIVE'],
      deliveryEnabled: false,
    },
  })
  // Never repair or relabel another suite's provider state to make this gate pass.
  const otherMailboxes = await db.correspondenceProviderAccount.findMany({
    where: {
      provider: 'GMAIL',
      capabilities: { has: 'RECEIVE' },
      id: { not: 'fictional-outreach-complete-fixture' },
    },
    select: { connectionStatus: true, lastSuccessfulSyncAt: true },
  })
  if (
    otherMailboxes.some(
      (m) =>
        m.connectionStatus !== 'CONNECTED' ||
        !m.lastSuccessfulSyncAt ||
        stamp.getTime() - m.lastSuccessfulSyncAt.getTime() > 5 * 60_000 ||
        m.lastSuccessfulSyncAt > stamp,
    )
  )
    throw new Error(
      'Unrelated RECEIVE fixture is disconnected or stale; its owning suite must clean up its own state',
    )
  const plan = await planProspectOutreachEvidence(db, organizationId)
  if (plan.messages.length !== 0)
    throw new Error('Empty-history fixture cannot cover existing provider messages')
  const throughAt = new Date().toISOString()
  const receipt = {
    kind: 'fictional-native-disposable-full-source-read',
    organizationIds: plan.organizationIds,
    contactIds: plan.contactIds,
    messages: [],
    mailboxIds: plan.mailboxes.map((m) => m.id),
  }
  const receiptHash = createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
  await recordProspectOutreachEvidenceAction({
    organizationId,
    operationId: randomUUID(),
    actor,
    evidence: {
      schema: 'prospect-outreach-history/v1',
      kind: 'complete',
      reviewerId: actor.id,
      reason:
        'Reviewed the complete closed fictional source fixture; no external mailbox or real account claim',
      historyFingerprint: plan.historyFingerprint,
      organizationIds: plan.organizationIds,
      contactIds: plan.contactIds,
      mailboxIds: plan.mailboxes.map((m) => m.id),
      coverage: plan.mailboxes.map((m) => ({
        providerAccountId: m.id,
        mailboxAddress: m.mailboxAddress,
        searchedAt: throughAt,
        throughAt,
        query: `fictional native DB full provider-source scan for ${organizationId}; no messages`,
        sourceReceiptId: `fictional-disposable:${organizationId}:${receiptHash}`,
        resultFingerprint: receiptHash,
        complete: true,
      })),
    },
  })
  return (await planProspectOutreachEvidence(db, organizationId)).projection
}

export async function closeFictionalOutreachHistorySource() {
  await db.correspondenceProviderAccount.updateMany({
    where: {
      id: 'fictional-outreach-complete-fixture',
      createdBy: 'disposable-test',
      mailboxAddress: 'fictional-history-source@example.test',
    },
    data: {
      capabilities: [],
      connectionStatus: 'DISCONNECTED',
      lastSuccessfulSyncAt: null,
      deliveryEnabled: false,
    },
  })
}
