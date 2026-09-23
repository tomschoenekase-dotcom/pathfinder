import { z } from 'zod'
import { createHash } from 'node:crypto'

export const OUTREACH_COHORT_LIMIT = 50
export const OUTREACH_WINDOW_LIMIT = 5
const id = z.string().trim().min(1).max(191)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
export const cohortSelectionInput = z.object({ venueId: id, contactId: id.nullable() }).strict()
export const outreachCohortPreviewInput = z.object({
  question: z.string().trim().min(12).max(2000),
  candidates: z.array(cohortSelectionInput).min(1).max(200),
  count: z.number().int().min(1).max(OUTREACH_COHORT_LIMIT).default(50),
  excludePriorGroups: z.literal(true),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.candidates.map(c => c.venueId)).size !== input.candidates.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Candidate venue IDs must be unique.' })
})
export const outreachCohortReserveInput = z.object({
  requestKey: id, name: z.string().trim().min(3).max(191),
  preview: outreachCohortPreviewInput, expectedPreviewHash: hash,
}).strict()
export const outreachCohortReadInput = z.object({ cohortId: id }).strict()
export const outreachCohortListInput = z.object({ limit: z.number().int().min(1).max(50).default(25), cursor: id.optional() }).strict()
export const outreachCohortWindowInput = z.object({
  cohortId: id, requestKey: id, limit: z.number().int().min(1).max(OUTREACH_WINDOW_LIMIT).default(5),
  leaseSeconds: z.number().int().min(60).max(900).default(600),
}).strict()
export const outreachCohortCheckpointInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepared'), cohortId: id, memberId: id,
    leaseToken: z.string().uuid(), taskId: id, preparationId: id }).strict(),
  z.object({ action: z.literal('imported'), cohortId: id, memberId: id,
    leaseToken: z.string().uuid(), receiptId: id, draftId: id }).strict(),
  z.object({ action: z.literal('hold'), cohortId: id, memberId: id,
    leaseToken: z.string().uuid(), reason: z.string().trim().min(12).max(2000) }).strict(),
  z.object({ action: z.literal('release'), cohortId: id, memberId: id,
    leaseToken: z.string().uuid(), reason: z.string().trim().min(12).max(2000) }).strict(),
  z.object({ action: z.literal('resume'), cohortId: id, memberId: id,
    expectedSelectionHash: hash, reason: z.string().trim().min(12).max(2000) }).strict(),
])
export const outreachCohortControlInput = z.object({
  cohortId: id, requestKey: id, expectedReviewHash: hash,
  action: z.enum(['pause', 'resume', 'cancel']),
  reason: z.string().trim().min(12).max(2000),
}).strict()
export const outreachCohortControlReceipt = z.object({
  cohortId: id, receiptId: id, status: z.enum(['DRAFT', 'PAUSED', 'CANCELLED']),
  reason: z.string(), retainedMembers: z.number().int().min(1).max(50),
  priorGroupExclusionRetained: z.literal(true), draftsDeleted: z.literal(false),
  deliveryChanged: z.literal(false), replayed: z.literal(false), SEND_AUTHORIZED: z.literal(false),
}).strict()
export const outreachCohortAcknowledgeInput = z.object({
  cohortId: id, expectedReviewHash: hash, expectedCount: z.number().int().min(1).max(50),
  acknowledgement: z.literal('I reviewed these exact messages and holds. This is not sending approval.'),
}).strict()

export function cohortHash(value: unknown): string {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
    if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`
    return JSON.stringify(v) ?? 'null'
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export const cohortObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export type CohortCandidate = {
  venueId: string; organizationId: string; name: string;
  contactId: string | null; recipient: string | null;
  city: string | null; region: string | null;
  geographyStatus: string | null; countyGeoid: string | null;
  size: string | null; sizeVerified: boolean;
  relationshipTier: string; opportunityStage: string | null;
  nativeSnapshotHash: string; currentDraftId: string | null;
  sourceIds: string[]; sourceCount: number;
  suppressed: boolean; suppressionReasons: string[];
  history: 'NO_RETAINED_HISTORY' | 'RETAINED_HISTORY' | 'INCOMPLETE_OR_UNAVAILABLE';
  identityReviewOpen: boolean; priorGroupIds: string[]; priorContactReservation: boolean;
  contactSelected: boolean; contactVerified: boolean;
}
export type CohortPreviewRow = CohortCandidate & {
  disposition: 'ELIGIBLE' | 'HELD' | 'EXCLUDED'; reasons: string[]; selected: boolean;
}

/** Selection never upgrades a source fact, contact permission, or relationship.
 * Unknown size and history are visible holds, not invented eligibility. */
export function planOutreachCohort(input: z.infer<typeof outreachCohortPreviewInput>, candidates: CohortCandidate[]) {
  if (candidates.length !== input.candidates.length || candidates.some((v, i) => v.venueId !== input.candidates[i]!.venueId))
    throw new Error('Exact complete candidate order is required; no missing or replacement rows.')
  const seenOrganizations = new Set<string>(), seenRecipients = new Set<string>()
  const rows: CohortPreviewRow[] = candidates.map(candidate => {
    const reasons: string[] = []
    let disposition: CohortPreviewRow['disposition'] = 'ELIGIBLE'
    const exclude = (reason: string) => { disposition = 'EXCLUDED'; reasons.push(reason) }
    const hold = (reason: string) => { if (disposition !== 'EXCLUDED') disposition = 'HELD'; reasons.push(reason) }
    const city = candidate.city?.trim().toLowerCase()
    const size = candidate.size?.trim().toLowerCase()
    const recipient = candidate.recipient?.trim().toLowerCase() ?? null
    if (!['chicago', 'evanston'].includes(city ?? '') || candidate.region?.toUpperCase() !== 'IL') exclude('OUTSIDE_CHICAGO_EVANSTON')
    if (candidate.relationshipTier !== 'STANDARD') exclude('LARGE_OR_STRATEGIC_REQUIRES_SEPARATE_SCOPE')
    if (candidate.sizeVerified && ['large', 'very large', 'enterprise'].includes(size ?? '')) exclude('NOT_SMALL_OR_MID_SIZED')
    else if (!candidate.sizeVerified || !['small', 'medium', 'mid-sized', 'mid sized'].includes(size ?? '')) hold('SIZE_NEEDS_SOURCE_REVIEW')
    if (!candidate.countyGeoid || candidate.geographyStatus !== 'ASSIGNED') hold('PHYSICAL_GEOGRAPHY_REVIEW_REQUIRED')
    if (candidate.suppressed) exclude('NATIVE_SUPPRESSION')
    if (candidate.priorGroupIds.length || candidate.priorContactReservation) exclude('ALREADY_IN_PRIOR_GROUP')
    if (candidate.currentDraftId) exclude('EXISTING_DRAFT_REOPEN_INSTEAD_OF_REDRAFT')
    if (['CONTACTED', 'REPLIED', 'CONVERSATION', 'QUALIFIED', 'PROPOSAL_DECISION', 'WON'].includes(candidate.opportunityStage ?? '') || candidate.history === 'RETAINED_HISTORY')
      exclude('EXISTING_RELATIONSHIP_USE_NATIVE_REPLY_WORKFLOW')
    if (candidate.history === 'INCOMPLETE_OR_UNAVAILABLE') hold('HISTORY_UNAVAILABLE_NOT_NO_HISTORY')
    if (candidate.identityReviewOpen) hold('IDENTITY_OR_SAME_OPERATOR_REVIEW_REQUIRED')
    if (!candidate.contactSelected || !recipient) hold('SELECT_EXACT_NATIVE_CONTACT')
    if (!candidate.contactVerified) hold('PUBLIC_ROUTE_REVIEW_REQUIRED')
    if (candidate.sourceCount === 0) hold('VENUE_CONTEXT_EVIDENCE_REQUIRED')
    if (seenOrganizations.has(candidate.organizationId)) exclude('SAME_NATIVE_ORGANIZATION_IN_THIS_GROUP')
    if (recipient && seenRecipients.has(recipient)) exclude('SAME_CONTACT_ADDRESS_IN_THIS_GROUP')
    // Hold rows are reserved too; later candidates must not silently replace them.
    if (disposition !== 'EXCLUDED') {
      seenOrganizations.add(candidate.organizationId)
      if (recipient) seenRecipients.add(recipient)
    }
    return { ...candidate, disposition, reasons, selected: false }
  })
  const ordered = [...rows.filter(r => r.disposition === 'ELIGIBLE'), ...rows.filter(r => r.disposition === 'HELD')]
  const selected = new Set(ordered.slice(0, input.count).map(r => r.venueId))
  for (const row of rows) row.selected = selected.has(row.venueId)
  const value = { schema: 'torchiko.outreach-cohort-preview/1', question: input.question,
    requestedCount: input.count, selectedCount: selected.size,
    readyForNativeGate: rows.filter(r => r.selected && r.disposition === 'ELIGIBLE').length,
    heldCount: rows.filter(r => r.selected && r.disposition === 'HELD').length,
    excludedCount: rows.filter(r => r.disposition === 'EXCLUDED').length,
    shortfall: input.count - selected.size, rows,
    notice: 'Preparation-only cohort. Every individual still requires the existing native research/writer gate and human message review.',
    SEND_AUTHORIZED: false as const }
  return { ...value, previewHash: cohortHash(value) }
}

export type CohortMemberState = {
  schema: 'torchiko.outreach-cohort-member/1'; revision: number;
  state: 'RESERVED' | 'HELD' | 'RELEASED' | 'PREPARING' | 'IMPORT_RECOVERY_REQUIRED' | 'REVIEW_REQUIRED';
  selection: CohortPreviewRow; reasons: string[];
  lease: { token: string; actorId: string; runId: string; expiresAt: string } | null;
  task: { id: string; preparationId: string } | null;
  draft: { id: string; receiptId: string; version: number; contentHash: string } | null;
  attempt: number;
}
export function readCohortMemberState(value: unknown): CohortMemberState {
  const raw = cohortObject(value)
  const selection = cohortObject(raw.selection), lease = cohortObject(raw.lease)
  if (raw.schema !== 'torchiko.outreach-cohort-member/1' || !Number.isInteger(raw.revision) || Number(raw.revision) < 1 ||
      !Number.isInteger(raw.attempt) || Number(raw.attempt) < 0 ||
      !['RESERVED', 'HELD', 'RELEASED', 'PREPARING', 'IMPORT_RECOVERY_REQUIRED', 'REVIEW_REQUIRED'].includes(String(raw.state)) ||
      !id.safeParse(selection.venueId).success || !id.safeParse(selection.organizationId).success ||
      !hash.safeParse(selection.nativeSnapshotHash).success || !Array.isArray(raw.reasons) ||
      raw.reasons.some(reason => typeof reason !== 'string') ||
      (raw.lease !== null && (!z.string().uuid().safeParse(lease.token).success || !id.safeParse(lease.actorId).success ||
        !id.safeParse(lease.runId).success || typeof lease.expiresAt !== 'string' || !Number.isFinite(Date.parse(lease.expiresAt)))) ||
      (raw.task !== null && (!id.safeParse(cohortObject(raw.task).id).success || !id.safeParse(cohortObject(raw.task).preparationId).success)) ||
      (raw.draft !== null && (!id.safeParse(cohortObject(raw.draft).id).success || !id.safeParse(cohortObject(raw.draft).receiptId).success ||
        !hash.safeParse(cohortObject(raw.draft).contentHash).success || !Number.isInteger(cohortObject(raw.draft).version))))
    throw new Error('Unsupported native campaign member selection; original value preserved.')
  return raw as unknown as CohortMemberState
}
