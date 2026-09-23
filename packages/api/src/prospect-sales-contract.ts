import { VenueLaunchAssetSelectionSchema, type VenueLaunchAssetDescriptor } from '@pathfinder/contracts/venue-launch-asset'
import { z } from 'zod'
import { writerImportInput } from './prospect-writer-contract'
import { firstSendActionShapes, type NativeOperationalView } from './prospect-first-send-contract'
import type { NativeWriterTask } from '@pathfinder/db'
import { evidenceAdmissionInput, type EvidenceAdmissionView } from './prospect-evidence-contract'
export type {
  EvidenceAdmissionView,
  EvidenceCaptureView,
  EvidenceSelection,
} from './prospect-evidence-contract'
import { salesMeaningInput, type MeaningReviewView } from './prospect-meaning-contract'
export { claimCategories } from './prospect-meaning-contract'
export type {
  ClaimAnnotation,
  MeaningAssessment,
  MeaningSourceClaim,
  MeaningReviewView,
  SalesMeaningInput,
} from './prospect-meaning-contract'

const id = z.string().min(1).max(191)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
/** Optional exact writing guidance. Its sourceRef is attribution, never a path
 * to fetch, a verified venue claim, a phrase-library approval or send authority. */
export const writingReferenceInput = z.object({
  label: z.string().trim().min(1).max(200),
  sourceRef: z.string().trim().min(1).max(1000),
  text: z.string().min(1).max(20_000).refine((value) =>
    !value.includes('\0') && new TextEncoder().encode(value).length <= 32_000),
  sha256: hash,
}).strict()
export const salesReadInput = z.object({ venueId: id }).strict()
export const salesPrepareInput = z
  .object({
    venueId: id,
    expectedSnapshotHash: hash,
    answerText: z.string().min(12).max(2000).optional(),
    selectedThreadId: id.optional(),
    writingReference: writingReferenceInput.optional(),
    /** Explicit server-side selection; never a default or a caller-supplied path. */
    launchAssetSelection: VenueLaunchAssetSelectionSchema.optional(),
    savedWritingGuide: z.literal('torchiko-v0.2').optional(),
    expectedWritingGuideSha256: hash.optional(),
  })
  .strict()
export const salesSaveInput = z
  .object({
    venueId: id,
    preparationId: id,
    expectedSnapshotHash: hash,
    expectedDraftId: id.nullable(),
    subject: z.string().min(1).max(160),
    body: z.string().min(1).max(12000),
  })
  .strict()
export const salesReviewInput = z
  .object({ venueId: id, draftId: id, contentHash: hash, expectedSnapshotHash: hash })
  .strict()
export const salesLocalAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), input: salesPrepareInput }).strict(),
  z.object({ action: z.literal('save'), input: salesSaveInput }).strict(),
  z.object({ action: z.literal('review'), input: salesReviewInput }).strict(),
  z.object({ action: z.literal('meaning'), input: salesMeaningInput }).strict(),
  z.object({ action: z.literal('admitEvidence'), input: evidenceAdmissionInput }).strict(),
  z.object({ action: z.literal('importWriterResult'), input: writerImportInput }).strict(),
  ...firstSendActionShapes,
])
export type NativeSalesAction = z.infer<typeof salesLocalAction>

export interface SalesWorkflowView {
  launchAssets?: { available: VenueLaunchAssetDescriptor[]; hold: string | null }
  recordContext?: import('./prospect-sales-read-view').NativeCrmReadView
  operational?: NativeOperationalView | null
  writerTask?: NativeWriterTask | null
  writerHold?: string | null
  evidenceAdmission?: EvidenceAdmissionView | null
  claimReview?: MeaningReviewView | null
  venueId: string
  organizationId: string
  name: string
  snapshotHash: string
  sourceCount: number
  sourceState: string
  contacts: {
    id: string
    name: string | null
    email: string | null
    readiness: string
    permission: string
  }[]
  gate: {
    decision: string
    canPrepare: boolean
    questions: { id: string; question: string; why: string }[]
    humanQuestions: string[]
    notices: string[]
  }
  routing: {
    kind: string
    value: string | null
    publicSnapshotStatus: string
    nativeContactId: string | null
    readiness: string
    permission: string
  } | null
  suppression: { blocked: boolean; reasons: string[] }
  outreachState: string
  correspondenceState: string
  correspondence: {
    threadId: string
    relationship: string
    action: string
    synthetic: boolean
    latestInbound: { id: string; body: string; subject: string } | null
    points: string[]
    issues: string[]
  } | null
  threadCandidates: {
    id: string
    messageCount: number
    updatedAt: string
    sourceComplete: boolean
    sourceIssues: string[]
  }[]
  preparation: {
    id: string
    stale: boolean
    why: string
    expectedDraftId: string | null
    writerMarkdown: string
    approvedCount: number
    selectedCount: number
    wltIdentity: string
    writingReference?: z.infer<typeof writingReferenceInput> | null
    launchAttachments?: VenueLaunchAssetDescriptor[]
  } | null
  draft: {
    id: string
    version: number
    subject: string
    body: string
    contentHash: string
    state: string
    preparationId: string
    warnings: string[]
    previousDraftId: string | null
    launchAttachments?: VenueLaunchAssetDescriptor[]
    writerAttribution?: {
      generatedByKind: 'model'
      generatedBy: string
      submittedBy: string
      taskId: string
      resultHash: string
    } | null
  } | null
  revisions: { id: string; version: number; contentHash: string; reviewed: boolean }[]
  writerImportReceipt?: {
    id: string
    draftId: string
    meaningReviewId: string | null
    replayed: boolean
  } | null
  blocker: string | null
  SEND_AUTHORIZED: false
  senderAvailable: false
}

/** Exact committed import can be acknowledged even when the current CRM view
 * cannot be projected. This is historical receipt evidence, never fresh context. */
export type WriterImportReceiptOnly = {
  schema: 'torchiko.native-writer-import-receipt-only/1'
  venueId: string
  originalSnapshotHash: string
  writerImportReceipt: {
    id: string
    draftId: string
    meaningReviewId: string | null
    replayed: boolean
  }
  currentViewAvailable: false
  /** A bounded diagnostic; historical persistence is independent of fresh-view validity. */
  currentViewFailure?: 'RECORD_NOT_FOUND' | 'STATE_CONFLICT' | 'ACCESS_OR_POLICY_HOLD' | 'READ_FAILED'
  SEND_AUTHORIZED: false
  senderAvailable: false
}
export type SalesActionResponse = SalesWorkflowView | WriterImportReceiptOnly
