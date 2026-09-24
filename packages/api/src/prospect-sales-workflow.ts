import { prospectLaunchAssetView, selectProspectLaunchAsset } from './prospect-launch-assets'
import { venueLaunchAssetDescriptor } from '@pathfinder/contracts/venue-launch-asset'
import { launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import { requireCurrentProspectLaunchAttachments } from '@pathfinder/db'
import {
  assertLocalCrmSalesComponentsEnvironment,
  assertAuthenticatedCrmSalesComponentsEnvironment,
  inspectAuthenticatedCrmSalesComponents,
  invokeLocalCrmSalesComponents,
  readAuthenticatedTorchikoWritingGuide,
  readLocalTorchikoWritingGuide,
  TORCHIKO_SAVED_WRITING_GUIDE,
  TORCHIKO_SAVED_WRITING_GUIDE_SOURCE,
} from '@pathfinder/config/local-crm-sales-components'
import { nativeWithReplyProjections, projectNativeCrmRead } from './prospect-sales-read-view'
import {
  db,
  withTenantIsolationBypass,
  readNativeSalesSnapshot,
  readNativeSalesReviewState,
  persistNativeSalesPreparation,
  saveNativeSalesDraft,
  reviewNativeSalesDraft,
  salesHash,
  ProspectSalesError,
  decodeSalesComponent,
  readNativeSalesRouteSuppression,
  requireNativeSalesRouteClear,
  requireSalesOperator,
  nativeMeaningBinding,
  recordNativeMeaningReview,
  READ_REVIEW_SCOPE,
  SALES_PREPARATION_SOURCE,
  admitNativeSourceSelection,
  readNativeWriterTask,
  readNativeWriterImportReceipt,
  importNativeWriterResult,
  type NativeSalesSnapshot,
  type ComponentOutput,
  type SalesActor,
  TEMPORARY_REPLY_RECIPE,
  requireCurrentTemporaryReply,
  revalidateNativeSalesWriterAgentBound,
} from '@pathfinder/db'
import { assertLocalProspectResearchEnvironment } from './prospect-research-reader'
import {
  salesLocalAction,
  type NativeSalesAction,
  type SalesActionResponse,
  type SalesWorkflowView,
} from './prospect-sales-contract'
import type { MeaningSubmission } from './prospect-meaning-contract'
import { projectNativeMeaningReview } from './prospect-sales-meaning-view'
import {
  readNativeOperationalView,
  applyNativeOperationalAction,
} from './prospect-first-send-workflow'
import type { EvidenceAdmissionView } from './prospect-evidence-contract'

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const strings = (v: unknown) =>
  arr(v).map((x) => {
    if (typeof x === 'string') return x
    const issue = obj(x)
    if (issue.kind === 'missing_required_literal')
      return `Write Like Tom check: required wording “${str(issue.literal)}” is missing. Resolve it against the source context before treating the writing as complete.`
    return str(
      issue.question,
      str(
        issue.message,
        str(issue.reason, str(issue.kind, str(issue.code, JSON.stringify(x))).replaceAll('_', ' ')),
      ),
    )
  })

export function assertLocalSalesEnvironment(env: Record<string, string | undefined> = process.env) {
  assertLocalProspectResearchEnvironment(env)
  try {
    assertLocalCrmSalesComponentsEnvironment(env)
  } catch {
    throw new ProspectSalesError('FORBIDDEN', 'Local sales component owner is unavailable')
  }
}
export type SalesRuntime = 'local' | 'authenticated-admin'

/** Metadata only. The route adds authenticated identity and native mailbox
 * status; neither an env flag nor path presence proves the component ran. */
export async function readAuthenticatedSalesReadiness(
  env: Record<string, string | undefined> = process.env,
) {
  const component = await inspectAuthenticatedCrmSalesComponents(env)
  const deployment =
    env.DEPLOYMENT_ENV === 'production' || env.APP_ENV === 'production'
      ? ('hosted-production' as const)
      : env.NODE_ENV === 'development'
        ? ('development-instance' as const)
        : ('unclassified-instance' as const)
  return {
    schema: 'torchiko.authenticated-sales-readiness/1' as const,
    instance: { scope: 'THIS_AUTHENTICATED_API_PROCESS' as const, deployment },
    component: { state: component.state, reason: component.reason, executionVerified: false },
    writingGuide: {
      id: TORCHIKO_SAVED_WRITING_GUIDE,
      sourceRef: TORCHIKO_SAVED_WRITING_GUIDE_SOURCE,
      ...component.guide,
    },
    writer: {
      preparationSource: SALES_PREPARATION_SOURCE,
      taskSchema: 'torchiko.native-writer-task/1' as const,
      resultSchema: 'torchiko.native-writer-result/1' as const,
      automaticGeneration: false,
      SEND_AUTHORIZED: false,
    },
    nextAction:
      component.state === 'unconfigured'
        ? ('CONFIGURE_PRIVATE_COMPONENT_OWNER' as const)
        : component.state === 'unavailable'
          ? ('INSTALL_PRIVATE_COMPONENT_OWNER' as const)
          : component.guide.state !== 'available'
            ? ('RESTORE_EXACT_SAVED_WRITING_GUIDE' as const)
            : ('SELECT_VENUE_AND_PREPARE_EXPLICITLY' as const),
  }
}

/** Only the exact named owner guide is freshness-checked. An inline reference
 * remains its own explicitly submitted immutable source, not a server path. */
export async function selectedWritingGuideCurrent(
  reference: Record<string, unknown>,
  runtime: SalesRuntime,
  readGuide: typeof readAuthenticatedTorchikoWritingGuide = runtime === 'local'
    ? readLocalTorchikoWritingGuide
    : readAuthenticatedTorchikoWritingGuide,
): Promise<boolean> {
  if (reference.sourceRef !== TORCHIKO_SAVED_WRITING_GUIDE_SOURCE) return true
  try {
    const guide = await readGuide()
    return reference.sha256 === guide.sha256
  } catch {
    return false
  }
}
async function requireSelectedWritingGuideCurrent(
  component: ComponentOutput,
  runtime: SalesRuntime,
) {
  if (!(await selectedWritingGuideCurrent(obj(component.writingReference), runtime)))
    throw new ProspectSalesError(
      'CONFLICT',
      'STALE_SELECTED_WRITING_GUIDE: prepare a new source-bound context before this action',
    )
}

type PrepareInput = Extract<NativeSalesAction, { action: 'prepare' }>['input']
export function assertSavedGuideSelection(input: PrepareInput, runtime: SalesRuntime) {
  if (
    (input.savedWritingGuide &&
      (input.writingReference ||
        runtime !== 'authenticated-admin' ||
        !input.expectedWritingGuideSha256)) ||
    (!input.savedWritingGuide && input.expectedWritingGuideSha256) ||
    (runtime === 'authenticated-admin' &&
      input.writingReference?.sourceRef === TORCHIKO_SAVED_WRITING_GUIDE_SOURCE)
  )
    throw new ProspectSalesError(
      'INVALID_INPUT',
      'Select either the installed guide or one explicit writing reference on the authenticated route',
    )
}

export async function resolveSelectedWritingReference(
  input: PrepareInput,
  runtime: SalesRuntime,
  readGuide: typeof readAuthenticatedTorchikoWritingGuide = readAuthenticatedTorchikoWritingGuide,
) {
  assertSavedGuideSelection(input, runtime)
  if (!input.savedWritingGuide) return input.writingReference
  let guide: Awaited<ReturnType<typeof readAuthenticatedTorchikoWritingGuide>>
  try {
    guide = await readGuide()
  } catch {
    throw new ProspectSalesError(
      'CONFLICT',
      'SELECTED_WRITING_GUIDE_UNAVAILABLE: exact installed guide is not readable',
    )
  }
  if (guide.sha256 !== input.expectedWritingGuideSha256)
    throw new ProspectSalesError(
      'CONFLICT',
      'STALE_SELECTED_WRITING_GUIDE: reload the guide descriptor before preparing',
    )
  return guide
}
function assertSalesRuntime(runtime: SalesRuntime) {
  if (runtime === 'local') return assertLocalSalesEnvironment()
  try {
    assertAuthenticatedCrmSalesComponentsEnvironment()
  } catch {
    throw new ProspectSalesError(
      'FORBIDDEN',
      'Authenticated private sales component owner is unavailable',
    )
  }
}

export async function invokeSalesComponents(
  payload: {
    action: 'evaluate' | 'prepare' | 'check' | 'meaning' | 'capture' | 'admission'
    native: NativeSalesSnapshot
    answerText?: string
    selectedThreadId?: string
    draft?: { subject: string; body: string }
    review?: MeaningSubmission
    capture?: Record<string, unknown>
    admission?: Record<string, unknown>
  },
  runtime: SalesRuntime = 'local',
): Promise<ComponentOutput> {
  assertSalesRuntime(runtime)
  try {
    return await invokeLocalCrmSalesComponents(
      {
        ...payload,
        native: nativeWithReplyProjections(payload.native),
      },
      runtime,
    )
  } catch (error) {
    throw new ProspectSalesError(
      'CONFLICT',
      runtime === 'authenticated-admin'
        ? 'Private sales component could not evaluate this native record; check authenticated readiness'
        : error instanceof Error
          ? error.message
          : 'Local component failed without a usable result',
    )
  }
}

/** The imported result's assessment must use the same exact selected thread
 * as the exported task. A single-thread fixture would not catch this binding. */
export function bindNativeWriterAssessment(
  selectedThreadId: string | undefined,
  runtime: SalesRuntime,
  run: typeof invokeSalesComponents = invokeSalesComponents,
) {
  return (input: {
    native: NativeSalesSnapshot
    draft: { subject: string; body: string }
    review: Record<string, unknown>
    answerText?: string
  }) =>
    run(
      {
        action: 'meaning',
        ...input,
        ...(selectedThreadId ? { selectedThreadId } : {}),
        review: input.review as MeaningSubmission,
      },
      runtime,
    )
}

function seriesKey(component: ComponentOutput, venueId: string) {
  const preparation = obj(component.preparation),
    crosswalk = obj(component.crosswalk)
  const projection = obj(obj(component.correspondence).projection)
  return salesHash({
    venueId,
    routingId: obj(crosswalk.routing).routing_id,
    mode: obj(preparation.request).mode,
    threadId: projection.thread_id ?? null,
    latestInboundId: projection.reply_to_message_id ?? null,
  })
}

/** Trusted server/worker callback. Re-evaluates original Gate/Composer/WLT without
 * changing the persisted task or renewing its source dates. */
export async function verifyNativeOriginRuntime(
  native: NativeSalesSnapshot,
  stored: ComponentOutput,
  runtime: SalesRuntime = 'local',
) {
  const answerText = obj(stored.preparation).answerText
  const selectedThreadId = obj(obj(stored.correspondence).projection).thread_id
  return invokeSalesComponents(
    {
      action: 'prepare',
      native,
      ...(typeof answerText === 'string' ? { answerText } : {}),
      ...(typeof selectedThreadId === 'string' ? { selectedThreadId } : {}),
    },
    runtime,
  )
}

export async function getNativeSalesWorkflow(
  venueId: string,
  runtime: SalesRuntime = 'local',
): Promise<SalesWorkflowView> {
  assertSalesRuntime(runtime)
  return withTenantIsolationBypass(async () => {
    const native = await readNativeSalesSnapshot(venueId)
    const stored = await readNativeSalesReviewState(venueId)
    const source = stored.preparations[0]
    const preparedComponent = decodeSalesComponent(source?.capturedValue)
    const savedGuideCurrent = await selectedWritingGuideCurrent(
      obj(preparedComponent.writingReference),
      runtime,
    )
    let launchAttachmentsCurrent = true
    try {
      await requireCurrentProspectLaunchAttachments(
        venueId,
        launchAttachmentsFromSnapshot(preparedComponent),
      )
    } catch {
      launchAttachmentsCurrent = false
    }
    const temporaryRecipe = obj(preparedComponent.retentionRecipe).schema === TEMPORARY_REPLY_RECIPE
    const selectedThreadId = obj(obj(preparedComponent.correspondence).projection).thread_id
    let component: ComponentOutput = {},
      blocker: string | null = null
    try {
      component = await invokeSalesComponents(
        {
          action: 'evaluate',
          native,
          ...(typeof selectedThreadId === 'string' ? { selectedThreadId } : {}),
        },
        runtime,
      )
      if (temporaryRecipe) {
        const answerText = obj(preparedComponent.preparation).answerText
        component = await invokeSalesComponents(
          {
            action: 'prepare',
            native,
            ...(typeof answerText === 'string' ? { answerText } : {}),
            ...(typeof selectedThreadId === 'string' ? { selectedThreadId } : {}),
          },
          runtime,
        )
      }
    } catch (error) {
      blocker = error instanceof Error ? error.message : 'Local preparation could not be evaluated'
    }
    let temporaryCurrent = false
    if (temporaryRecipe && !blocker && !component.blocker) {
      try {
        requireCurrentTemporaryReply(preparedComponent, component)
        temporaryCurrent = true
      } catch (error) {
        blocker = error instanceof Error ? error.message : 'Temporary correspondence source changed'
      }
    }
    const gate = obj(component.gate),
      crosswalk = obj(component.crosswalk),
      route = obj(crosswalk.routing)
    const routeHold = await readNativeSalesRouteSuppression(route)
    blocker = blocker ?? (typeof component.blocker === 'string' ? component.blocker : null)
    const correspondence = obj(component.correspondence),
      projection = obj(correspondence.projection)
    const threadSnapshot = obj(correspondence.snapshot)
    const latest = arr(threadSnapshot.messages)
      .map(obj)
      .find((m) => m.message_id === obj(projection.latest_inbound).message_id)
    const prepared = obj(preparedComponent.preparation)
    const displayPreparation =
      temporaryRecipe && temporaryCurrent ? obj(component.preparation) : prepared
    const context = obj(prepared.writerContext),
      library = obj(context.approved_language_snapshot),
      reference = obj(preparedComponent.writingReference)
    const sourceStale =
      !launchAttachmentsCurrent ||
      Boolean(blocker) ||
      !savedGuideCurrent ||
      preparedComponent.nativeSnapshotHash !== native.snapshotHash ||
      salesHash(preparedComponent.componentCodeHashes ?? {}) !==
        salesHash(component.componentCodeHashes ?? {})
    const currentDraft = stored.drafts[0]
    const grounding = obj(currentDraft?.groundingSnapshot)
    // Inspect the draft's exact source even when a newer preparation is selected.
    const draftSource = currentDraft
      ? (stored.preparations.find((p) => p.id === grounding.preparationId) ??
        (await db.prospectSourceEvidence.findUnique({
          where: { id: str(grounding.preparationId, 'not-found') },
        })))
      : null
    const draftComponent = decodeSalesComponent(draftSource?.capturedValue)
    const draftGuideCurrent =
      draftSource?.id === source?.id
        ? savedGuideCurrent
        : await selectedWritingGuideCurrent(obj(draftComponent.writingReference), runtime)
    const review = stored.reviews.find(
      (r) =>
        obj(r.evidence).reviewScope === READ_REVIEW_SCOPE &&
        obj(r.evidence).draftId === currentDraft?.id &&
        obj(r.evidence).contentHash === currentDraft?.contentHash,
    )
    const draftStale =
      !launchAttachmentsCurrent ||
      Boolean(blocker) ||
      !draftGuideCurrent ||
      !draftSource ||
      source?.id !== grounding.preparationId ||
      grounding.nativeSnapshotHash !== native.snapshotHash ||
      draftComponent.nativeSnapshotHash !== native.snapshotHash ||
      salesHash(draftComponent.componentCodeHashes ?? {}) !==
        salesHash(component.componentCodeHashes ?? {})
    const claimReview = projectNativeMeaningReview({
      draft: currentDraft,
      source: draftComponent,
      ...(draftSource?.id === source?.id && temporaryRecipe && temporaryCurrent
        ? { displaySource: component }
        : {}),
      stale: draftStale,
      readReviewRecorded: Boolean(review),
      reviews: stored.reviews,
    })
    const warnings = currentDraft
      ? [
          claimReview?.status === 'ASSESSED_NO_SEND'
            ? 'Attributed meaning assessment recorded. This is not authenticated human review, semantic certification or send approval.'
            : `Claim/meaning review: ${claimReview?.status ?? 'REQUIRED'}. Read-review does not clear meaning holds or authorize sending.`,
          ...strings(obj(grounding.check).claimRiskFlags),
          ...strings(obj(obj(grounding.check).WLT_check).errors),
          ...strings(obj(obj(grounding.check).WLT_check).warnings),
        ]
      : []
    const held =
      native.suppression.blocked ||
      routeHold.blocked ||
      obj(projection.suppression).blocked === true
    let writerTask = null,
      writerHold: string | null = null
    try {
      if (!savedGuideCurrent)
        writerHold = 'STALE_SELECTED_WRITING_GUIDE: prepare a new source-bound context'
      else writerTask = (await readNativeWriterTask(venueId, component)).task
    } catch (error) {
      writerHold = error instanceof Error ? error.message : 'Current persisted preparation required'
    }
    return {
      launchAssets: await prospectLaunchAssetView(venueId),
      writerTask,
      writerHold,
      operational: await readNativeOperationalView(venueId, (current, stored) =>
        verifyNativeOriginRuntime(current, stored, runtime),
      ),
      evidenceAdmission: component.evidenceAdmission
        ? (component.evidenceAdmission as unknown as EvidenceAdmissionView)
        : null,
      claimReview,
      recordContext: projectNativeCrmRead(native),
      venueId,
      organizationId: native.organization.id,
      name: native.venue.name,
      snapshotHash: native.snapshotHash,
      sourceCount: native.sources.length,
      sourceState: component.crosswalk
        ? crosswalk.synthetic === true
          ? 'EXPLICIT_SYNTHETIC_REHEARSAL_SOURCE'
          : crosswalk.nativeCaptureId
            ? 'NATIVE_SOURCE_CATALOG_WITH_EXACT_IMPORT_LINEAGE'
            : 'EXACT_NATIVE_SOURCE_CROSSWALK'
        : 'WORKBOOK_CANDIDATES_ONLY_NO_PRIMARY_VERIFICATION',
      contacts: native.contacts.map((c) => ({
        id: c.id,
        name: c.fullName,
        email: c.email,
        readiness: c.emailReadiness,
        permission: c.permissionState,
      })),
      gate: {
        decision: str(gate.decision, 'HUMAN_INPUT_REQUIRED'),
        canPrepare: gate.can_prepare === true && !held && !blocker,
        questions: arr(gate.research_plan).map((x, index) => {
          const p = obj(x)
          return {
            id: str(p.question_id, `question-${index}`),
            question: str(p.question, str(p.exact_question, JSON.stringify(x))),
            why: str(p.why_needed, str(p.reason)),
          }
        }),
        humanQuestions: strings(gate.human_questions),
        notices: [
          ...strings(gate.notices),
          ...(route.kind === 'email' &&
          typeof route.recipient === 'string' &&
          typeof crosswalk.nativeContactId !== 'string'
            ? [
                'The selected public email route has no exact native contact record. Writing review can continue; operational handoff requires a selected, eligible native contact.',
              ]
            : []),
        ],
      },
      routing: component.crosswalk
        ? {
            kind: str(route.kind),
            value:
              typeof route.recipient === 'string'
                ? route.recipient
                : typeof route.url === 'string'
                  ? route.url
                  : null,
            publicSnapshotStatus: str(route.status, 'SOURCE_SNAPSHOT_ONLY'),
            nativeContactId:
              typeof crosswalk.nativeContactId === 'string' ? crosswalk.nativeContactId : null,
            readiness: str(crosswalk.nativeEmailReadiness, 'UNKNOWN'),
            permission: str(crosswalk.nativePermissionState, 'UNKNOWN'),
          }
        : null,
      suppression: {
        blocked: held,
        reasons: [
          ...native.suppression.reasons,
          ...routeHold.reasons,
          ...(obj(projection.suppression).blocked
            ? ['Correspondence owner requires a stop/hold; no ordinary reply is available']
            : []),
        ],
      },
      outreachState: held
        ? 'HELD_SUPPRESSED'
        : currentDraft
          ? draftStale
            ? 'STALE_DRAFT_REVIEW'
            : review
              ? 'REVIEWED_NO_SEND'
              : 'DRAFT_REVIEW'
          : source && !sourceStale
            ? 'PREPARATION_READY'
            : 'NO_DRAFT',
      correspondenceState: held
        ? 'CLOSED_HELD'
        : !native.threads.length
          ? 'NO_THREAD'
          : projection.reply_action === 'AWAIT_INITIAL_RESPONSE'
            ? 'AWAITING_RESPONSE'
            : projection.latest_inbound
              ? currentDraft &&
                grounding.replyToMessageId === obj(projection.latest_inbound).message_id &&
                !draftStale
                ? 'RESPONSE_REVIEW_NEEDED'
                : 'REPLY_RECEIVED'
              : 'HUMAN_INPUT_REQUIRED',
      correspondence:
        native.threads.length &&
        (native.threads.length === 1 || typeof selectedThreadId === 'string')
          ? {
              threadId: str(selectedThreadId, native.threads[0]!.id),
              relationship: str(projection.relationship_state, 'unresolved'),
              action: str(projection.reply_action, 'HUMAN_REVIEW_REQUIRED'),
              synthetic: threadSnapshot.synthetic_correspondence === true,
              latestInbound: latest
                ? {
                    id: str(latest.message_id),
                    body: str(obj(latest.content).text),
                    subject: str(latest.subject),
                  }
                : null,
              points: arr(projection.live_points).map((x) => str(obj(x).quote)),
              issues: strings(projection.issues),
            }
          : null,
      threadCandidates: native.threads.map((thread) => ({
        id: thread.id,
        messageCount: thread._count.messages,
        updatedAt: String(thread.updatedAt),
        sourceComplete:
          native.threadCoverage.find((item) => item.threadId === thread.id)?.complete === true,
        sourceIssues:
          native.threadCoverage.find((item) => item.threadId === thread.id)?.issues ?? [],
      })),
      preparation: source
        ? {
            id: source.id,
            stale: sourceStale,
            why: str(obj(prepared.request).purpose),
            expectedDraftId:
              stored.drafts.find((d) => d.preparationKey === seriesKey(preparedComponent, venueId))
                ?.id ?? null,
            writerMarkdown: str(displayPreparation.writerMarkdown),
            approvedCount: Number(library.current_approved_count ?? 0),
            selectedCount: arr(library.selected_entries).length,
            wltIdentity: JSON.stringify(context.WLT_packet_identity ?? null),
            launchAttachments: launchAttachmentsFromSnapshot(preparedComponent).map(
              venueLaunchAssetDescriptor,
            ),
            writingReference:
              typeof reference.label === 'string' &&
              typeof reference.sourceRef === 'string' &&
              typeof reference.text === 'string' &&
              typeof reference.sha256 === 'string'
                ? {
                    label: reference.label,
                    sourceRef: reference.sourceRef,
                    text: reference.text,
                    sha256: reference.sha256,
                  }
                : null,
          }
        : null,
      draft: currentDraft
        ? {
            id: currentDraft.id,
            version: currentDraft.version,
            subject: currentDraft.subject,
            body: currentDraft.textBody,
            launchAttachments: launchAttachmentsFromSnapshot(grounding).map(
              venueLaunchAssetDescriptor,
            ),
            contentHash: currentDraft.contentHash,
            state: draftStale ? 'STALE' : review ? 'REVIEWED_NO_SEND' : 'DRAFT_REVIEW',
            preparationId: str(grounding.preparationId),
            previousDraftId:
              typeof grounding.previousDraftId === 'string' ? grounding.previousDraftId : null,
            writerAttribution:
              grounding.writerProvenance &&
              obj(obj(grounding.writerProvenance).generatedBy).kind === 'model'
                ? {
                    generatedByKind: 'model',
                    generatedBy: str(obj(obj(grounding.writerProvenance).generatedBy).identity),
                    submittedBy: str(obj(obj(grounding.writerProvenance).submittedBy).id),
                    taskId: str(obj(grounding.writerProvenance).taskId),
                    resultHash: str(obj(grounding.writerProvenance).resultHash),
                  }
                : null,
            warnings,
          }
        : null,
      revisions: stored.drafts.map((d) => ({
        id: d.id,
        version: d.version,
        contentHash: d.contentHash,
        reviewed: stored.reviews.some(
          (r) =>
            obj(r.evidence).reviewScope === READ_REVIEW_SCOPE &&
            obj(r.evidence).draftId === d.id &&
            obj(r.evidence).contentHash === d.contentHash,
        ),
      })),
      blocker,
      SEND_AUTHORIZED: false,
      senderAvailable: false,
    }
  })
}

export async function viewOrImmutableImportReceipt(
  venueId: string,
  originalSnapshotHash: string,
  receipt: { id: string; evidence: unknown },
  replayed: boolean,
  loadView: (venueId: string) => Promise<SalesWorkflowView> = getNativeSalesWorkflow,
): Promise<SalesActionResponse> {
  const evidence = obj(receipt.evidence)
  if (
    typeof evidence.draftId !== 'string' ||
    !evidence.draftId.trim() ||
    (evidence.meaningReviewId !== null &&
      evidence.meaningReviewId !== undefined &&
      (typeof evidence.meaningReviewId !== 'string' || !evidence.meaningReviewId.trim()))
  )
    throw new ProspectSalesError(
      'CONFLICT',
      'WRITER_RECEIPT_INCOMPLETE: immutable import exists but its native draft/review identity is invalid',
    )
  const writerImportReceipt = {
    id: receipt.id,
    draftId: evidence.draftId,
    meaningReviewId: typeof evidence.meaningReviewId === 'string' ? evidence.meaningReviewId : null,
    replayed,
  }
  try {
    return { ...(await loadView(venueId)), writerImportReceipt }
  } catch (error) {
    const currentViewFailure =
      error instanceof ProspectSalesError
        ? error.code === 'NOT_FOUND'
          ? ('RECORD_NOT_FOUND' as const)
          : error.code === 'CONFLICT' || error.code === 'INVALID_INPUT'
            ? ('STATE_CONFLICT' as const)
            : ('ACCESS_OR_POLICY_HOLD' as const)
        : ('READ_FAILED' as const)
    return {
      schema: 'torchiko.native-writer-import-receipt-only/1',
      venueId,
      originalSnapshotHash,
      writerImportReceipt,
      currentViewAvailable: false,
      currentViewFailure,
      SEND_AUTHORIZED: false,
      senderAvailable: false,
    }
  }
}

export async function applyNativeSalesAction(
  action: NativeSalesAction,
  actor: SalesActor,
  runtime: SalesRuntime = 'local',
): Promise<SalesActionResponse> {
  assertSalesRuntime(runtime)
  const verifyCurrentOrigin = (native: NativeSalesSnapshot, stored: ComponentOutput) =>
    verifyNativeOriginRuntime(native, stored, runtime)
  const parsed = salesLocalAction.parse(action)
  if (actor.type === 'AGENT') {
    if (
      runtime !== 'authenticated-admin' ||
      (parsed.action !== 'prepare' && parsed.action !== 'importWriterResult')
    )
      throw new ProspectSalesError(
        'FORBIDDEN',
        'Native writer agents may only prepare or import an attributed no-send result',
      )
    await revalidateNativeSalesWriterAgentBound(actor, parsed.input.venueId)
  } else requireSalesOperator(actor)
  if (parsed.action === 'prepare') assertSavedGuideSelection(parsed.input, runtime)
  if (parsed.action === 'importWriterResult') {
    const receipt = await withTenantIsolationBypass(() =>
      readNativeWriterImportReceipt(parsed.input.result),
    )
    if (receipt) {
      return viewOrImmutableImportReceipt(
        parsed.input.venueId,
        parsed.input.result.binding.nativeSnapshotHash,
        receipt,
        true,
        (venueId) => getNativeSalesWorkflow(venueId, runtime),
      )
    }
  }
  const importedReceipt = await withTenantIsolationBypass(async () => {
    const native = await readNativeSalesSnapshot(parsed.input.venueId)
    if (
      parsed.action !== 'admitEvidence' &&
      native.snapshotHash !== parsed.input.expectedSnapshotHash
    )
      throw new ProspectSalesError('CONFLICT', 'STALE_NATIVE_SNAPSHOT: reload before this action')
    if (native.suppression.blocked)
      throw new ProspectSalesError('SUPPRESSED', 'Native suppression blocks sales preparation')
    // Resolve only the read-only source/gate crosswalk before Composer, then query
    // the native address-wide hold owner. Transactions repeat this check at write.
    const selectedSource = await db.prospectSourceEvidence.findFirst({
      where: { venueId: native.venue.id, sourceType: SALES_PREPARATION_SOURCE },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    if (parsed.action !== 'prepare' && parsed.action !== 'admitEvidence')
      await requireSelectedWritingGuideCurrent(
        decodeSalesComponent(selectedSource?.capturedValue),
        runtime,
      )
    const storedThreadId = obj(
      obj(decodeSalesComponent(selectedSource?.capturedValue).correspondence).projection,
    ).thread_id
    const selectedThreadId =
      parsed.action === 'prepare' ? parsed.input.selectedThreadId : storedThreadId
    const threadSelection = typeof selectedThreadId === 'string' ? { selectedThreadId } : {}
    const evaluated = await invokeSalesComponents(
      { action: 'evaluate', native, ...threadSelection },
      runtime,
    )
    await requireNativeSalesRouteClear(obj(evaluated.crosswalk).routing)
    if (
      parsed.action === 'handoffOperational' ||
      parsed.action === 'reviewOperational' ||
      parsed.action === 'stageOperational' ||
      parsed.action === 'approveOperationalBatch' ||
      parsed.action === 'releaseSyntheticBatch'
    ) {
      await applyNativeOperationalAction(parsed, actor, verifyCurrentOrigin)
    } else if (parsed.action === 'admitEvidence') {
      const admission = {
        captureId: parsed.input.captureId,
        selection: parsed.input.selection,
        previousSelectionId: parsed.input.expectedSelectionId,
        SEND_AUTHORIZED: false,
      }
      const component = await invokeSalesComponents(
        { action: 'admission', native, admission },
        runtime,
      )
      await admitNativeSourceSelection({ ...parsed.input, component, actor })
    } else if (parsed.action === 'importWriterResult') {
      const source = await db.prospectSourceEvidence.findUnique({
        where: { id: parsed.input.result.binding.preparationId },
      })
      if (
        !source ||
        source.venueId !== native.venue.id ||
        source.sourceType !== SALES_PREPARATION_SOURCE
      )
        throw new ProspectSalesError(
          'CONFLICT',
          'WRONG_WRITER_PREPARATION: no preparation for this exact prospect',
        )
      await requireSelectedWritingGuideCurrent(decodeSalesComponent(source.capturedValue), runtime)
      const answerText = obj(decodeSalesComponent(source.capturedValue).preparation).answerText
      const component = await invokeSalesComponents(
        {
          action: 'check',
          native,
          ...threadSelection,
          draft: { subject: parsed.input.result.subject, body: parsed.input.result.body },
          ...(typeof answerText === 'string' ? { answerText } : {}),
        },
        runtime,
      )
      return importNativeWriterResult({
        result: parsed.input.result,
        component,
        actor,
        assess: bindNativeWriterAssessment(
          typeof selectedThreadId === 'string' ? selectedThreadId : undefined,
          runtime,
        ),
      })
    } else if (parsed.action === 'prepare') {
      const writingReference = await resolveSelectedWritingReference(parsed.input, runtime)
      const launchAttachments = parsed.input.launchAssetSelection
        ? [await selectProspectLaunchAsset(parsed.input.venueId, parsed.input.launchAssetSelection)]
        : []
      const component = await invokeSalesComponents(
        {
          action: 'prepare',
          native,
          ...threadSelection,
          ...(parsed.input.answerText ? { answerText: parsed.input.answerText } : {}),
        },
        runtime,
      )
      if (writingReference && !(await selectedWritingGuideCurrent(writingReference, runtime)))
        throw new ProspectSalesError(
          'CONFLICT',
          'STALE_SELECTED_WRITING_GUIDE: reload the guide descriptor before preparing',
        )
      await persistNativeSalesPreparation({
        venueId: parsed.input.venueId,
        expectedSnapshotHash: parsed.input.expectedSnapshotHash,
        component,
        actor,
        ...(launchAttachments.length ? { launchAttachments } : {}),
        ...(writingReference ? { writingReference } : {}),
      })
    } else if (parsed.action === 'save') {
      const source = await db.prospectSourceEvidence.findUnique({
        where: { id: parsed.input.preparationId },
      })
      if (!source || source.venueId !== native.venue.id)
        throw new ProspectSalesError('NOT_FOUND', 'Native preparation not found')
      await requireSelectedWritingGuideCurrent(decodeSalesComponent(source.capturedValue), runtime)
      const answerText = obj(decodeSalesComponent(source.capturedValue).preparation).answerText
      const component = await invokeSalesComponents(
        {
          action: 'check',
          native,
          ...threadSelection,
          ...(typeof answerText === 'string' ? { answerText } : {}),
          draft: { subject: parsed.input.subject, body: parsed.input.body },
        },
        runtime,
      )
      await saveNativeSalesDraft({ ...parsed.input, component, actor })
    } else {
      // Reload component heads too; reviewed text cannot silently inherit new WLT/library/source authority.
      const sourceDraft = await db.prospectOutreachDraft.findUnique({
        where: { id: parsed.input.draftId },
      })
      if (
        !sourceDraft ||
        sourceDraft.venueId !== native.venue.id ||
        sourceDraft.contentHash !== parsed.input.contentHash
      )
        throw new ProspectSalesError('CONFLICT', 'Exact draft/content/venue identity required')
      const source = await db.prospectSourceEvidence.findUnique({
        where: { id: str(obj(sourceDraft?.groundingSnapshot).preparationId, 'not-found') },
      })
      if (
        !source ||
        source.venueId !== native.venue.id ||
        source.sourceType !== SALES_PREPARATION_SOURCE
      )
        throw new ProspectSalesError('NOT_FOUND', 'Draft preparation not found')
      await requireSelectedWritingGuideCurrent(decodeSalesComponent(source.capturedValue), runtime)
      const selected = await db.prospectSourceEvidence.findFirst({
        where: { venueId: native.venue.id, sourceType: SALES_PREPARATION_SOURCE },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      if (selected?.id !== source.id)
        throw new ProspectSalesError(
          'CONFLICT',
          'STALE_PREPARATION: a different preparation is selected; save and inspect a new revision',
        )
      const old = decodeSalesComponent(source.capturedValue),
        answerText = obj(old.preparation).answerText
      let submission: MeaningSubmission | undefined
      if (parsed.action === 'meaning') {
        const { bindingHash } = nativeMeaningBinding(sourceDraft, old)
        if (bindingHash !== parsed.input.expectedBindingHash)
          throw new ProspectSalesError(
            'CONFLICT',
            'STALE_MEANING_BINDING: reload the exact draft and evidence',
          )
        if (parsed.input.reviewer.kind === 'human' && actor.type !== 'HUMAN')
          throw new ProspectSalesError(
            'FORBIDDEN',
            'Synthetic/model actions cannot assert an authenticated human review',
          )
        const reviewer =
          parsed.input.reviewer.kind === 'human'
            ? { kind: 'human' as const, identity: actor.id }
            : parsed.input.reviewer
        submission = {
          bindingHash,
          draftId: sourceDraft.id,
          preparationId: source.id,
          contentHash: sourceDraft.contentHash,
          annotations: parsed.input.annotations,
          languageUses: parsed.input.languageUses,
          reviewer,
          assessments: parsed.input.assessments,
          answers: parsed.input.answers,
          unsupportedClaims: parsed.input.unsupportedClaims,
        }
      }
      const current = await invokeSalesComponents(
        {
          action: parsed.action === 'meaning' ? 'meaning' : 'prepare',
          native,
          ...threadSelection,
          ...(typeof answerText === 'string' ? { answerText } : {}),
          ...(submission
            ? {
                draft: { subject: sourceDraft.subject, body: sourceDraft.textBody },
                review: submission,
              }
            : {}),
        },
        runtime,
      )
      if (
        salesHash(obj(old.preparation).fileSha256s) !==
          salesHash(obj(current.preparation).fileSha256s) ||
        salesHash(old.componentCodeHashes) !== salesHash(current.componentCodeHashes)
      )
        throw new ProspectSalesError(
          'CONFLICT',
          'STALE_REVIEW: component source, WLT or language snapshot changed',
        )
      if (parsed.action === 'meaning' && submission)
        await recordNativeMeaningReview({ ...parsed.input, submission, component: current, actor })
      else if (parsed.action === 'review') await reviewNativeSalesDraft({ ...parsed.input, actor })
    }
    return undefined
  })
  if (parsed.action === 'importWriterResult' && importedReceipt)
    return viewOrImmutableImportReceipt(
      parsed.input.venueId,
      parsed.input.result.binding.nativeSnapshotHash,
      importedReceipt,
      false,
      (venueId) => getNativeSalesWorkflow(venueId, runtime),
    )
  return getNativeSalesWorkflow(parsed.input.venueId, runtime)
}
