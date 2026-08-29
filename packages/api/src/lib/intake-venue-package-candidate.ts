import { createHash } from 'node:crypto'
import { z } from 'zod'

import { getIntakeProposalReview, onboardingBootstrapInputHash } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import {
  canonicalVenuePackagePayload,
  VenuePackagePayloadV3,
  type VenuePackagePayloadV3 as PayloadV3,
} from '../schemas/venue-package'

const scopeInput = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    runId: z.string().trim().min(1).max(191),
  })
  .strict()

const bootstrapContent = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('place'),
      value: z
        .object({
          name: z.string().trim().min(1).max(255),
          type: z.string().trim().min(1).max(100),
          shortDescription: z.string().trim().min(1).max(2_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('knowledge'),
      value: z
        .object({
          title: z.string().trim().min(1).max(255),
          category: z.string().trim().min(1).max(100),
          content: z.string().trim().min(1).max(10_000),
        })
        .strict(),
    })
    .strict(),
])

const storedBootstrap = z.object({ version: z.literal(1), content: bootstrapContent }).strict()
const storedFileExtractionReview = z
  .object({
    kind: z.literal('FILE_EXTRACTION_REVIEW'),
    sourceRunId: z.string().trim().min(1).max(191),
    receiptId: z.string().uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceMimeType: z.string().trim().min(1).max(64),
    extractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    proposalNotes: z.string().trim().min(1).max(20_000),
    proposalNotesHash: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewRationale: z.string().trim().min(1).max(500),
  })
  .strict()
export const INTAKE_CANDIDATE_MAPPING_VERSION = 1 as const

export type IntakeCandidateIssue = {
  code:
    | 'NOT_AWAITING_REVIEW'
    | 'ALREADY_LINKED'
    | 'INVALID_STORED_SOURCE'
    | 'PACKAGE_FIELD_INVALID'
    | 'INTERVIEW_DISCREPANCY'
    | 'UNKNOWN_FIELD_PATH'
    | 'NO_CANDIDATES'
  path: string
  message: string
}

export class IntakeVenuePackageCandidateError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'UNSUPPORTED_SOURCE' | 'INVALID_EVIDENCE',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeVenuePackageCandidateError'
  }
}

const interviewMappings: Readonly<Record<string, { title: string; category: string }>> = {
  'venue.identity.mission': { title: 'Venue mission and purpose', category: 'VENUE_IDENTITY' },
  'venue.guide.priorities': { title: 'Visitor guide priorities', category: 'GUIDE_PRIORITIES' },
  'knowledge.arrival': { title: 'Visitor arrival information', category: 'VISITOR_ARRIVAL' },
  'knowledge.commonQuestions': { title: 'Common visitor questions', category: 'VISITOR_FAQ' },
  'venue.operations.hours': { title: 'Operating hours and exceptions', category: 'HOURS' },
  'venue.operations.closures': {
    title: 'Planned closures and temporary changes',
    category: 'CLOSURES',
  },
  'venue.accessibility.arrival': {
    title: 'Accessible arrival routes and entrances',
    category: 'ACCESSIBILITY',
  },
  'venue.accessibility.accommodations': {
    title: 'Available visitor accommodations',
    category: 'ACCESSIBILITY',
  },
  'venue.content.voice': { title: 'Visitor guide voice', category: 'CONTENT_GUIDANCE' },
  'venue.content.terminology': {
    title: 'Preferred public names and terminology',
    category: 'CONTENT_GUIDANCE',
  },
}
const interviewFieldOrder = Object.keys(interviewMappings)
const interviewFieldRank = new Map(
  interviewFieldOrder.map((fieldPath, index) => [fieldPath, index]),
)

function deterministicUuid(namespace: string): string {
  const bytes = Buffer.from(createHash('sha256').update(namespace).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function intakeCandidateDraftKey(input: {
  tenantId: string
  venueId: string
  runId: string
  candidateHash: string
  actorId: string
}): string {
  return deterministicUuid(
    `pathfinder:intake-candidate-draft:v${INTAKE_CANDIDATE_MAPPING_VERSION}:${input.tenantId}:${input.venueId}:${input.runId}:${input.candidateHash}:${input.actorId}`,
  )
}

export async function isExactIntakeCandidateHandoff(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  draftKey: string
  candidateHash: string
  actorId: string
}): Promise<'NONE' | 'EXACT' | 'MISMATCH'> {
  const handoff = await input.db.intakePackageHandoff.findFirst({
    where: {
      runId: input.runId,
      tenantId: input.tenantId,
      venueId: input.venueId,
    },
    select: {
      createdBy: true,
      packageDraft: {
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          draftKey: true,
          payloadHash: true,
          status: true,
          createdBy: true,
        },
      },
    },
  })
  if (!handoff) return 'NONE'
  const draft = handoff?.packageDraft
  return handoff &&
    handoff.createdBy === input.actorId &&
    Boolean(draft?.id) &&
    draft.tenantId === input.tenantId &&
    draft.venueId === input.venueId &&
    draft.draftKey === input.draftKey &&
    draft.payloadHash === input.candidateHash &&
    draft.status === 'DRAFT' &&
    draft.createdBy === input.actorId
    ? 'EXACT'
    : 'MISMATCH'
}

function provenance() {
  return { sourceType: 'PATHFINDER_INTAKE', contentOrigin: 'HUMAN_AUTHORED' as const }
}

function emptyPayload(): PayloadV3 {
  return {
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: { create: [], update: [], delete: [] },
  }
}

function validationIssues(error: z.ZodError): IntakeCandidateIssue[] {
  return error.issues.map((issue) => ({
    code: 'PACKAGE_FIELD_INVALID' as const,
    path: issue.path.length ? issue.path.join('.') : 'payload',
    message: issue.message,
  }))
}

function result(
  run: { id: string; sourceKind: string; status: string },
  venueId: string,
  candidate: PayloadV3,
  issues: IntakeCandidateIssue[],
) {
  const parsed = VenuePackagePayloadV3.safeParse(candidate)
  const allIssues = parsed.success ? issues : [...issues, ...validationIssues(parsed.error)]
  const payload = allIssues.length === 0 && parsed.success ? parsed.data : null
  return {
    runId: run.id,
    sourceKind: run.sourceKind as 'STRUCTURED_BOOTSTRAP' | 'INTERVIEW',
    status: run.status,
    ready: allIssues.length === 0,
    payload,
    candidateHash: payload
      ? createHash('sha256').update(canonicalVenuePackagePayload(venueId, payload)).digest('hex')
      : null,
    issues: allIssues,
    summary: {
      candidateCount: candidate.places.create.length + candidate.knowledgeEntries.create.length,
      issueCount: allIssues.length,
    },
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
  }
}

export async function buildIntakeVenuePackageCandidate(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  /** Server-only replay path; the finalizer must still prove the exact package handoff. */
  allowExistingHandoff?: boolean
}) {
  if (!input || typeof input !== 'object' || !input.db) {
    throw new IntakeVenuePackageCandidateError('INVALID_INPUT', 'Invalid intake candidate scope')
  }
  const parsedScope = scopeInput.safeParse({
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
  })
  if (!parsedScope.success) {
    throw new IntakeVenuePackageCandidateError('INVALID_INPUT', 'Invalid intake candidate scope')
  }
  const scope = parsedScope.data
  const run = await input.db.intakeRun.findFirst({
    where: {
      id: scope.runId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      sourceKind: { in: ['STRUCTURED_BOOTSTRAP', 'INTERVIEW'] },
    },
    select: {
      id: true,
      sourceKind: true,
      status: true,
      displayName: true,
      structuredBootstrap: true,
      submissionRequestId: true,
      submissionInputHash: true,
      requestedBy: true,
      requestedByType: true,
      evidence: {
        orderBy: [{ capturedAt: 'asc' as const }, { id: 'asc' as const }],
        select: {
          sourceKind: true,
          locator: true,
          normalizedHash: true,
          confidence: true,
        },
      },
      fileExtractionProposalReview: {
        select: {
          id: true,
          sourceRunId: true,
          receiptId: true,
          requestId: true,
          requestHash: true,
          decision: true,
          expectedExtractedTextHash: true,
          proposalTitle: true,
          proposalNotes: true,
          proposalNotesHash: true,
          rationale: true,
          createdBy: true,
          receipt: {
            select: {
              sourceSha256: true,
              sourceMimeType: true,
            },
          },
        },
      },
      venue: {
        select: {
          name: true,
          slug: true,
          category: true,
          guideMode: true,
          defaultCenterLat: true,
          defaultCenterLng: true,
        },
      },
      packageHandoff: { select: { packageDraftId: true } },
    },
  })
  if (!run) {
    throw new IntakeVenuePackageCandidateError('NOT_FOUND', 'Supported intake proposal not found')
  }
  const issues: IntakeCandidateIssue[] = []
  if (run.status !== 'AWAITING_REVIEW') {
    issues.push({
      code: 'NOT_AWAITING_REVIEW',
      path: 'status',
      message: 'Only an awaiting-review intake proposal can produce a package candidate.',
    })
  }
  if (run.packageHandoff && input.allowExistingHandoff !== true) {
    issues.push({
      code: 'ALREADY_LINKED',
      path: 'packageHandoff',
      message: 'This intake proposal already has a package handoff.',
    })
  }
  const namespace = `${scope.tenantId}:${scope.venueId}:${run.id}`
  const candidate = emptyPayload()

  if (run.sourceKind === 'STRUCTURED_BOOTSTRAP') {
    const fileReview = storedFileExtractionReview.safeParse(run.structuredBootstrap)
    if (fileReview.success) {
      const review = run.fileExtractionProposalReview
      const notesHash = createHash('sha256').update(fileReview.data.proposalNotes).digest('hex')
      const evidence = run.evidence[0]
      if (
        !review ||
        review.decision !== 'ACCEPTED_FOR_PROPOSAL' ||
        run.requestedByType !== 'HUMAN' ||
        run.requestedBy !== review.createdBy ||
        run.submissionRequestId !== review.requestId ||
        run.submissionInputHash !== review.requestHash ||
        run.displayName !== review.proposalTitle ||
        fileReview.data.sourceRunId !== review.sourceRunId ||
        fileReview.data.receiptId !== review.receiptId ||
        fileReview.data.sourceSha256 !== review.receipt.sourceSha256 ||
        fileReview.data.sourceMimeType !== review.receipt.sourceMimeType ||
        fileReview.data.extractedTextHash !== review.expectedExtractedTextHash ||
        fileReview.data.proposalNotes !== review.proposalNotes ||
        fileReview.data.proposalNotesHash !== review.proposalNotesHash ||
        fileReview.data.proposalNotesHash !== notesHash ||
        fileReview.data.reviewRationale !== review.rationale ||
        run.evidence.length !== 1 ||
        evidence?.sourceKind !== 'STRUCTURED_BOOTSTRAP' ||
        evidence.locator !== `intake-file-extraction-review:${review.id}` ||
        evidence.normalizedHash !== review.proposalNotesHash ||
        Number(evidence.confidence) !== 1
      ) {
        throw new IntakeVenuePackageCandidateError(
          'INVALID_EVIDENCE',
          'Stored file extraction review evidence is invalid',
        )
      }
      const sourceHash = createHash('sha256')
        .update(
          JSON.stringify({
            reviewId: review.id,
            sourceRunId: review.sourceRunId,
            receiptId: review.receiptId,
            extractedTextHash: review.expectedExtractedTextHash,
            proposalNotesHash: review.proposalNotesHash,
          }),
        )
        .digest('hex')
      candidate.knowledgeEntries.create.push({
        itemKey: deterministicUuid(
          `v${INTAKE_CANDIDATE_MAPPING_VERSION}:${namespace}:file-extraction-review:${sourceHash}`,
        ),
        provenance: { ...provenance(), sourceName: 'Reviewed file extraction proposal' },
        value: {
          title: run.displayName,
          category: 'DOCUMENT_REVIEW',
          content: fileReview.data.proposalNotes,
          isEnabled: true,
        },
      })
      return result(run, scope.venueId, candidate, issues)
    }
    const bootstrapEvidence = run.evidence[0]
    if (
      !run.submissionInputHash ||
      !/^[a-f0-9]{64}$/u.test(run.submissionInputHash) ||
      run.evidence.length !== 1 ||
      bootstrapEvidence?.sourceKind !== 'STRUCTURED_BOOTSTRAP' ||
      bootstrapEvidence.locator !== 'onboarding:structured-bootstrap:v1' ||
      bootstrapEvidence.normalizedHash !== run.submissionInputHash ||
      Number(bootstrapEvidence.confidence) !== 1
    ) {
      throw new IntakeVenuePackageCandidateError(
        'INVALID_EVIDENCE',
        'Stored onboarding evidence is invalid',
      )
    }
    const bootstrap = storedBootstrap.safeParse(run.structuredBootstrap)
    if (!bootstrap.success) {
      throw new IntakeVenuePackageCandidateError(
        'INVALID_EVIDENCE',
        'Stored onboarding information is invalid',
      )
    }
    const venue = {
      name: run.venue.name,
      slug: run.venue.slug,
      ...(run.venue.category === null ? {} : { category: run.venue.category }),
      guideMode: run.venue.guideMode,
      ...(run.venue.defaultCenterLat === null
        ? {}
        : { defaultCenterLat: run.venue.defaultCenterLat }),
      ...(run.venue.defaultCenterLng === null
        ? {}
        : { defaultCenterLng: run.venue.defaultCenterLng }),
    }
    const reconstructed = onboardingBootstrapInputHash({
      venue: venue as Parameters<typeof onboardingBootstrapInputHash>[0]['venue'],
      proposal: bootstrap.data,
    })
    if (reconstructed !== run.submissionInputHash) {
      throw new IntakeVenuePackageCandidateError(
        'INVALID_EVIDENCE',
        'Stored onboarding source is inconsistent',
      )
    }
    const sourceHash = createHash('sha256').update(JSON.stringify(bootstrap.data)).digest('hex')
    if (bootstrap.data.content.kind === 'place') {
      if (run.venue.guideMode === 'location_aware') {
        issues.push({
          code: 'PACKAGE_FIELD_INVALID',
          path: 'places.create.0.value',
          message: 'A location-aware place candidate requires reviewed place coordinates.',
        })
      }
      candidate.places.create.push({
        itemKey: deterministicUuid(
          `v${INTAKE_CANDIDATE_MAPPING_VERSION}:${namespace}:bootstrap:place:${run.submissionInputHash}:${sourceHash}`,
        ),
        provenance: { ...provenance(), sourceName: 'Structured onboarding: place' },
        value: { ...bootstrap.data.content.value, tags: [], importanceScore: 0 },
      })
    } else {
      candidate.knowledgeEntries.create.push({
        itemKey: deterministicUuid(
          `v${INTAKE_CANDIDATE_MAPPING_VERSION}:${namespace}:bootstrap:knowledge:${run.submissionInputHash}:${sourceHash}`,
        ),
        provenance: { ...provenance(), sourceName: 'Structured onboarding: knowledge' },
        value: { ...bootstrap.data.content.value, isEnabled: true },
      })
    }
    return result(run, scope.venueId, candidate, issues)
  }

  const review = await getIntakeProposalReview({ db: input.db, ...scope })
  if (!review.structuredSummary.handoffReady) {
    issues.push({
      code: 'INTERVIEW_DISCREPANCY',
      path: 'review',
      message: 'The verified interview review is not ready for a package handoff.',
    })
  }
  const orderedAnswers = [...review.answers].sort(
    (left, right) =>
      (interviewFieldRank.get(left.fieldPath) ?? Number.MAX_SAFE_INTEGER) -
        (interviewFieldRank.get(right.fieldPath) ?? Number.MAX_SAFE_INTEGER) ||
      left.fieldPath.localeCompare(right.fieldPath),
  )
  for (const answer of orderedAnswers) {
    if (answer.discrepancies.length > 0) {
      issues.push({
        code: 'INTERVIEW_DISCREPANCY',
        path: answer.fieldPath,
        message: `Resolve ${answer.discrepancies.join(', ')} before creating a package candidate.`,
      })
    }
    if (!answer.publicText) continue
    const mapping = interviewMappings[answer.fieldPath]
    if (!mapping) {
      issues.push({
        code: 'UNKNOWN_FIELD_PATH',
        path: answer.fieldPath,
        message: 'This candidate field has no reviewed VenuePackage mapping.',
      })
      continue
    }
    candidate.knowledgeEntries.create.push({
      itemKey: deterministicUuid(
        `v${INTAKE_CANDIDATE_MAPPING_VERSION}:${namespace}:interview:${answer.fieldPath}:${createHash('sha256').update(answer.publicText).digest('hex')}`,
      ),
      provenance: { ...provenance(), sourceName: `Staff interview: ${answer.fieldPath}` },
      value: {
        title: mapping.title,
        category: mapping.category,
        content: answer.publicText,
        isEnabled: true,
      },
    })
  }
  if (candidate.knowledgeEntries.create.length === 0) {
    issues.push({
      code: 'NO_CANDIDATES',
      path: 'payload',
      message: 'No verified public candidate fields are available.',
    })
  }
  return result(run, scope.venueId, candidate, issues)
}
