import { createHash } from 'node:crypto'
import { z } from 'zod'

import { AgentQuestionActionError, askAgentQuestionAction } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { VenuePackageDraftInput } from '../schemas/venue-package'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const Citation = z
  .object({
    evidenceId: z.string().trim().min(1).max(191),
    fieldPath: z.string().trim().min(1).max(500),
    value: z.string().trim().min(1).max(2000),
    sourceUrl: z.string().url().max(500),
    locator: z.string().trim().min(1).max(500),
    confidence: z.number().min(0).max(1),
    dateSensitive: z.boolean(),
    effectiveDate: z.string().nullable(),
  })
  .strict()

const Discrepancy = z
  .object({
    id: z.string().trim().min(1).max(191),
    fieldPath: z.string().trim().min(1).max(500),
    evidenceIds: z.array(z.string().trim().min(1).max(191)).min(2).max(20),
    reason: z.enum(['CONTRADICTION', 'DATE_SENSITIVE', 'LOW_CONFIDENCE', 'MISSING_CONTEXT']),
    resolution: z.string().trim().min(1).max(5000).optional(),
  })
  .strict()

const Research = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: z.string().trim().min(1).max(191),
    pages: z.array(z.unknown()),
    citations: z.array(Citation),
    evidence: z.array(z.unknown()),
    discrepancies: z.array(Discrepancy),
  })
  .strict()

const CandidateBinding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TYPED_INTERMEDIATE'), draftInput: z.null() }).strict(),
  z.object({ kind: z.literal('VENUE_PACKAGE_DRAFT'), draftInput: VenuePackageDraftInput }).strict(),
])

export type WebsiteClarificationSpec = ReturnType<
  typeof buildWebsiteClarificationReview
>['clarifications'][number]

export class WebsiteClarificationError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'WebsiteClarificationError'
  }
}

export function websiteResearchClarificationOperationId(input: {
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
  researchHash: string
  discrepancyId: string
}) {
  return deterministicUuid(
    `pathfinder:website-research-clarification:v2:${input.tenantId}:${input.venueId}:${input.runId}:${input.receiptId}:${input.researchHash}:${input.discrepancyId}`,
  )
}

export function buildWebsiteClarificationReview(input: {
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
  researchSnapshot: unknown
  candidateSnapshot: unknown
}) {
  const research = Research.safeParse(input.researchSnapshot)
  const candidate = CandidateBinding.safeParse(input.candidateSnapshot)
  if (!research.success || !candidate.success || research.data.sourceId !== input.runId) {
    throw new WebsiteClarificationError(
      'PRECONDITION_FAILED',
      'Stored website research cannot be projected into exact clarification evidence.',
    )
  }

  const researchHash = sha256(
    stableJson({ researchSnapshot: research.data, candidateSnapshot: candidate.data }),
  )
  const citationByEvidenceId = new Map(
    research.data.citations.map((citation) => [citation.evidenceId, citation]),
  )
  const clarifications = research.data.discrepancies.map((discrepancy) => {
    const citations = discrepancy.evidenceIds.map((id) => citationByEvidenceId.get(id))
    if (citations.some((citation) => citation === undefined)) {
      throw new WebsiteClarificationError(
        'PRECONDITION_FAILED',
        `Discrepancy ${discrepancy.id} references missing website evidence.`,
      )
    }
    const exactCitations = citations.filter((citation) => citation !== undefined)
    const values = [...new Set(exactCitations.map(({ value }) => value))]
    const choices =
      values.length >= 2 && values.length <= 8 && values.every((value) => value.length <= 200)
        ? values
        : []
    const proposed = [...exactCitations].sort(
      (left, right) =>
        right.confidence - left.confidence || left.evidenceId.localeCompare(right.evidenceId),
    )[0]!
    return {
      discrepancyId: discrepancy.id,
      fieldPath: discrepancy.fieldPath,
      reason: discrepancy.reason,
      operationId: websiteResearchClarificationOperationId({
        ...input,
        researchHash,
        discrepancyId: discrepancy.id,
      }),
      question: `Which interpretation should Builder use for ${discrepancy.fieldPath}?`,
      context: `Founder/admin clarification is required for ${discrepancy.reason.toLowerCase().replaceAll('_', ' ')} website evidence. The answer is guidance for a later explicit mapping review and grants no approval, apply, publication, or venue-contact authority.`,
      questionType: choices.length ? ('MULTIPLE_CHOICE' as const) : ('LONG_TEXT' as const),
      choices,
      evidence: exactCitations.slice(0, 20).map((citation) => ({
        kind: 'SOURCE_LINK' as const,
        label: `${citation.fieldPath} (${Math.round(citation.confidence * 100)}% confidence)`,
        reference: citation.sourceUrl,
        summary: `${citation.value} · ${citation.locator}${citation.effectiveDate ? ` · effective ${citation.effectiveDate}` : ''}`,
      })),
      proposedAnswer: {
        value: proposed.value,
        evidenceId: proposed.evidenceId,
        confidence: proposed.confidence,
        status: 'PROPOSED_ONLY',
      },
    }
  })

  return { researchHash, citations: research.data.citations, clarifications }
}

export async function createWebsiteResearchClarificationQuestions(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
  expectedResearchHash: string
  discrepancyIds: readonly string[]
  agentIdentityId: string
}) {
  const run = await input.db.intakeRun.findFirst({
    where: {
      id: input.runId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: 'WEBSITE',
    },
    select: {
      id: true,
      websiteResearchReceipts: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: {
          id: true,
          outcome: true,
          researchSnapshot: true,
          candidateSnapshot: true,
        },
      },
    },
  })
  if (!run) throw new WebsiteClarificationError('NOT_FOUND', 'Website intake run not found.')
  const receipt = run.websiteResearchReceipts[0]
  if (!receipt || receipt.id !== input.receiptId) {
    throw new WebsiteClarificationError(
      'CONFLICT',
      'Website research receipt changed; reload Builder before creating questions.',
    )
  }
  if (receipt.outcome !== 'SUCCEEDED') {
    throw new WebsiteClarificationError(
      'PRECONDITION_FAILED',
      'Only successful website research can produce clarification questions.',
    )
  }
  const review = buildWebsiteClarificationReview({
    ...input,
    researchSnapshot: receipt.researchSnapshot,
    candidateSnapshot: receipt.candidateSnapshot,
  })
  if (review.researchHash !== input.expectedResearchHash) {
    throw new WebsiteClarificationError(
      'CONFLICT',
      'Website research evidence changed; reload Builder before creating questions.',
    )
  }
  const identity = await input.db.agentIdentity.findFirst({
    where: {
      id: input.agentIdentityId,
      tenantId: input.tenantId,
      enabled: true,
      agentType: 'CONTENT',
      accessCapabilities: { has: 'content.draft' },
      OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
    },
    select: { id: true },
  })
  if (!identity) {
    throw new WebsiteClarificationError(
      'PRECONDITION_FAILED',
      'Choose an enabled in-scope Content identity with draft capability.',
    )
  }
  const selected = new Set(input.discrepancyIds)
  const clarifications = review.clarifications.filter(({ discrepancyId }) =>
    selected.has(discrepancyId),
  )
  if (clarifications.length !== selected.size) {
    throw new WebsiteClarificationError(
      'INVALID_INPUT',
      'Every selected discrepancy must exist in the exact retained research evidence.',
    )
  }

  try {
    const questions = []
    for (const clarification of clarifications) {
      const result = await askAgentQuestionAction(
        {
          operationId: clarification.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: identity.id,
          question: clarification.question,
          context: clarification.context,
          questionType: clarification.questionType,
          category: 'builder-website-clarification',
          urgency: clarification.reason === 'DATE_SENSITIVE' ? 'HIGH' : 'NORMAL',
          choices: clarification.choices,
          evidence: clarification.evidence,
          proposedAnswer: clarification.proposedAnswer,
          callbackMetadata: {
            workflow: 'intake-website-clarification',
            runId: input.runId,
            receiptId: input.receiptId,
            researchHash: review.researchHash,
            discrepancyId: clarification.discrepancyId,
            fieldPath: clarification.fieldPath,
            reason: clarification.reason,
          },
          blocking: true,
        },
        input.db,
      )
      questions.push({
        discrepancyId: clarification.discrepancyId,
        questionId: result.question.id,
        status: result.question.status,
        replayed: result.replayed,
      })
    }
    return {
      researchHash: review.researchHash,
      questions,
      executionTriggered: false as const,
      approvalGranted: false as const,
      canonicalVenueChanged: false as const,
      packageDraftCreated: false as const,
      publicationTriggered: false as const,
      venueContactTriggered: false as const,
    }
  } catch (error) {
    if (error instanceof AgentQuestionActionError) {
      throw new WebsiteClarificationError(
        error.code === 'CONFLICT' ? 'CONFLICT' : 'PRECONDITION_FAILED',
        error.message,
      )
    }
    throw error
  }
}
