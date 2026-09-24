import {
  db,
  ProspectSalesError,
  requireSalesOperator,
  NATIVE_HANDOFF_SCHEMA,
  operationalOrigin,
  localFirstSendRehearsalEnabled,
  FIRST_SEND_SYNTHETIC_PREFIX,
  validateOperationalNativeOrigin,
  createNativeOperationalCandidate,
  reviewProspectOutreachDraftAction,
  stageProspectSendBatchAction,
  approveProspectSendBatchAction,
  releaseProspectSendBatchAction,
  type SalesActor,
  type NativeOriginVerifier,
} from '@pathfinder/db'
import type { FirstSendAction, NativeOperationalView } from './prospect-first-send-contract'
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** Called inside the existing platform/local sales boundary, not a new route. */
export async function readNativeOperationalView(
  venueId: string,
  verify: NativeOriginVerifier,
): Promise<NativeOperationalView> {
  const [accounts, receipt, messages] = await Promise.all([
    db.correspondenceProviderAccount.findMany({
      where: {
        OR: [
          { provider: 'GMAIL' },
          { id: { startsWith: FIRST_SEND_SYNTHETIC_PREFIX }, provider: 'FAKE' },
        ],
      },
      orderBy: { id: 'asc' },
      take: 30,
      select: {
        id: true,
        provider: true,
        mailboxAddress: true,
        connectionStatus: true,
        deliveryEnabled: true,
      },
    }),
    db.prospectActivity.findFirst({
      where: { venueId, evidence: { path: ['schema'], equals: NATIVE_HANDOFF_SCHEMA } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    db.prospectEmailMessage.findMany({
      where: { venueId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 12,
      select: {
        id: true,
        threadId: true,
        direction: true,
        providerMessageId: true,
        subject: true,
        bodyPreview: true,
        sourceReference: true,
      },
    }),
  ])
  const draftId = obj(receipt?.evidence).operationalDraftId
  const draft =
    typeof draftId === 'string'
      ? await db.prospectOutreachDraft.findUnique({
          where: { id: draftId },
          include: {
            sendItems: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              include: { batch: true, outbox: true },
            },
          },
        })
      : null
  const origin = draft ? operationalOrigin(draft.groundingSnapshot) : null
  let staleReason: string | null = null
  if (draft && !['SENT', 'SUPERSEDED'].includes(draft.status)) {
    try {
      await db.$transaction((tx) => validateOperationalNativeOrigin(draft, tx, verify), {
        timeout: 20_000,
      })
    } catch (error) {
      staleReason =
        error instanceof Error ? error.message : 'Native source or assessment unavailable'
    }
  }
  const item = draft?.sendItems[0]
  return {
    rehearsal: localFirstSendRehearsalEnabled() && venueId.startsWith(FIRST_SEND_SYNTHETIC_PREFIX),
    liveSendAvailable: false,
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      mailbox: a.mailboxAddress,
      connected: a.connectionStatus === 'CONNECTED',
      deliveryEnabled: a.deliveryEnabled,
    })),
    candidate:
      draft && origin && draft.venueId === venueId
        ? {
            id: draft.id,
            campaignId: draft.campaignId!,
            status: draft.status,
            contentHash: draft.contentHash,
            recipient: draft.toEmail!,
            subject: draft.subject,
            body: draft.textBody,
            generatedBy: draft.generatedById,
            generatedByKind: draft.generatedByType,
            approvedBy: draft.approvedBy,
            sourceDraftId: origin.draftId,
            meaningReviewId: origin.meaningReviewId,
            providerAccountId: origin.providerAccountId,
            staleReason,
            escalationFlags: draft.escalationFlags,
            synthetic: origin.synthetic,
            batch: item
              ? {
                  id: item.batchId,
                  status: item.batch.status,
                  count: item.batch.recipientCount,
                  hash: item.batch.snapshotHash,
                  outboxId: item.outbox?.id ?? null,
                  deliveryState: item.outbox?.status ?? item.status,
                  providerMessageId: item.providerMessageId,
                  error: item.lastErrorCode ?? item.outbox?.lastErrorCode ?? null,
                }
              : null,
          }
        : null,
    correspondence: messages.map((m) => ({ ...m, preview: m.bodyPreview })),
  }
}

export async function applyNativeOperationalAction(
  action: FirstSendAction,
  actor: SalesActor,
  verify: NativeOriginVerifier,
) {
  requireSalesOperator(actor)
  const input = action.input
  if (action.action === 'handoffOperational')
    return createNativeOperationalCandidate({ ...action.input, actor }, verify)
  const field = 'draftId' in input ? input.draftId : null
  const candidate = field
    ? await db.prospectOutreachDraft.findUnique({ where: { id: field } })
    : null
  if (
    field &&
    (!candidate ||
      candidate.venueId !== input.venueId ||
      !operationalOrigin(candidate.groundingSnapshot))
  )
    throw new ProspectSalesError('CONFLICT', 'Exact native-origin operational candidate required')
  if (action.action === 'reviewOperational')
    return reviewProspectOutreachDraftAction(
      { ...action.input, approve: true, actor },
      undefined,
      verify,
    )
  if (action.action === 'stageOperational') {
    if (candidate?.campaignId !== action.input.campaignId)
      throw new ProspectSalesError('CONFLICT', 'Candidate campaign identity changed')
    return stageProspectSendBatchAction(
      {
        campaignId: action.input.campaignId,
        draftIds: [action.input.draftId],
        expectedContentHashes: { [action.input.draftId]: action.input.expectedContentHash },
        actor,
      },
      undefined,
      verify,
    )
  }
  const batchInput = action.input
  if (!('batchId' in batchInput)) throw new ProspectSalesError('INVALID_INPUT', 'Batch required')
  const batch = await db.prospectSendBatch.findUnique({
    where: { id: batchInput.batchId },
    include: { items: { include: { draft: true } } },
  })
  if (
    !batch ||
    batch.items.length !== 1 ||
    batch.items.some(
      (item) =>
        item.draft.venueId !== batchInput.venueId ||
        !operationalOrigin(item.draft.groundingSnapshot),
    )
  )
    throw new ProspectSalesError('CONFLICT', 'Exact one-prospect native-origin batch required')
  const common = {
    batchId: batchInput.batchId,
    expectedRecipientCount: batchInput.expectedRecipientCount,
    expectedSnapshotHash: batchInput.expectedBatchHash,
    actor,
  }
  if (action.action === 'approveOperationalBatch')
    return approveProspectSendBatchAction(common, undefined, verify)
  if (
    !localFirstSendRehearsalEnabled() ||
    !batchInput.venueId.startsWith(FIRST_SEND_SYNTHETIC_PREFIX)
  )
    throw new ProspectSalesError(
      'FORBIDDEN',
      'This local interface never releases a live queue. Only an isolated synthetic FAKE rehearsal is available here.',
    )
  return releaseProspectSendBatchAction(
    { ...common, providerAccountId: action.input.providerAccountId },
    undefined,
    verify,
  )
}
