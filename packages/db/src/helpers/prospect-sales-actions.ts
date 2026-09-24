import {
  launchAttachmentsFromSnapshot,
  parseVenueLaunchAttachments,
  launchAttachmentsSha256,
} from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { requireCurrentProspectLaunchAttachments } from './prospect-launch-attachments'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db } from '../client'
import {
  readNativeSalesSnapshot,
  requireNativeSalesRouteClear,
  salesHash,
  salesJson,
  SALES_PREPARATION_SOURCE,
  SALES_COMPONENT_STORAGE,
  encodeSalesComponent,
  decodeSalesComponent,
  ProspectSalesError,
  type SalesClient,
  type SalesTransaction,
} from './prospect-sales-snapshot'

import {
  assertIssuedNativeSalesWriterAgent,
  revalidateNativeSalesWriterAgent,
  type NativeSalesWriterAgentActor,
} from './prospect-native-writer-agent'

export type SalesActor =
  | { type: 'HUMAN' | 'SYSTEM'; role: 'PLATFORM_ADMIN'; id: string }
  | NativeSalesWriterAgentActor
export type ComponentOutput = Record<string, unknown>
export const TEMPORARY_REPLY_RECIPE = 'torchiko.temporary-reply-preparation/1'
export type NativeWritingReference = {
  label: string
  sourceRef: string
  text: string
  sha256: string
}

/** Exact selected text is retained under the existing preparation owner. No
 * document-format requirement, source-path read, approval lookup or source promotion. */
export function bindNativeWritingReference(value: NativeWritingReference, actor: SalesActor) {
  if (actor.type === 'AGENT') assertIssuedNativeSalesWriterAgent(actor)
  else requireSalesOperator(actor)
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'label,sha256,sourceRef,text' ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label.length > 200 ||
    typeof value.sourceRef !== 'string' ||
    !value.sourceRef.trim() ||
    value.sourceRef.length > 1000 ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    value.text.length > 20_000 ||
    value.text.includes('\0') ||
    Buffer.byteLength(value.text, 'utf8') > 32_000 ||
    createHash('sha256').update(value.text, 'utf8').digest('hex') !== value.sha256
  )
    throw new ProspectSalesError(
      'INVALID_INPUT',
      'WRITING_REFERENCE_BYTES_MISMATCH: supply bounded exact text and its SHA-256',
    )
  return {
    ...value,
    scope: 'WRITING_GUIDANCE_ONLY_NOT_VENUE_EVIDENCE_OR_APPROVED_LANGUAGE',
    submittedBy: { type: actor.type, id: actor.id },
    authenticatedAuthorship: false,
    approvedReusableLanguage: false,
    SEND_AUTHORIZED: false,
  }
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProspectSalesError('INVALID_INPUT', 'Expected a bound component object')
  return value as Record<string, unknown>
}
const maybeObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Gmail TEMPORARY bodies belong only to canonical correspondence storage. A
 * preparation retains hashes and identities, while task reads rebuild the
 * body-bearing writer context from the still-current, unexpired source. */
export function compactTemporaryReplyPreparation(component: ComponentOutput): ComponentOutput {
  const correspondence = maybeObject(component.correspondence)
  const snapshot = maybeObject(correspondence.snapshot)
  if (maybeObject(snapshot.provider).name !== 'gmail') return component
  const preparation = maybeObject(component.preparation)
  const metadata = maybeObject(preparation.metadata)
  const context = maybeObject(preparation.writerContext)
  const projection = maybeObject(correspondence.projection)
  if (
    !preparation.fileSha256s ||
    !context.WLT_packet_identity ||
    !projection.thread_id ||
    !projection.reply_to_message_id
  )
    throw new ProspectSalesError('CONFLICT', 'TEMPORARY_REPLY_RECIPE_INCOMPLETE')
  return {
    schema: component.schema,
    nativeSnapshotHash: component.nativeSnapshotHash,
    SEND_AUTHORIZED: false,
    senderAvailable: false,
    blocker: null,
    gate: { decision: maybeObject(component.gate).decision, can_prepare: true },
    crosswalk: component.crosswalk,
    componentCodeHashes: component.componentCodeHashes,
    correspondence: {
      projection: {
        thread_id: projection.thread_id,
        snapshot_sha256: projection.snapshot_sha256,
        reply_to_message_id: projection.reply_to_message_id,
      },
      snapshot: { sha256: salesHash(snapshot) },
    },
    preparation: {
      metadata: { preparation_id: metadata.preparation_id, SEND_AUTHORIZED: false },
      request: {
        mode: maybeObject(preparation.request).mode,
        purpose: maybeObject(preparation.request).purpose,
      },
      writerContext: {
        WLT_packet_identity: context.WLT_packet_identity,
        approved_language_snapshot: context.approved_language_snapshot,
        research_snapshot: context.research_snapshot,
        writer_context_sha256: context.writer_context_sha256,
        synthetic: false,
      },
      fileSha256s: preparation.fileSha256s,
      businessFreshnessReviewDueAt: preparation.businessFreshnessReviewDueAt,
      answerText: preparation.answerText,
      SEND_AUTHORIZED: false,
    },
    retentionRecipe: {
      schema: TEMPORARY_REPLY_RECIPE,
      correspondenceSnapshotSha256: salesHash(snapshot),
      projectionSha256: salesHash(projection),
      sourcePolicy: 'TRANSIENT_FROM_CURRENT_CANONICAL_BODY_ONLY',
    },
  }
}

export function requireCurrentTemporaryReply(
  stored: ComponentOutput,
  current: ComponentOutput,
): void {
  if (maybeObject(stored.retentionRecipe).schema !== TEMPORARY_REPLY_RECIPE) return
  const prepared = maybeObject(current.preparation)
  const correspondence = maybeObject(current.correspondence)
  const recipe = maybeObject(stored.retentionRecipe)
  if (
    current.nativeSnapshotHash !== stored.nativeSnapshotHash ||
    current.blocker ||
    maybeObject(current.gate).can_prepare !== true ||
    salesHash(prepared.fileSha256s) !== salesHash(maybeObject(stored.preparation).fileSha256s) ||
    salesHash(correspondence.snapshot) !== recipe.correspondenceSnapshotSha256 ||
    salesHash(correspondence.projection) !== recipe.projectionSha256 ||
    salesHash(current.componentCodeHashes) !== salesHash(stored.componentCodeHashes)
  )
    throw new ProspectSalesError('CONFLICT', 'TEMPORARY_REPLY_SOURCE_STALE_OR_EXPIRED')
}
export function requireSalesOperator(
  actor: SalesActor,
): asserts actor is Exclude<SalesActor, NativeSalesWriterAgentActor> {
  let localSynthetic = false
  if (actor.type === 'SYSTEM' && actor.id.startsWith('synthetic:crm-meaning:')) {
    try {
      const url = new URL(process.env.DATABASE_URL ?? '')
      localSynthetic =
        process.env.NODE_ENV !== 'production' &&
        process.env.APP_ENV !== 'production' &&
        process.env.TORCHIKO_LOCAL_CRM_SALES_ENABLED === '1' &&
        url.hostname === '127.0.0.1' &&
        url.port === '58617' &&
        url.pathname === '/pathfinder_disposable_crm_research_20260919' &&
        !url.search &&
        (!process.env.DIRECT_DATABASE_URL ||
          process.env.DIRECT_DATABASE_URL === process.env.DATABASE_URL)
    } catch {
      /* No ambient or malformed database authority. */
    }
  }
  if (
    (actor.type !== 'HUMAN' && !localSynthetic) ||
    actor.role !== 'PLATFORM_ADMIN' ||
    !actor.id.trim()
  )
    throw new ProspectSalesError(
      'FORBIDDEN',
      'A native platform operator is required; no agent approval is inferred',
    )
}
function requireCurrent(actual: string, expected: string) {
  if (actual !== expected)
    throw new ProspectSalesError(
      'CONFLICT',
      'STALE_NATIVE_SNAPSHOT: prospect, contact, source or thread changed; reload and prepare again',
    )
}
function requirePrepared(component: ComponentOutput, hash: string) {
  if (
    component.schema !== 'torchiko.native-sales-components/1' ||
    component.SEND_AUTHORIZED !== false ||
    component.senderAvailable !== false ||
    component.nativeSnapshotHash !== hash ||
    object(component.gate).can_prepare !== true ||
    !component.preparation ||
    component.blocker
  )
    throw new ProspectSalesError(
      'INVALID_INPUT',
      'The original components did not produce an eligible no-send preparation',
    )
  const preparation = object(component.preparation)
  const metadata = object(preparation.metadata)
  if (preparation.SEND_AUTHORIZED !== false || metadata.SEND_AUTHORIZED !== false)
    throw new ProspectSalesError('FORBIDDEN', 'NO_SEND invariant violated')
  return { preparation, crosswalk: object(component.crosswalk) }
}

export async function persistNativeSalesPreparation(
  input: {
    venueId: string
    expectedSnapshotHash: string
    component: ComponentOutput
    actor: SalesActor
    writingReference?: NativeWritingReference
    launchAttachments?: VenueLaunchAsset[]
  },
  client: SalesClient = db,
) {
  if (input.actor.type === 'AGENT') assertIssuedNativeSalesWriterAgent(input.actor)
  else requireSalesOperator(input.actor)
  let component = { ...input.component }
  delete component.contactCandidates // Native records remain native; no redundant contact copy.
  delete component.draftCheck
  delete component.meaningCheck
  // Never accept an attached reference from a component/model result. The
  // explicit operator input is a distinct, attributed channel.
  delete component.writingReference
  delete component.launchAttachments // Model/component output cannot supply attachment bytes.
  component = compactTemporaryReplyPreparation(component)
  if (input.writingReference)
    component.writingReference = bindNativeWritingReference(input.writingReference, input.actor)
  const launchAttachments = parseVenueLaunchAttachments(input.launchAttachments)
  if (launchAttachments.length) component.launchAttachments = launchAttachments
  const id = 'sales-prep_' + salesHash({ storage: SALES_COMPONENT_STORAGE, component }).slice(0, 40)
  return client.$transaction(
    async (tx) => {
      const native = await readNativeSalesSnapshot(input.venueId, tx)
      await requireCurrentProspectLaunchAttachments(input.venueId, launchAttachments, tx)
      if (input.actor.type === 'AGENT')
        await revalidateNativeSalesWriterAgent(
          input.actor,
          native.venue.id,
          native.organization.id,
          tx,
        )
      requireCurrent(native.snapshotHash, input.expectedSnapshotHash)
      if (native.suppression.blocked)
        throw new ProspectSalesError('SUPPRESSED', 'Native suppression wins before preparation')
      const { crosswalk } = requirePrepared(component, native.snapshotHash)
      await requireNativeSalesRouteClear(crosswalk.routing, tx)
      if (
        crosswalk.nativeVenueId !== native.venue.id ||
        crosswalk.nativeOrganizationId !== native.organization.id
      )
        throw new ProspectSalesError('CONFLICT', 'Native/component crosswalk changed')
      const old = await tx.prospectSourceEvidence.findUnique({ where: { id } })
      if (old) {
        const oldComponent = decodeSalesComponent(old.capturedValue)
        if (salesHash(oldComponent) !== salesHash(component)) {
          const differences = (a: unknown, b: unknown, path = ''): string[] => {
            if (salesHash(a ?? null) === salesHash(b ?? null)) return []
            if (a && b && typeof a === 'object' && typeof b === 'object') {
              const left = a as Record<string, unknown>,
                right = b as Record<string, unknown>
              return [...new Set([...Object.keys(left), ...Object.keys(right)])]
                .flatMap((key) => differences(left[key], right[key], `${path}.${key}`))
                .slice(0, 8)
            }
            return [`${path} (${typeof a} → ${typeof b})`]
          }
          const changed = differences(oldComponent, component)
          throw new ProspectSalesError(
            'CONFLICT',
            `Preparation identity collision at fields: ${changed.join(', ')}`,
          )
        }
        return old
      }
      const saved = await tx.prospectSourceEvidence.create({
        data: {
          id,
          organizationId: native.organization.id,
          venueId: native.venue.id,
          contactId:
            typeof crosswalk.nativeContactId === 'string' ? crosswalk.nativeContactId : null,
          sourceType: SALES_PREPARATION_SOURCE,
          sourceLabel: 'Derived NO-SEND writing context — not new website or contact verification',
          capturedValue: json(encodeSalesComponent(component)),
          createdBy: input.actor.id,
        },
      })
      await tx.prospectActivity.create({
        data: {
          organizationId: native.organization.id,
          venueId: native.venue.id,
          type: 'NOTE_ADDED',
          summary: 'Source-bound sales writing context prepared — NO SEND',
          evidence: {
            preparationId: id,
            snapshotHash: native.snapshotHash,
            recordedByType: input.actor.type,
            syntheticOperator: input.actor.type === 'SYSTEM',
            SEND_AUTHORIZED: false,
          },
          actorId: input.actor.id,
        },
      })
      return saved
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  )
}

export type NativeSalesDraftInput = {
  venueId: string
  preparationId: string
  expectedSnapshotHash: string
  expectedDraftId: string | null
  subject: string
  body: string
  component: ComponentOutput
  actor: SalesActor
  writerProvenance?: {
    taskId: string
    resultHash: string
    generatedBy: { kind: 'model'; identity: string }
    annotations: unknown[]
  }
}

export async function saveNativeSalesDraft(input: NativeSalesDraftInput, client: SalesClient = db) {
  requireSalesOperator(input.actor)
  return client.$transaction((tx) => saveNativeSalesDraftInTransaction(input, tx), {
    isolationLevel: 'Serializable',
    timeout: 15_000,
  })
}

/** Shared transaction entrypoint: same checks and owner, atomic writer import. */
export async function saveNativeSalesDraftInTransaction(
  input: NativeSalesDraftInput,
  tx: SalesTransaction,
) {
  if (input.actor.type === 'AGENT') {
    if (!input.writerProvenance)
      throw new ProspectSalesError(
        'FORBIDDEN',
        'Native agent drafts require the exact writer import provenance',
      )
    assertIssuedNativeSalesWriterAgent(input.actor)
  } else requireSalesOperator(input.actor)
  if (
    !input.subject.trim() ||
    input.subject.length > 160 ||
    /[\r\n\0]/u.test(input.subject) ||
    !input.body.trim() ||
    input.body.length > 12_000 ||
    /[\r\0]/u.test(input.body)
  )
    throw new ProspectSalesError(
      'INVALID_INPUT',
      'A bounded exact subject and normal message body are required',
    )
  const native = await readNativeSalesSnapshot(input.venueId, tx)
  if (input.actor.type === 'AGENT')
    await revalidateNativeSalesWriterAgent(input.actor, native.venue.id, native.organization.id, tx)
  requireCurrent(native.snapshotHash, input.expectedSnapshotHash)
  if (native.suppression.blocked)
    throw new ProspectSalesError('SUPPRESSED', 'Native suppression wins before draft preparation')
  const { preparation, crosswalk } = requirePrepared(input.component, native.snapshotHash)
  await requireNativeSalesRouteClear(crosswalk.routing, tx)
  const source = await tx.prospectSourceEvidence.findUnique({
    where: { id: input.preparationId },
  })
  if (
    !source ||
    source.venueId !== native.venue.id ||
    source.sourceType !== SALES_PREPARATION_SOURCE
  )
    throw new ProspectSalesError('NOT_FOUND', 'Native preparation not found for this venue')
  const previousComponent = decodeSalesComponent(source.capturedValue)
  const launchAttachments = await requireCurrentProspectLaunchAttachments(
    input.venueId,
    launchAttachmentsFromSnapshot(previousComponent),
    tx,
  )
  requireCurrentTemporaryReply(previousComponent, input.component)
  if (
    previousComponent.nativeSnapshotHash !== native.snapshotHash ||
    salesHash(object(previousComponent.preparation).fileSha256s) !==
      salesHash(preparation.fileSha256s) ||
    salesHash(previousComponent.componentCodeHashes) !==
      salesHash(input.component.componentCodeHashes)
  )
    throw new ProspectSalesError(
      'CONFLICT',
      'STALE_COMPONENT_PREPARATION: source, WLT, language or component changed',
    )
  const route = object(crosswalk.routing)
  const correspondence = input.component.correspondence
    ? object(input.component.correspondence)
    : null
  const projection = correspondence ? object(correspondence.projection) : null
  const series = salesHash({
    venueId: native.venue.id,
    routingId: route.routing_id,
    mode: object(preparation.request).mode,
    threadId: projection?.thread_id ?? null,
    latestInboundId: projection?.reply_to_message_id ?? null,
  })
  const latest = await tx.prospectOutreachDraft.findFirst({
    where: { preparationKey: series },
    orderBy: { version: 'desc' },
  })
  if ((latest?.id ?? null) !== input.expectedDraftId)
    throw new ProspectSalesError(
      'CONFLICT',
      'STALE_DRAFT_REVISION: another revision exists; reload before editing',
    )
  const contentHash = salesHash({
    series,
    subject: input.subject,
    body: input.body,
    preparationId: input.preparationId,
    route,
    nativeSnapshotHash: native.snapshotHash,
    ...(launchAttachments.length
      ? { launchAttachmentsSha256: launchAttachmentsSha256(launchAttachments) }
      : {}),
  })
  if (latest?.contentHash === contentHash) {
    const previousWriter = object(latest.groundingSnapshot).writerProvenance
    // Equal message bytes cannot silently relabel a manual draft as AI-written
    // or attach a different generator/assessment to an older immutable revision.
    if (
      !input.writerProvenance ||
      (previousWriter &&
        salesHash({ ...object(previousWriter), submittedBy: undefined }) ===
          salesHash(input.writerProvenance))
    )
      return latest
  }
  const version = (latest?.version ?? 0) + 1
  const check = object(input.component.draftCheck)
  const composerHash = createHash('sha256')
    .update(`Subject: ${input.subject}\n\n${input.body}\n`)
    .digest('hex')
  const bodyHash = createHash('sha256').update(input.body).digest('hex')
  if (
    check.composerDraftSha256 !== composerHash ||
    check.bodySha256 !== bodyHash ||
    check.SEND_AUTHORIZED !== false
  )
    throw new ProspectSalesError('CONFLICT', 'Draft check is not bound to these exact bytes')
  const saved = await tx.prospectOutreachDraft.create({
    data: {
      id: 'sales-draft_' + salesHash({ series, version, contentHash }).slice(0, 40),
      preparationKey: series,
      campaignId: null,
      memberId: null,
      organizationId: native.organization.id,
      venueId: native.venue.id,
      contactId: typeof crosswalk.nativeContactId === 'string' ? crosswalk.nativeContactId : null,
      toEmail:
        route.kind === 'email' && typeof route.recipient === 'string' ? route.recipient : null,
      subject: input.subject,
      textBody: input.body,
      version,
      contentHash,
      groundingSnapshot: json({
        schema: 'torchiko.native-sales-draft/1',
        ...(launchAttachments.length ? { launchAttachments } : {}),
        preparationId: input.preparationId,
        nativeSnapshotHash: native.snapshotHash,
        crosswalk,
        componentFileSha256s: preparation.fileSha256s,
        threadSnapshotSha256: projection?.snapshot_sha256 ?? null,
        replyToMessageId: projection?.reply_to_message_id ?? null,
        WLT_packet_identity: object(preparation.writerContext).WLT_packet_identity,
        approvedLanguageSnapshot: object(preparation.writerContext).approved_language_snapshot,
        composerDraftSha256: composerHash,
        WLTBodySha256: bodyHash,
        check,
        checkJson: JSON.stringify(check),
        previousDraftId: latest?.id ?? null,
        previousContentHash: latest?.contentHash ?? null,
        humanApproval: 'ABSENT',
        ...(input.writerProvenance
          ? { writerProvenance: { ...input.writerProvenance, submittedBy: input.actor } }
          : {}),
        SEND_AUTHORIZED: false,
      }),
      escalationFlags: ['PERMANENT_NO_SEND', 'MEANING_REVIEW_REQUIRED'],
      generatedByType: input.writerProvenance ? 'AGENT' : input.actor.type,
      generatedById: input.writerProvenance?.generatedBy.identity ?? input.actor.id,
    },
  })
  await tx.prospectActivity.create({
    data: {
      organizationId: native.organization.id,
      venueId: native.venue.id,
      contactId: saved.contactId,
      type: 'OUTREACH_DRAFTED',
      summary: projection
        ? 'Proposed response revision recorded — NO SEND'
        : 'Outreach revision recorded — NO SEND',
      evidence: {
        draftId: saved.id,
        version,
        contentHash,
        preparationId: input.preparationId,
        recordedByType: input.actor.type,
        syntheticOperator: input.actor.type === 'SYSTEM',
        SEND_AUTHORIZED: false,
      },
      actorId: input.actor.id,
    },
  })
  return saved
}

export async function reviewNativeSalesDraft(
  input: {
    venueId: string
    draftId: string
    contentHash: string
    expectedSnapshotHash: string
    actor: SalesActor
  },
  client: SalesClient = db,
) {
  requireSalesOperator(input.actor)
  return client.$transaction(
    async (tx) => {
      const native = await readNativeSalesSnapshot(input.venueId, tx)
      requireCurrent(native.snapshotHash, input.expectedSnapshotHash)
      if (native.suppression.blocked)
        throw new ProspectSalesError(
          'SUPPRESSED',
          'Native hold prevents ordinary review progression',
        )
      const draft = await tx.prospectOutreachDraft.findUnique({ where: { id: input.draftId } })
      if (
        !draft?.preparationKey ||
        draft.venueId !== native.venue.id ||
        draft.contentHash !== input.contentHash
      )
        throw new ProspectSalesError(
          'CONFLICT',
          'Review must identify this exact native no-send revision and content hash',
        )
      await requireCurrentProspectLaunchAttachments(
        input.venueId,
        launchAttachmentsFromSnapshot(draft.groundingSnapshot),
        tx,
      )
      await requireNativeSalesRouteClear(
        object(object(draft.groundingSnapshot).crosswalk).routing,
        tx,
      )
      const latest = await tx.prospectOutreachDraft.findFirst({
        where: { preparationKey: draft.preparationKey },
        orderBy: { version: 'desc' },
      })
      if (
        latest?.id !== draft.id ||
        object(draft.groundingSnapshot).nativeSnapshotHash !== native.snapshotHash
      )
        throw new ProspectSalesError(
          'CONFLICT',
          'STALE_REVIEW: a newer draft or thread/source snapshot exists',
        )
      const id =
        'sales-review_' +
        salesHash({
          draftId: draft.id,
          contentHash: draft.contentHash,
          actor: input.actor.id,
        }).slice(0, 40)
      const old = await tx.prospectActivity.findUnique({ where: { id } })
      if (old) return old
      return tx.prospectActivity.create({
        data: {
          id,
          organizationId: native.organization.id,
          venueId: native.venue.id,
          contactId: draft.contactId,
          type: 'NOTE_ADDED',
          summary: 'Exact draft marked reviewed — NOT approved for sending',
          evidence: {
            schema: 'torchiko.native-sales-review/1',
            draftId: draft.id,
            contentHash: draft.contentHash,
            version: draft.version,
            nativeSnapshotHash: native.snapshotHash,
            state: 'REVIEWED_NO_SEND',
            reviewScope: 'OPERATOR_READ_REVIEW_NOT_COMPOSER_SEMANTIC_CERTIFICATION',
            operatorId: input.actor.id,
            recordedByType: input.actor.type,
            syntheticOperator: input.actor.type === 'SYSTEM',
            humanApproval: 'ABSENT',
            SEND_AUTHORIZED: false,
          },
          actorId: input.actor.id,
        },
      })
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  )
}

export async function readNativeSalesReviewState(venueId: string, client: SalesClient = db) {
  const [preparations, drafts, reviews] = await Promise.all([
    client.prospectSourceEvidence.findMany({
      where: { venueId, sourceType: SALES_PREPARATION_SOURCE },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    }),
    client.prospectOutreachDraft.findMany({
      where: { venueId, preparationKey: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
    client.prospectActivity.findMany({
      where: { venueId, evidence: { path: ['schema'], equals: 'torchiko.native-sales-review/1' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    }),
  ])
  return salesJson({ preparations, drafts, reviews })
}
