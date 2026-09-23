import type { Prisma } from '@prisma/client'
import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  requireSalesOperator,
  type ComponentOutput,
  type SalesActor,
} from './prospect-sales-actions'
import {
  decodeSalesComponent,
  encodeSalesComponent,
  ProspectSalesError,
  readNativeSalesSnapshot,
  requireNativeSalesRouteClear,
  salesHash,
  type SalesClient,
} from './prospect-sales-snapshot'

export const NATIVE_CAPTURE_SOURCE = 'CRM_NATIVE_SOURCE_CAPTURE_V1'
export const NATIVE_SELECTION_SOURCE = 'CRM_NATIVE_SOURCE_SELECTION_V1'
export type NativeEvidenceSelection = {
  claimIds: string[]
  routeClaimId: string | null
  purpose: string
  hypothesis: string
}
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const required = (test: unknown, message: string) => {
  if (!test) throw new ProspectSalesError('CONFLICT', message)
}
function localOnly(actor: SalesActor) {
  requireSalesOperator(actor)
  const url = new URL(process.env.DATABASE_URL ?? 'https://invalid')
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_LOCAL_CRM_SALES_ENABLED !== '1' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '58617' ||
    url.pathname !== '/pathfinder_disposable_crm_research_20260919' ||
    url.search ||
    process.env.APP_ENV === 'production' ||
    (process.env.DIRECT_DATABASE_URL &&
      process.env.DIRECT_DATABASE_URL !== process.env.DATABASE_URL)
  )
    throw new ProspectSalesError(
      'FORBIDDEN',
      'Native evidence admission is restricted to the retained local CRM',
    )
}
function checkedOwner(component: ComponentOutput, snapshot: string) {
  required(
    component.nativeSnapshotHash === snapshot &&
      component.SEND_AUTHORIZED === false &&
      component.senderAvailable === false,
    'Evidence checker has wrong native context or authority',
  )
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/** Internal foreground source writer, intentionally not an HTTP/admin action.
 * Capture bytes must already be obtained by an explicitly authorized bounded
 * executor. This writer never fetches URLs, resolves paths or promotes contacts.
 */
export async function stageNativeSourceCapture(
  input: {
    venueId: string
    expectedSnapshotHash: string
    capture: Record<string, unknown>
    component: ComponentOutput
    actor: SalesActor
  },
  client: SalesClient = db,
) {
  localOnly(input.actor)
  const captureHash = salesHash(input.capture)
  const id = 'native-capture_' + captureHash.slice(0, 40)
  const check = obj(input.component.captureCheck)
  required(
    check.captureId === id && check.captureHash === captureHash && check.SEND_AUTHORIZED === false,
    'Source capture is not bound to the original catalog integrity check',
  )
  return client.$transaction(
    async (tx) => {
      const native = await readNativeSalesSnapshot(input.venueId, tx)
      checkedOwner(input.component, native.snapshotHash)
      required(
        obj(input.capture.identity).venueId === native.venue.id &&
          obj(input.capture.identity).organizationId === native.organization.id,
        'WRONG_NATIVE_VENUE_OR_IMPORT_LINEAGE',
      )
      const old = await tx.prospectSourceEvidence.findUnique({ where: { id } })
      if (old) {
        required(
          old.venueId === input.venueId &&
            old.sourceType === NATIVE_CAPTURE_SOURCE &&
            salesHash(decodeSalesComponent(old.capturedValue).capture) === captureHash,
          'Capture identity collision',
        )
        return old
      }
      required(
        native.snapshotHash === input.expectedSnapshotHash,
        'STALE_NATIVE_SNAPSHOT: capture cannot overwrite newer evidence',
      )
      if (native.suppression.blocked)
        throw new ProspectSalesError('SUPPRESSED', 'Native hold wins before source admission')
      const firstPage = obj((input.capture.pages as unknown[])[0])
      const saved = await tx.prospectSourceEvidence.create({
        data: {
          id,
          organizationId: native.organization.id,
          venueId: native.venue.id,
          sourceType: NATIVE_CAPTURE_SOURCE,
          sourceUrl: String(firstPage.url),
          sourceLabel:
            'Attributed official-page capture — retained for task admission; not contact permission or human verification',
          capturedValue: json(
            encodeSalesComponent({ capture: input.capture, SEND_AUTHORIZED: false }),
          ),
          researchedAt: new Date(String(firstPage.observedAt)),
          createdBy: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorType: input.actor.type,
          actorRole: input.actor.role,
          action: 'prospect.source_capture.recorded_no_send',
          targetType: 'ProspectSourceEvidence',
          targetId: id,
          afterState: {
            venueId: input.venueId,
            captureHash,
            nativeSnapshotHash: native.snapshotHash,
            producer: obj(input.capture.provenance).producer,
            syntheticRecorder: input.actor.type === 'SYSTEM',
            humanApproval: 'ABSENT',
            SEND_AUTHORIZED: false,
          },
        },
        tx,
      )
      return saved
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  )
}

/** ID-only admission through the SAME native source/audit owners. The original
 * Research Gate may keep the newly selected evidence held; selection never means
 * semantic approval, primary-source authenticity, permission or send authority.
 */
export async function admitNativeSourceSelection(
  input: {
    venueId: string
    expectedSnapshotHash: string
    expectedSelectionId: string | null
    captureId: string
    selection: NativeEvidenceSelection
    component: ComponentOutput
    actor: SalesActor
  },
  client: SalesClient = db,
) {
  localOnly(input.actor)
  const record = {
    captureId: input.captureId,
    selection: input.selection,
    previousSelectionId: input.expectedSelectionId,
    SEND_AUTHORIZED: false,
  }
  const id = 'native-selection_' + salesHash(record).slice(0, 40)
  required(
    obj(input.component.admissionCheck).selectionHash === salesHash(record) &&
      obj(input.component.admissionCheck).SEND_AUTHORIZED === false,
    'Native selection has no exact original source check',
  )
  try {
    return await client.$transaction(
      async (tx) => {
        const native = await readNativeSalesSnapshot(input.venueId, tx)
        checkedOwner(input.component, native.snapshotHash)
        const capture = await tx.prospectSourceEvidence.findUnique({
          where: { id: input.captureId },
        })
        required(
          capture?.venueId === input.venueId && capture.sourceType === NATIVE_CAPTURE_SOURCE,
          'Selected capture is not owned by this exact native prospect',
        )
        const old = await tx.prospectSourceEvidence.findUnique({ where: { id } })
        if (old) {
          required(
            old.venueId === input.venueId &&
              old.sourceType === NATIVE_SELECTION_SOURCE &&
              salesHash(decodeSalesComponent(old.capturedValue)) === salesHash(record),
            'Selection identity collision',
          )
          return old
        }
        required(
          native.snapshotHash === input.expectedSnapshotHash,
          'STALE_NATIVE_SNAPSHOT: inspect current evidence before admission',
        )
        if (native.suppression.blocked)
          throw new ProspectSalesError('SUPPRESSED', 'Native hold wins before evidence selection')
        await requireNativeSalesRouteClear(obj(input.component.crosswalk).routing, tx)
        const previous = await tx.prospectSourceEvidence.findFirst({
          where: { venueId: input.venueId, sourceType: NATIVE_SELECTION_SOURCE },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
        required(
          (previous?.id ?? null) === input.expectedSelectionId,
          'CONCURRENT_EVIDENCE_SELECTION: newer task evidence exists',
        )
        // Re-selecting unchanged current evidence is a zero-write readback, not a
        // way to renew source observation dates or erase earlier unresolved holds.
        if (previous) {
          const current = decodeSalesComponent(previous.capturedValue)
          if (
            current.captureId === input.captureId &&
            salesHash(current.selection) === salesHash(input.selection)
          )
            return previous
        }
        const saved = await tx.prospectSourceEvidence.create({
          data: {
            id,
            organizationId: native.organization.id,
            venueId: native.venue.id,
            sourceType: NATIVE_SELECTION_SOURCE,
            sourceLabel:
              'Explicit source/route selection for NO-SEND preparation — not factual or human approval',
            capturedValue: json(encodeSalesComponent(record)),
            createdBy: input.actor.id,
          },
        })
        await tx.prospectActivity.create({
          data: {
            organizationId: native.organization.id,
            venueId: native.venue.id,
            type: 'NOTE_ADDED',
            summary: 'Native source claims selected for bounded preparation — NO SEND',
            actorId: input.actor.id,
            evidence: {
              schema: 'torchiko.native-evidence-admission/1',
              selectionId: id,
              captureId: input.captureId,
              previousSelectionId: previous?.id ?? null,
              recordedByType: input.actor.type,
              syntheticRecorder: input.actor.type === 'SYSTEM',
              gateDecision: String(obj(input.component.gate).decision),
              humanApproval: 'ABSENT',
              SEND_AUTHORIZED: false,
            },
          },
        })
        await writeAuditLogStrict(
          {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            actorType: input.actor.type,
            action: 'prospect.source_selection.recorded_no_send',
            targetType: 'ProspectSourceEvidence',
            targetId: id,
            afterState: {
              captureId: input.captureId,
              selectionHash: salesHash(record),
              nativeSnapshotHash: native.snapshotHash,
              syntheticRecorder: input.actor.type === 'SYSTEM',
              humanApproval: 'ABSENT',
              SEND_AUTHORIZED: false,
            },
          },
          tx,
        )
        return saved
      },
      { isolationLevel: 'Serializable', timeout: 15_000 },
    )
  } catch (error) {
    if (['P2034', 'P2002'].includes(String(obj(error).code)))
      throw new ProspectSalesError(
        'CONFLICT',
        'CONCURRENT_EVIDENCE_SELECTION: reload the existing native evidence',
      )
    throw error
  }
}
