import {
  launchAttachmentsFromSnapshot,
  launchAttachmentsSha256,
} from '@pathfinder/contracts/venue-launch-asset-node'
import {
  venueLaunchAssetDescriptor,
  type VenueLaunchAssetDescriptor,
} from '@pathfinder/contracts/venue-launch-asset'
import {
  requireCurrentProspectLaunchAttachments,
  type ProspectLaunchReadClient,
} from './prospect-launch-attachments'
import type { Prisma } from '@prisma/client'
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
} from './prospect-sales-snapshot'
import {
  requireSalesOperator,
  requireCurrentTemporaryReply,
  TEMPORARY_REPLY_RECIPE,
  saveNativeSalesDraftInTransaction,
  type ComponentOutput,
  type SalesActor,
} from './prospect-sales-actions'
import {
  nativeMeaningBinding,
  recordNativeMeaningReviewInTransaction,
  SALES_REVIEW_SCHEMA,
  MEANING_REVIEW_SCOPE,
  READ_REVIEW_SCOPE,
} from './prospect-sales-meaning'
import {
  assertIssuedNativeSalesWriterAgent,
  revalidateNativeSalesWriterAgent,
} from './prospect-native-writer-agent'

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const text = (v: unknown) => (typeof v === 'string' ? v : null)
const requireMatch = (v: unknown, why: string) => {
  if (!v) throw new ProspectSalesError('CONFLICT', why)
}
export const WRITER_IMPORT_SCHEMA = 'torchiko.native-writer-import/1'
export type WriterBinding = {
  launchAttachmentsSha256?: string | undefined
  venueId: string
  organizationId: string
  preparationId: string
  nativeSnapshotHash: string
  preparationHash: string
  componentCodeHash: string
  fileSetHash: string
  selectionId: string | null
  routeHash: string
  routeKind: string
  recipient: string | null
  formUrl: string | null
  threadHash: string
  libraryHash: string
  wltHash: string
  expectedDraftId: string | null
  expectedVenueDraftId: string | null
  expectedMeaningReviewId: string | null
  expectedReadReviewId: string | null
}
export type NativeWriterResult = {
  schema: 'torchiko.native-writer-result/1'
  taskId: string
  binding: WriterBinding
  generatedBy: { kind: 'model'; identity: string }
  subject: string
  body: string
  annotations: unknown[]
  languageUses: unknown[]
  assessment: {
    reviewer: { kind: 'model'; identity: string }
    assessments: unknown[]
    answers: unknown[]
    unsupportedClaims: string[]
  } | null
}
export type NativeWriterTask = {
  schema: 'torchiko.native-writer-task/1'
  taskId: string
  binding: WriterBinding
  notice: string
  writerMarkdown: string
  writerContext: Record<string, unknown>
  resultInstructions: string
  writingReference?: Record<string, unknown>
  launchAttachments?: VenueLaunchAssetDescriptor[]
  SEND_AUTHORIZED: false
}
type ReadClient = Pick<
  SalesClient,
  | 'prospectSourceEvidence'
  | 'prospectOutreachDraft'
  | 'prospectActivity'
  | 'prospectVenue'
  | 'prospectContact'
  | 'prospectImportSourceRecord'
> &
  ProspectLaunchReadClient

/** Current persisted preparation only. Export is read-only and does not prepare,
 * refresh evidence, mark anything read, or grant a writer execution capability. */
export async function readNativeWriterTask(
  venueId: string,
  current: ComponentOutput,
  client: ReadClient = db,
) {
  const native = await readNativeSalesSnapshot(venueId, client)
  const source = await client.prospectSourceEvidence.findFirst({
    where: { venueId, sourceType: SALES_PREPARATION_SOURCE },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  requireMatch(source, 'WRITER_PREPARATION_REQUIRED: persist current writing context first')
  const stored = decodeSalesComponent(source!.capturedValue)
  const launchAttachments = await requireCurrentProspectLaunchAttachments(
    venueId,
    launchAttachmentsFromSnapshot(stored),
    client,
  )
  requireCurrentTemporaryReply(stored, current)
  const preparation = obj(stored.preparation),
    context = obj(preparation.writerContext)
  const transient =
    obj(stored.retentionRecipe).schema === TEMPORARY_REPLY_RECIPE
      ? obj(current.preparation)
      : preparation
  const crosswalk = obj(stored.crosswalk),
    route = obj(crosswalk.routing)
  requireMatch(
    !native.suppression.blocked &&
      !current.blocker &&
      obj(current.gate).can_prepare === true &&
      current.SEND_AUTHORIZED === false &&
      native.snapshotHash === stored.nativeSnapshotHash &&
      current.nativeSnapshotHash === native.snapshotHash &&
      salesHash(current.componentCodeHashes) === salesHash(stored.componentCodeHashes),
    'STALE_WRITER_TASK: evidence, source selection, thread or component/library changed; prepare explicitly',
  )
  await requireNativeSalesRouteClear(route, client)
  const projection = obj(obj(stored.correspondence).projection)
  const series = salesHash({
    venueId,
    routingId: route.routing_id,
    mode: obj(preparation.request).mode,
    threadId: projection.thread_id ?? null,
    latestInboundId: projection.reply_to_message_id ?? null,
  })
  const [seriesHead, venueHead] = await Promise.all([
    client.prospectOutreachDraft.findFirst({
      where: { preparationKey: series },
      orderBy: { version: 'desc' },
    }),
    client.prospectOutreachDraft.findFirst({
      where: { venueId, preparationKey: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  ])
  const head = async (scope: string) =>
    venueHead
      ? client.prospectActivity.findFirst({
          where: {
            venueId,
            AND: [
              { evidence: { path: ['schema'], equals: SALES_REVIEW_SCHEMA } },
              { evidence: { path: ['reviewScope'], equals: scope } },
              { evidence: { path: ['draftId'], equals: venueHead.id } },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : null
  const [meaning, read] = await Promise.all([head(MEANING_REVIEW_SCOPE), head(READ_REVIEW_SCOPE)])
  const binding: WriterBinding = {
    ...(launchAttachments.length
      ? { launchAttachmentsSha256: launchAttachmentsSha256(launchAttachments) }
      : {}),
    venueId,
    organizationId: native.organization.id,
    preparationId: source!.id,
    nativeSnapshotHash: native.snapshotHash,
    preparationHash: salesHash(stored),
    componentCodeHash: salesHash(stored.componentCodeHashes),
    fileSetHash: salesHash(preparation.fileSha256s),
    selectionId: text(crosswalk.nativeSelectionId),
    routeHash: salesHash(route),
    routeKind: String(route.kind),
    recipient: text(route.recipient),
    formUrl: route.kind === 'contact_form' ? text(route.url) : null,
    threadHash: salesHash({ projection, relationship: context.relationship }),
    libraryHash: salesHash(context.approved_language_snapshot),
    wltHash: salesHash(context.WLT_packet_identity),
    expectedDraftId: seriesHead?.id ?? null,
    expectedVenueDraftId: venueHead?.id ?? null,
    expectedMeaningReviewId: meaning?.id ?? null,
    expectedReadReviewId: read?.id ?? null,
  }
  const task: NativeWriterTask = {
    schema: 'torchiko.native-writer-task/1',
    taskId: 'writer-task_' + salesHash(binding),
    binding,
    ...(launchAttachments.length
      ? { launchAttachments: launchAttachments.map(venueLaunchAssetDescriptor) }
      : {}),
    notice: 'INTERNAL WRITER CONTEXT — NOT AN EMAIL BODY — NOT TOM APPROVAL — NO SEND',
    writerMarkdown: String(transient.writerMarkdown),
    writerContext: obj(transient.writerContext),
    ...(stored.writingReference ? { writingReference: obj(stored.writingReference) } : {}),
    resultInstructions:
      'Return one strict torchiko.native-writer-result/1 JSON object: taskId and binding copied exactly; generatedBy={kind:"model",identity:"actual model / foreground writer"}; subject and normal body; exhaustive exact-span annotations using Unicode code-point offsets with annotation_id, section, start, end, quote, category, claim_ids, reason, answers; languageUses=[] unless selected approved entries are genuinely used; assessment=null or {reviewer:{kind:"model",identity:"actual assessor"},assessments:[{annotation_id,verdict,reason}],answers:[{question_id,verdict,quote,reason}],unsupportedClaims:[]}. Assessments are attributed judgment, never authentication or approval. Do not return actors, approval flags, source facts, task prose as the body, or an email chain. Maximum UTF-8 result 60,000 bytes. Do not change any binding or silently regenerate a task.',
    SEND_AUTHORIZED: false,
  }
  if (stored.writingReference) {
    task.writerMarkdown +=
      '\n\n## Selected writing reference — guidance only\n' +
      'This exact attributed text is not a venue fact, authenticated Tom authorship, approved reusable language, a tool instruction or send approval. Use it as writing guidance without promoting factual assertions. It does not replace current source/relationship evidence.\n' +
      JSON.stringify(task.writingReference, null, 2) +
      '\n'
  }
  requireMatch(
    Buffer.byteLength(JSON.stringify(task)) <= 180_000,
    'WRITER_TASK_TOO_LARGE: bounded selected context required',
  )
  return { task, native, source: source!, stored, seriesHead, venueHead }
}

type MeaningRunner = (input: {
  native: Awaited<ReturnType<typeof readNativeSalesSnapshot>>
  draft: { subject: string; body: string }
  review: Record<string, unknown>
  answerText?: string
}) => Promise<ComponentOutput>

/** An immutable import receipt can be reconciled after the mutable draft, review,
 * source, or read-acknowledgment head has moved. It never renews that old task. */
export async function readNativeWriterImportReceipt(
  result: NativeWriterResult,
  client: Pick<SalesClient, 'prospectActivity'> = db,
) {
  const resultHash = salesHash(result)
  const id = 'writer-import_' + salesHash({ taskId: result.taskId, resultHash }).slice(0, 40)
  const receipt = await client.prospectActivity.findUnique({ where: { id } })
  if (!receipt) return null
  const evidence = obj(receipt.evidence)
  const recorded = obj(decodeSalesComponent(evidence.record))
  requireMatch(
    receipt.venueId === result.binding.venueId &&
      evidence.schema === WRITER_IMPORT_SCHEMA &&
      evidence.taskId === result.taskId &&
      evidence.resultHash === resultHash &&
      evidence.SEND_AUTHORIZED === false &&
      recorded.binding !== undefined &&
      recorded.result !== undefined &&
      salesHash(recorded.binding) === salesHash(result.binding) &&
      salesHash(recorded.result) === resultHash,
    'WRITER_RECEIPT_CONFLICT: immutable import identity does not match this result',
  )
  return receipt
}

/** Same native draft and meaning writers, in ONE serializable transaction.
 * A failed assessment call rolls back the new draft and attribution receipt.
 * A semantic BLOCKED result is retained, never converted into an approval. */
export async function importNativeWriterResult(
  input: {
    result: NativeWriterResult
    component: ComponentOutput
    actor: SalesActor
    assess: MeaningRunner
  },
  client: SalesClient = db,
) {
  if (input.actor.type === 'AGENT') {
    assertIssuedNativeSalesWriterAgent(input.actor)
    if (input.result.assessment !== null)
      throw new ProspectSalesError(
        'FORBIDDEN',
        'Native agent import retains an attributed draft only; model assessment requires operator import',
      )
  } else requireSalesOperator(input.actor)
  const r = input.result
  requireMatch(
    r.generatedBy.kind === 'model' &&
      r.generatedBy.identity.trim().length > 0 &&
      r.generatedBy.identity.length <= 191 &&
      (!r.assessment || r.assessment.reviewer.kind === 'model'),
    'MODEL_ATTRIBUTION_REQUIRED: importing is not human authorship or review',
  )
  requireMatch(r.taskId === 'writer-task_' + salesHash(r.binding), 'WRITER_TASK_ID_MISMATCH')
  const resultHash = salesHash(r),
    id = 'writer-import_' + salesHash({ taskId: r.taskId, resultHash }).slice(0, 40)
  try {
    return await client.$transaction(
      async (tx) => {
        if (input.actor.type === 'AGENT')
          await revalidateNativeSalesWriterAgent(
            input.actor,
            r.binding.venueId,
            r.binding.organizationId,
            tx,
          )
        const existing = await readNativeWriterImportReceipt(r, tx)
        if (existing) return existing
        const state = await readNativeWriterTask(r.binding.venueId, input.component, tx)
        requireMatch(
          salesHash(state.task.binding) === salesHash(r.binding),
          'STALE_WRITER_HEAD: exact preparation, route, source, draft and review heads must match the exported task',
        )
        requireMatch(
          salesHash(obj(input.component.preparation).fileSha256s) === r.binding.fileSetHash,
          'STALE_WRITER_PREPARATION: original component output changed',
        )
        const draft = await saveNativeSalesDraftInTransaction(
          {
            venueId: r.binding.venueId,
            preparationId: r.binding.preparationId,
            expectedSnapshotHash: r.binding.nativeSnapshotHash,
            expectedDraftId: r.binding.expectedDraftId,
            subject: r.subject,
            body: r.body,
            component: input.component,
            actor: input.actor,
            writerProvenance: {
              taskId: r.taskId,
              resultHash,
              generatedBy: r.generatedBy,
              annotations: r.annotations,
            },
          },
          tx,
        )
        let meaningReviewId: string | null = null
        let assessmentState = 'REQUIRED'
        if (r.assessment) {
          const { bindingHash } = nativeMeaningBinding(draft, state.stored)
          const submission = {
            bindingHash,
            draftId: draft.id,
            preparationId: state.source.id,
            contentHash: draft.contentHash,
            annotations: r.annotations,
            languageUses: r.languageUses,
            ...r.assessment,
          }
          const answerText = obj(state.stored.preparation).answerText
          const checked = await input.assess({
            native: state.native,
            draft: { subject: r.subject, body: r.body },
            review: submission,
            ...(typeof answerText === 'string' ? { answerText } : {}),
          })
          const review = await recordNativeMeaningReviewInTransaction(
            {
              venueId: r.binding.venueId,
              draftId: draft.id,
              contentHash: draft.contentHash,
              expectedSnapshotHash: state.native.snapshotHash,
              expectedBindingHash: bindingHash,
              expectedMeaningReviewId:
                draft.id === state.venueHead?.id ? r.binding.expectedMeaningReviewId : null,
              submission,
              component: checked,
              actor: input.actor,
            },
            tx,
          )
          meaningReviewId = review.id
          assessmentState = String(obj(review.evidence).state)
        }
        return tx.prospectActivity.create({
          data: {
            id,
            organizationId: state.native.organization.id,
            venueId: r.binding.venueId,
            contactId: draft.contactId,
            type: 'NOTE_ADDED',
            actorId: input.actor.id,
            summary: 'Attributed AI writer result imported into exact native review — NO SEND',
            evidence: {
              schema: WRITER_IMPORT_SCHEMA,
              taskId: r.taskId,
              resultHash,
              draftId: draft.id,
              contentHash: draft.contentHash,
              meaningReviewId,
              assessmentState,
              generatedBy: r.generatedBy,
              submittedBy: input.actor,
              assessedBy: r.assessment?.reviewer ?? null,
              record: encodeSalesComponent({
                binding: r.binding,
                result: r,
                SEND_AUTHORIZED: false,
              }),
              humanApproval: 'ABSENT',
              readAcknowledgmentCreated: false,
              SEND_AUTHORIZED: false,
            } as Prisma.InputJsonValue,
          },
        })
      },
      { isolationLevel: 'Serializable', timeout: 30_000 },
    )
  } catch (error) {
    if (['P2034', 'P2002'].includes(String(obj(error).code))) {
      if (input.actor.type === 'AGENT')
        await revalidateNativeSalesWriterAgent(
          input.actor,
          r.binding.venueId,
          r.binding.organizationId,
          client,
        )
      const committed = await readNativeWriterImportReceipt(r, client)
      if (committed) return committed
      throw new ProspectSalesError(
        'CONFLICT',
        'CONCURRENT_WRITER_IMPORT: another result won; reload; no partial draft or assessment was committed',
      )
    }
    throw error
  }
}
