import { launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import {
  requireCurrentProspectLaunchAttachments,
  requireSameLaunchAttachments,
  prospectOperationalContentHash,
} from './prospect-launch-attachments'
import { createHash } from 'node:crypto'
import {
  decodeSalesComponent,
  ProspectSalesError,
  readNativeSalesSnapshot,
  requireNativeSalesRouteClear,
  SALES_PREPARATION_SOURCE,
  salesHash,
  type NativeSalesSnapshot,
  type SalesTransaction,
} from './prospect-sales-snapshot'
import {
  nativeMeaningBinding,
  SALES_REVIEW_SCHEMA,
  MEANING_REVIEW_SCOPE,
} from './prospect-sales-meaning'
import type { ComponentOutput } from './prospect-sales-actions'

export const NATIVE_OPERATIONAL_ORIGIN = 'torchiko.native-operational-origin/1'
export const FIRST_SEND_SYNTHETIC_PREFIX = 'SYN-CRM-FIRSTSEND-'
// Owner-confirmed company identity, not a claim that OAuth or delivery is enabled.
export const NATIVE_COMPANY_MAILBOX = 'tomschoenekase@torchiko.com'
export function isIntendedNativeGmailAccount(account: {
  provider: string
  mailboxAddress: string
}) {
  return (
    account.provider === 'GMAIL' && account.mailboxAddress.toLowerCase() === NATIVE_COMPANY_MAILBOX
  )
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
function requireMatch(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new ProspectSalesError('CONFLICT', detail)
}
export function localFirstSendRehearsalEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  try {
    const u = new URL(env.DATABASE_URL ?? '')
    return (
      env.TORCHIKO_LOCAL_CRM_REHEARSAL === '1' &&
      env.TORCHIKO_LOCAL_CRM_SALES_ENABLED === '1' &&
      ['test', 'development'].includes(env.NODE_ENV ?? '') &&
      env.APP_ENV !== 'production' &&
      env.DEPLOYMENT_ENV !== 'production' &&
      u.hostname === '127.0.0.1' &&
      u.port === '58617' &&
      u.pathname === '/pathfinder_disposable_crm_research_20260919' &&
      !u.search &&
      !u.hash &&
      (!env.DIRECT_DATABASE_URL || env.DIRECT_DATABASE_URL === env.DATABASE_URL)
    )
  } catch {
    return false
  }
}
export type ProspectApprovalActor = { type: 'HUMAN' | 'SYSTEM'; id: string; role: 'PLATFORM_ADMIN' }
export function requireProspectApprovalActor(actor: ProspectApprovalActor) {
  requireMatch(
    actor.role === 'PLATFORM_ADMIN' &&
      actor.id.trim() &&
      (actor.type === 'HUMAN' ||
        (actor.type === 'SYSTEM' &&
          actor.id.startsWith('synthetic:crm-meaning:') &&
          localFirstSendRehearsalEnabled())),
    'APPROVAL_REQUIRED: authenticated human operator required; only isolated local SYSTEM rehearsals are separate',
  )
}
export function requireProspectApprovalScope(
  actor: ProspectApprovalActor,
  organizationIds: readonly string[],
) {
  requireProspectApprovalActor(actor)
  if (actor.type === 'SYSTEM')
    requireMatch(
      organizationIds.length > 0 &&
        organizationIds.every((id) => id.startsWith(FIRST_SEND_SYNTHETIC_PREFIX)),
      'SYNTHETIC_APPROVAL_SCOPE: a SYSTEM rehearsal cannot select or approve a real prospect',
    )
}
export function isLocalFakeDelivery(
  account: unknown,
  organizations: readonly string[],
  recipients: readonly string[],
) {
  const a = obj(account)
  return (
    localFirstSendRehearsalEnabled() &&
    a.provider === 'FAKE' &&
    typeof a.id === 'string' &&
    a.id.startsWith(FIRST_SEND_SYNTHETIC_PREFIX) &&
    typeof a.externalAccountId === 'string' &&
    a.externalAccountId.startsWith(FIRST_SEND_SYNTHETIC_PREFIX) &&
    typeof a.mailboxAddress === 'string' &&
    a.mailboxAddress.endsWith('@example.invalid') &&
    a.deliveryEnabled === false &&
    ['DISCONNECTED', 'DISABLED'].includes(String(a.connectionStatus)) &&
    !a.credentialReferenceId &&
    !a.pausedAt &&
    Array.isArray(a.capabilities) &&
    a.capabilities.length === 0 &&
    organizations.length > 0 &&
    organizations.every((id) => id.startsWith(FIRST_SEND_SYNTHETIC_PREFIX)) &&
    recipients.length > 0 &&
    recipients.every((email) => email.endsWith('@example.invalid'))
  )
}
export function nativeOriginAccountHash(account: unknown) {
  const a = obj(account)
  return salesHash({
    id: a.id,
    provider: a.provider,
    externalAccountId: a.externalAccountId,
    mailboxAddress: a.mailboxAddress,
    credentialReferenceId: a.credentialReferenceId ?? null,
  })
}
export type NativeOriginVerifier = (
  native: NativeSalesSnapshot,
  stored: ComponentOutput,
) => Promise<ComponentOutput>
/** Dispatch verifies the server-persisted preparation and CURRENT native business
 * state. Style/reference files are immutable writing provenance, not live send
 * authority: changing the voice corpus cannot silently rewrite approved bytes. */
export const verifyStoredNativeOrigin: NativeOriginVerifier = async (native, stored) => {
  const preparation = obj(stored.preparation)
  const reference = obj(stored.writingReference)
  const dueAt = preparation.businessFreshnessReviewDueAt
  const dueTime = typeof dueAt === 'string' ? Date.parse(dueAt) : NaN
  requireMatch(
    stored.schema === 'torchiko.native-sales-components/1' &&
      stored.SEND_AUTHORIZED === false &&
      stored.senderAvailable === false &&
      !stored.blocker &&
      stored.nativeSnapshotHash === native.snapshotHash &&
      obj(stored.gate).can_prepare === true &&
      Object.keys(obj(stored.componentCodeHashes)).length > 0 &&
      Object.keys(obj(preparation.fileSha256s)).length > 0 &&
      (dueAt === null ||
        (typeof dueAt === 'string' && Number.isFinite(dueTime) && Date.now() < dueTime)) &&
      dueAt !== undefined &&
      (!stored.writingReference ||
        (typeof reference.text === 'string' &&
          typeof reference.sha256 === 'string' &&
          createHash('sha256').update(reference.text, 'utf8').digest('hex') === reference.sha256)),
    'NATIVE_PREPARATION_INVALID: exact persisted source, current evidence window and writing provenance required',
  )
  return stored
}
export type NativeOperationalOrigin = {
  schema: typeof NATIVE_OPERATIONAL_ORIGIN
  draftId: string
  contentHash: string
  preparationId: string
  nativeSnapshotHash: string
  meaningReviewId: string
  meaningBindingHash: string
  componentCodeHash: string
  fileSetHash: string
  routeHash: string
  providerAccountId: string
  accountHash: string
  synthetic: boolean
  generatedBy: { type: string; id: string }
  reply: {
    threadId: string
    providerThreadId: string
    inReplyTo: string
    references: string[]
  } | null
}

/** All mutable business facts and review heads are reread from original owners.
 * The injected verifier validates immutable server-persisted preparation; absent
 * verification is a HOLD, never cached approval. No HTTP callback exists. */
export async function readEligibleNativeOrigin(
  input: {
    draftId: string
    contentHash: string
    meaningReviewId: string
    providerAccountId: string
  },
  tx: SalesTransaction,
  verify: NativeOriginVerifier | undefined,
) {
  requireMatch(
    verify,
    'NATIVE_RUNTIME_VERIFICATION_REQUIRED: trusted preparation verifier is not connected to this action',
  )
  const draft = await tx.prospectOutreachDraft.findUnique({ where: { id: input.draftId } })
  requireMatch(
    draft?.preparationKey &&
      draft.venueId &&
      draft.toEmail &&
      draft.contentHash === input.contentHash &&
      draft.status === 'NEEDS_REVIEW',
    'EXACT_NATIVE_ORIGIN_REQUIRED: permanently NO-SEND source must remain intact',
  )
  const grounding = obj(draft.groundingSnapshot)
  await requireCurrentProspectLaunchAttachments(
    draft.venueId,
    launchAttachmentsFromSnapshot(grounding),
    tx,
  )
  const native = await readNativeSalesSnapshot(draft.venueId, tx)
  requireMatch(
    !native.suppression.blocked && native.snapshotHash === grounding.nativeSnapshotHash,
    'STALE_NATIVE_ORIGIN: source, selection, contact or thread changed',
  )
  const [source, currentSource, head, meaning, latestMeaning, account] = await Promise.all([
    tx.prospectSourceEvidence.findUnique({ where: { id: String(grounding.preparationId) } }),
    tx.prospectSourceEvidence.findFirst({
      where: { venueId: draft.venueId, sourceType: SALES_PREPARATION_SOURCE },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    tx.prospectOutreachDraft.findFirst({
      where: { preparationKey: draft.preparationKey },
      orderBy: { version: 'desc' },
    }),
    tx.prospectActivity.findUnique({ where: { id: input.meaningReviewId } }),
    tx.prospectActivity.findFirst({
      where: {
        venueId: draft.venueId,
        AND: [
          { evidence: { path: ['schema'], equals: SALES_REVIEW_SCHEMA } },
          { evidence: { path: ['reviewScope'], equals: MEANING_REVIEW_SCOPE } },
          { evidence: { path: ['draftId'], equals: draft.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    tx.correspondenceProviderAccount.findUnique({ where: { id: input.providerAccountId } }),
  ])
  requireMatch(
    source?.id === currentSource?.id && source?.venueId === draft.venueId && head?.id === draft.id,
    'STALE_NATIVE_ORIGIN: original preparation or draft head has moved',
  )
  const stored = decodeSalesComponent(source!.capturedValue)
  requireSameLaunchAttachments(stored, grounding)
  const { bindingHash } = nativeMeaningBinding(draft, stored)
  const review = obj(meaning?.evidence)
  requireMatch(
    meaning?.id === latestMeaning?.id &&
      meaning?.venueId === draft.venueId &&
      review.reviewScope === MEANING_REVIEW_SCOPE &&
      review.draftId === draft.id &&
      review.contentHash === draft.contentHash &&
      review.bindingHash === bindingHash &&
      review.state === 'ASSESSED_NO_SEND',
    'MEANING_REVIEW_REQUIRED: current exact assessment missing, blocked or superseded',
  )
  const record = decodeSalesComponent(review.record),
    check = obj(record.check)
  requireMatch(
    check.status === 'ASSESSED_NO_SEND' &&
      check.SEND_AUTHORIZED === false &&
      check.humanApproval === 'ABSENT' &&
      Array.isArray(check.findings) &&
      check.findings.length === 0 &&
      Array.isArray(check.unresolvedHolds) &&
      check.unresolvedHolds.length === 0,
    'UNRESOLVED_MEANING_HOLDS: an assessment does not grant approval',
  )
  const component = await verify(native, stored)
  requireMatch(
    component.SEND_AUTHORIZED === false &&
      !component.blocker &&
      obj(component.gate).can_prepare === true &&
      component.nativeSnapshotHash === native.snapshotHash &&
      salesHash(component.componentCodeHashes) === salesHash(stored.componentCodeHashes) &&
      salesHash(obj(component.preparation).fileSha256s) ===
        salesHash(obj(stored.preparation).fileSha256s),
    'STALE_NATIVE_RUNTIME: current business source or persisted preparation integrity changed',
  )
  const route = obj(obj(stored.crosswalk).routing)
  await requireNativeSalesRouteClear(route, tx)
  const contact = native.contacts.find((c) => c.id === draft.contactId)
  requireMatch(
    contact &&
      contact.emailReadiness === 'VALID' &&
      contact.normalizedEmail === draft.toEmail &&
      route.kind === 'email' &&
      route.recipient === draft.toEmail,
    'CONTACT_READINESS_REQUIRED: UNKNOWN is not VALID; a form is not an email recipient',
  )
  requireMatch(
    account,
    'PROVIDER_ACCOUNT_REQUIRED: select an existing account; source presence is not connection',
  )
  const synthetic = obj(obj(stored.preparation).writerContext).synthetic === true
  requireMatch(
    synthetic
      ? isLocalFakeDelivery(account, [native.organization.id], [draft.toEmail])
      : isIntendedNativeGmailAccount(account),
    `PROVIDER_SCOPE_MISMATCH: synthetic rehearsals require their disabled FAKE account; native company messages require the selected ${NATIVE_COMPANY_MAILBOX} Gmail account. No account was connected or enabled.`,
  )
  let reply: NativeOperationalOrigin['reply'] = null
  const projection = obj(obj(stored.correspondence).projection)
  if (projection.thread_id) {
    const aliases = obj(obj(stored.crosswalk).correspondenceMessageIds)
    requireMatch(
      salesHash(aliases) === salesHash(obj(obj(component.crosswalk).correspondenceMessageIds)),
      'CORRESPONDENCE_IDENTITY_CROSSWALK_CHANGED',
    )
    const projectedId = projection.reply_to_message_id
    const nativeId =
      synthetic && typeof projectedId === 'string'
        ? (aliases[projectedId] ?? projectedId)
        : projectedId
    const thread = native.threads.find((t) => t.id === projection.thread_id)
    const inbound = thread?.messages.find((m) => m.id === nativeId)
    const mapping = thread?.providerMappings.find((m) => m.providerAccountId === account.id)
    requireMatch(
      thread &&
        inbound?.direction === 'INBOUND' &&
        inbound.internetMessageId &&
        mapping &&
        inbound.fromAddress.toLowerCase() === draft.toEmail.toLowerCase(),
      'REPLY_TARGET_REQUIRED: exact account, thread and RFC inbound identity are missing',
    )
    const references = [...new Set([...inbound.references, inbound.internetMessageId])]
    requireMatch(
      references.length <= 30 && references.every((r) => /^<[^<>\s\r\n]+>$/u.test(r)),
      'REPLY_REFERENCES_INVALID',
    )
    reply = {
      threadId: thread.id,
      providerThreadId: mapping.providerThreadId,
      inReplyTo: inbound.internetMessageId,
      references,
    }
  }
  const origin: NativeOperationalOrigin = {
    schema: NATIVE_OPERATIONAL_ORIGIN,
    draftId: draft.id,
    contentHash: draft.contentHash,
    preparationId: source!.id,
    nativeSnapshotHash: native.snapshotHash,
    meaningReviewId: meaning!.id,
    meaningBindingHash: bindingHash,
    componentCodeHash: salesHash(stored.componentCodeHashes),
    fileSetHash: salesHash(obj(stored.preparation).fileSha256s),
    routeHash: salesHash(route),
    providerAccountId: account.id,
    accountHash: nativeOriginAccountHash(account),
    synthetic,
    generatedBy: { type: draft.generatedByType, id: draft.generatedById },
    reply,
  }
  return { origin, draft, native, account, component }
}

export function operationalOrigin(value: unknown): NativeOperationalOrigin | null {
  const g = obj(value)
  if (!('nativeSalesOrigin' in g)) return null
  const origin = obj(g.nativeSalesOrigin)
  requireMatch(origin.schema === NATIVE_OPERATIONAL_ORIGIN, 'INVALID_NATIVE_OPERATIONAL_ORIGIN')
  return origin as unknown as NativeOperationalOrigin
}
export async function validateOperationalNativeOrigin(
  draft: {
    id: string
    organizationId: string
    venueId: string | null
    contactId: string | null
    preparationKey: string | null
    toEmail: string | null
    subject: string
    textBody: string
    htmlBody: string | null
    contentHash: string
    groundingSnapshot: unknown
  },
  tx: SalesTransaction,
  verify?: NativeOriginVerifier,
) {
  const origin = operationalOrigin(draft.groundingSnapshot)
  if (!origin) {
    if (launchAttachmentsFromSnapshot(draft.groundingSnapshot).length)
      throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_NATIVE_ORIGIN_REQUIRED')
    return null
  }
  requireMatch(!draft.preparationKey, 'A NO-SEND source cannot be approved in place')
  const current = await readEligibleNativeOrigin(origin, tx, verify)
  requireSameLaunchAttachments(current.draft.groundingSnapshot, draft.groundingSnapshot)
  requireMatch(
    salesHash(origin) === salesHash(current.origin) &&
      current.draft.organizationId === draft.organizationId &&
      current.draft.venueId === draft.venueId &&
      current.draft.contactId === draft.contactId &&
      current.draft.toEmail === draft.toEmail &&
      current.draft.subject === draft.subject &&
      current.draft.textBody === draft.textBody &&
      !draft.htmlBody,
    'NATIVE_HANDOFF_CHANGED: exact reviewed source/content/recipient/account must remain bound',
  )
  requireMatch(
    prospectOperationalContentHash(
      draft.toEmail!,
      draft.subject,
      draft.textBody,
      '',
      draft.groundingSnapshot,
    ) === draft.contentHash,
    'OPERATIONAL_CONTENT_HASH_MISMATCH',
  )
  return origin
}
