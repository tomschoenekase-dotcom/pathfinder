import { launchAttachmentsFromSnapshot, launchAttachmentsSha256 } from '@pathfinder/contracts/venue-launch-asset-node'
import { requireSameLaunchAttachments } from './prospect-launch-attachments'
import type { Prisma, ProspectOutreachDraft } from '@prisma/client'
import { db } from '../client'
import {
  decodeSalesComponent,
  encodeSalesComponent,
  ProspectSalesError,
  readNativeSalesSnapshot,
  requireNativeSalesRouteClear,
  SALES_PREPARATION_SOURCE,
  salesHash,
  type SalesClient,
  type SalesTransaction,
} from './prospect-sales-snapshot'
import {
  requireSalesOperator,
  requireCurrentTemporaryReply,
  TEMPORARY_REPLY_RECIPE,
  type ComponentOutput,
  type SalesActor,
} from './prospect-sales-actions'

export const SALES_REVIEW_SCHEMA = 'torchiko.native-sales-review/1'
export const MEANING_REVIEW_SCOPE = 'CLAIM_MEANING_ASSESSMENT_NOT_APPROVAL'
export const READ_REVIEW_SCOPE = 'OPERATOR_READ_REVIEW_NOT_COMPOSER_SEMANTIC_CERTIFICATION'
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const requireMatch = (condition: unknown, message: string) => {
  if (!condition) throw new ProspectSalesError('CONFLICT', message)
}

/** A temporary Gmail source is available for the live assessment but its
 * evidence quotations cannot be copied into the permanent activity record. */
export function compactTemporaryMeaningCheck(check: Record<string, unknown>) {
  return {
    schema: check.schema,
    status: check.status,
    SEND_AUTHORIZED: false,
    humanApproval: 'ABSENT',
    semanticCertification: false,
    reviewer: check.reviewer,
    bindingHash: check.bindingHash,
    draftId: check.draftId,
    contentHash: check.contentHash,
    preparationId: check.preparationId,
    submissionSha256: check.submissionSha256,
    composerDraftSha256: check.composerDraftSha256,
    composerPreparationId: check.composerPreparationId,
    annotations: [],
    findings: (check.findings as unknown[]).map((value) => ({
      code: /^[A-Z][A-Z0-9_]{0,80}$/u.test(String(obj(value).code))
        ? String(obj(value).code) : 'SOURCE_FINDING',
      detail: 'Review the current canonical message source while retained',
    })),
    unresolvedHolds: (check.unresolvedHolds as unknown[]).map((value) =>
      `SOURCE_HOLD_${salesHash(value).slice(0, 12)}`),
    operationalHolds: Array.isArray(check.operationalHolds)
      ? check.operationalHolds.map((value: unknown) =>
          `SOURCE_HOLD_${salesHash(value).slice(0, 12)}`) : [],
    claimEvidence: [],
  }
}

/** Native lifecycle binding; this does not evaluate the meaning of prose. */
export type NativeMeaningDraft = Pick<
  ProspectOutreachDraft,
  | 'id'
  | 'version'
  | 'preparationKey'
  | 'organizationId'
  | 'venueId'
  | 'contactId'
  | 'toEmail'
  | 'subject'
  | 'textBody'
  | 'contentHash'
  | 'groundingSnapshot'
>

export function nativeMeaningBinding(draft: NativeMeaningDraft, source: ComponentOutput) {
  const grounding = obj(draft.groundingSnapshot)
  const launchAttachments = launchAttachmentsFromSnapshot(grounding)
  requireSameLaunchAttachments(grounding, source)
  const crosswalk = obj(grounding.crosswalk),
    route = obj(crosswalk.routing)
  const preparation = obj(source.preparation),
    context = obj(preparation.writerContext)
  const correspondence = obj(source.correspondence),
    projection = obj(correspondence.projection)
  requireMatch(
    draft.preparationKey &&
      grounding.schema === 'torchiko.native-sales-draft/1' &&
      grounding.SEND_AUTHORIZED === false &&
      source.SEND_AUTHORIZED === false &&
      source.senderAvailable === false,
    'A native immutable no-send draft and exact preparation are required',
  )
  requireMatch(
    salesHash({
      series: draft.preparationKey,
      subject: draft.subject,
      body: draft.textBody,
      preparationId: grounding.preparationId,
      route,
      nativeSnapshotHash: grounding.nativeSnapshotHash,
      ...(launchAttachments.length ? { launchAttachmentsSha256: launchAttachmentsSha256(launchAttachments) } : {}),
    }) === draft.contentHash,
    'Native draft content/recipient/preparation binding is inconsistent',
  )
  requireMatch(
    source.nativeSnapshotHash === grounding.nativeSnapshotHash &&
      salesHash(preparation.fileSha256s) === salesHash(grounding.componentFileSha256s) &&
      salesHash(context.approved_language_snapshot) ===
        salesHash(grounding.approvedLanguageSnapshot) &&
      salesHash(obj(source.crosswalk).routing) === salesHash(route),
    'Native draft source binding is inconsistent',
  )
  requireMatch(
    draft.toEmail === (route.kind === 'email' ? route.recipient : null) &&
      draft.contactId === (crosswalk.nativeContactId ?? null),
    'Native recipient bytes no longer match the prepared route',
  )
  const binding = {
    schema: 'torchiko.native-meaning-binding/1',
    draftId: draft.id,
    version: draft.version,
    contentHash: draft.contentHash,
    preparationKey: draft.preparationKey,
    preparationId: grounding.preparationId,
    organizationId: draft.organizationId,
    venueId: draft.venueId,
    contactId: draft.contactId,
    subject: draft.subject,
    body: draft.textBody,
    recipient: draft.toEmail,
    route,
    nativeSnapshotHash: grounding.nativeSnapshotHash,
    preparationComponentSha256: salesHash(source),
    preparationFileSha256s: preparation.fileSha256s,
    componentCodeHashes: source.componentCodeHashes,
    composerPreparationId: obj(preparation.metadata).preparation_id,
    composerDraftSha256: grounding.composerDraftSha256,
    bodySha256: grounding.WLTBodySha256,
    researchSnapshotSha256: context.research_snapshot,
    writerContextSha256: context.writer_context_sha256,
    WLT_packet_identity: context.WLT_packet_identity,
    approvedLanguageSnapshot: context.approved_language_snapshot,
    thread: {
      id: projection.thread_id ?? null,
      snapshotSha256: projection.snapshot_sha256 ?? null,
      replyToMessageId: projection.reply_to_message_id ?? null,
      latestInbound: obj(context.relationship).latest_message ?? null,
      providerSnapshotSha256: salesHash(correspondence.snapshot ?? null),
    },
    SEND_AUTHORIZED: false,
  }
  return { binding, bindingHash: salesHash(binding) }
}

/** Append to the existing trigger-protected activity log. No review database or approval table. */
export type NativeMeaningReviewInput = {
  venueId: string
  draftId: string
  contentHash: string
  expectedSnapshotHash: string
  expectedBindingHash: string
  expectedMeaningReviewId: string | null
  submission: Record<string, unknown>
  component: ComponentOutput
  actor: SalesActor
}

export async function recordNativeMeaningReview(
  input: NativeMeaningReviewInput,
  client: SalesClient = db,
) {
  requireSalesOperator(input.actor)
  try {
    return await client.$transaction((tx) => recordNativeMeaningReviewInTransaction(input, tx), {
      isolationLevel: 'Serializable',
      timeout: 15_000,
    })
  } catch (error) {
    if (obj(error).code === 'P2034')
      throw new ProspectSalesError(
        'CONFLICT',
        'CONCURRENT_MEANING_REVIEW: another transaction changed this snapshot; reload',
      )
    throw error
  }
}

/** Same append-only meaning owner, composable with an immutable draft transaction. */
export async function recordNativeMeaningReviewInTransaction(
  input: NativeMeaningReviewInput,
  tx: SalesTransaction,
) {
  requireSalesOperator(input.actor)
  const reviewer = obj(input.submission.reviewer)
  if (
    reviewer.kind === 'human' &&
    (input.actor.type !== 'HUMAN' || reviewer.identity !== input.actor.id)
  )
    throw new ProspectSalesError(
      'FORBIDDEN',
      'Human reviewer attribution must match the authenticated operator, never a synthetic/model action',
    )
  const native = await readNativeSalesSnapshot(input.venueId, tx)
  requireMatch(
    native.snapshotHash === input.expectedSnapshotHash,
    'STALE_NATIVE_SNAPSHOT: source, contact or inbound evidence changed',
  )
  if (native.suppression.blocked)
    throw new ProspectSalesError(
      'SUPPRESSED',
      'Native suppression holds meaning review progression',
    )
  const draft = await tx.prospectOutreachDraft.findUnique({ where: { id: input.draftId } })
  requireMatch(
    draft?.venueId === input.venueId &&
      draft?.contentHash === input.contentHash &&
      draft?.preparationKey,
    'Meaning review requires the exact native draft identity and hash',
  )
  const exact = draft!
  const latest = await tx.prospectOutreachDraft.findFirst({
    where: { preparationKey: exact.preparationKey },
    orderBy: { version: 'desc' },
  })
  requireMatch(latest?.id === exact.id, 'STALE_REVIEW: a newer draft revision exists')
  const grounding = obj(exact.groundingSnapshot)
  const source = await tx.prospectSourceEvidence.findUnique({
    where: { id: String(grounding.preparationId) },
  })
  requireMatch(
    source?.venueId === input.venueId && source?.sourceType === SALES_PREPARATION_SOURCE,
    'Draft preparation is unavailable',
  )
  const stored = decodeSalesComponent(source!.capturedValue)
  requireCurrentTemporaryReply(stored, input.component)
  const selectedSource = await tx.prospectSourceEvidence.findFirst({
    where: { venueId: input.venueId, sourceType: SALES_PREPARATION_SOURCE },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  requireMatch(
    selectedSource?.id === source!.id,
    'STALE_PREPARATION: newer source/direction must be bound to a new draft before assessment',
  )
  requireMatch(
    stored.nativeSnapshotHash === native.snapshotHash &&
      input.component.nativeSnapshotHash === native.snapshotHash &&
      salesHash(stored.componentCodeHashes) === salesHash(input.component.componentCodeHashes) &&
      salesHash(obj(stored.preparation).fileSha256s) ===
        salesHash(obj(input.component.preparation).fileSha256s),
    'STALE_MEANING_REVIEW: component, source, WLT or language revision changed',
  )
  await requireNativeSalesRouteClear(obj(stored.crosswalk).routing, tx)
  const { binding, bindingHash } = nativeMeaningBinding(exact, stored)
  requireMatch(
    bindingHash === input.expectedBindingHash,
    'STALE_MEANING_BINDING: inspect this exact draft and evidence again',
  )
  const check = obj(input.component.meaningCheck)
  const submission = input.submission
  requireMatch(
    submission.bindingHash === bindingHash &&
      submission.draftId === exact.id &&
      submission.contentHash === exact.contentHash &&
      submission.preparationId === source!.id &&
      check.bindingHash === bindingHash &&
      check.draftId === exact.id &&
      check.contentHash === exact.contentHash &&
      check.preparationId === source!.id &&
      check.submissionSha256 === salesHash(submission) &&
      check.composerDraftSha256 === grounding.composerDraftSha256 &&
      check.composerPreparationId === obj(obj(stored.preparation).metadata).preparation_id,
    'Meaning receipt does not bind the exact submission, draft and source identities',
  )
  requireMatch(
    check.schema === 'torchiko.native-composer-meaning/1' &&
      check.SEND_AUTHORIZED === false &&
      check.semanticCertification === false &&
      check.humanApproval === 'ABSENT' &&
      input.component.SEND_AUTHORIZED === false &&
      input.component.senderAvailable === false &&
      ['BLOCKED', 'ASSESSED_NO_SEND'].includes(String(check.status)) &&
      Array.isArray(check.findings) &&
      Array.isArray(check.unresolvedHolds) &&
      (check.status !== 'ASSESSED_NO_SEND' ||
        (check.findings.length === 0 && check.unresolvedHolds.length === 0)),
    'Invalid or authority-bearing meaning assessment refused',
  )
  const recordedBy = {
    type: input.actor.type,
    id: input.actor.id,
    synthetic: input.actor.type === 'SYSTEM',
  }
  const id =
    'sales-meaning_' +
    salesHash({
      bindingHash,
      submission,
      recordedBy,
      previousReviewId: input.expectedMeaningReviewId,
    }).slice(0, 40)
  const existing = await tx.prospectActivity.findUnique({ where: { id } })
  if (existing) return existing
  const previous = await tx.prospectActivity.findFirst({
    where: {
      venueId: input.venueId,
      AND: [
        { evidence: { path: ['schema'], equals: SALES_REVIEW_SCHEMA } },
        { evidence: { path: ['reviewScope'], equals: MEANING_REVIEW_SCOPE } },
        { evidence: { path: ['draftId'], equals: exact.id } },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  requireMatch(
    (previous?.id ?? null) === input.expectedMeaningReviewId,
    'CONCURRENT_MEANING_REVIEW: newer findings exist; reload before recording',
  )
  return tx.prospectActivity.create({
    data: {
      id,
      organizationId: exact.organizationId,
      venueId: input.venueId,
      contactId: exact.contactId,
      type: 'NOTE_ADDED',
      summary:
        check.status === 'BLOCKED'
          ? 'Claim/meaning findings recorded with unresolved holds — NO SEND'
          : 'Attributed claim/meaning assessment recorded — NO SEND; not semantic proof or approval',
      evidence: {
        schema: SALES_REVIEW_SCHEMA,
        reviewScope: MEANING_REVIEW_SCOPE,
        draftId: exact.id,
        contentHash: exact.contentHash,
        version: exact.version,
        bindingHash,
        nativeSnapshotHash: native.snapshotHash,
        state: check.status,
        previousReviewId: previous?.id ?? null,
        recordedBy,
        record: encodeSalesComponent({
          binding, submission,
          check: obj(stored.retentionRecipe).schema === TEMPORARY_REPLY_RECIPE
            ? compactTemporaryMeaningCheck(check)
            : check,
          SEND_AUTHORIZED: false,
        }),
        humanApproval: 'ABSENT',
        semanticCertification: false,
        SEND_AUTHORIZED: false,
      } as Prisma.InputJsonValue,
      actorId: input.actor.id,
    },
  })
}
