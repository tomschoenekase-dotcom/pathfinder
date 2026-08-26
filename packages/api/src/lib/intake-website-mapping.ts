import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { TRPCContext } from '../context'
import {
  canonicalVenuePackagePayload,
  VenuePackagePayloadV3,
  type VenuePackagePayloadV3 as PayloadV3,
} from '../schemas/venue-package'
import {
  buildWebsiteClarificationReview,
  WebsiteClarificationError,
} from './intake-website-clarifications'

export const WebsiteMappingSelections = z
  .array(
    z
      .object({
        fieldPath: z.string().trim().min(1).max(500),
        evidenceId: z.string().trim().min(1).max(191),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .superRefine((selections, context) => {
    const fields = selections.map(({ fieldPath }) => fieldPath)
    if (new Set(fields).size !== fields.length) {
      context.addIssue({ code: 'custom', message: 'Choose only one website claim per field.' })
    }
  })

export type WebsiteMappingSelection = z.infer<typeof WebsiteMappingSelections>[number]

const knowledgeMappings: Readonly<Record<string, { title: string; category: string }>> = {
  'venue.pageTitle': { title: 'Website page title', category: 'VENUE_IDENTITY' },
  'venue.phone': { title: 'Venue phone', category: 'CONTACT' },
  'venue.email': { title: 'Venue email', category: 'CONTACT' },
  'venue.address': { title: 'Venue address', category: 'VISITOR_ARRIVAL' },
  'venue.hours': { title: 'Published venue hours', category: 'HOURS' },
  'venue.website': { title: 'Official venue website', category: 'CONTACT' },
}

export const WEBSITE_MAPPING_FIELD_PATHS = [
  'venue.name',
  'venue.description',
  ...Object.keys(knowledgeMappings),
] as const

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

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class WebsiteMappingError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'WebsiteMappingError'
  }
}

export function websiteMappingDraftKey(input: {
  tenantId: string
  venueId: string
  runId: string
  mappingReviewHash: string
  actorId: string
}) {
  return deterministicUuid(
    `pathfinder:website-mapping-draft:v1:${input.tenantId}:${input.venueId}:${input.runId}:${input.mappingReviewHash}:${input.actorId}`,
  )
}

export async function buildWebsiteVenuePackageMappingCandidate(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
  expectedResearchHash: string
  selections: readonly WebsiteMappingSelection[]
  allowExistingHandoff?: boolean
}) {
  const parsedSelections = WebsiteMappingSelections.safeParse(input.selections)
  if (!parsedSelections.success) {
    throw new WebsiteMappingError(
      'INVALID_INPUT',
      parsedSelections.error.issues[0]?.message ?? 'Invalid mapping selections.',
    )
  }
  const run = await input.db.intakeRun.findFirst({
    where: {
      id: input.runId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: 'WEBSITE',
    },
    select: {
      id: true,
      status: true,
      packageHandoff: { select: { packageDraftId: true } },
      websiteResearchReceipts: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { id: true, outcome: true, researchSnapshot: true, candidateSnapshot: true },
      },
    },
  })
  if (!run) throw new WebsiteMappingError('NOT_FOUND', 'Website intake run not found.')
  if (run.status !== 'AWAITING_REVIEW') {
    throw new WebsiteMappingError(
      'PRECONDITION_FAILED',
      'Only an awaiting-review website run can be mapped.',
    )
  }
  if (run.packageHandoff && input.allowExistingHandoff !== true) {
    throw new WebsiteMappingError('CONFLICT', 'This website intake already has a package handoff.')
  }
  const receipt = run.websiteResearchReceipts[0]
  if (!receipt || receipt.id !== input.receiptId) {
    throw new WebsiteMappingError(
      'CONFLICT',
      'Website research changed; reload Builder before mapping.',
    )
  }
  if (receipt.outcome !== 'SUCCEEDED') {
    throw new WebsiteMappingError(
      'PRECONDITION_FAILED',
      'Successful website research is required for mapping.',
    )
  }
  let review
  try {
    review = buildWebsiteClarificationReview({
      tenantId: input.tenantId,
      venueId: input.venueId,
      runId: input.runId,
      receiptId: input.receiptId,
      researchSnapshot: receipt.researchSnapshot,
      candidateSnapshot: receipt.candidateSnapshot,
    })
  } catch (error) {
    if (error instanceof WebsiteClarificationError) {
      throw new WebsiteMappingError('PRECONDITION_FAILED', error.message)
    }
    throw error
  }
  if (review.researchHash !== input.expectedResearchHash) {
    throw new WebsiteMappingError(
      'CONFLICT',
      'Website research evidence changed; reload Builder before mapping.',
    )
  }

  const clarificationOperationIds = review.clarifications.map(({ operationId }) => operationId)
  const questions = clarificationOperationIds.length
    ? await input.db.agentQuestion.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          operationId: { in: clarificationOperationIds },
        },
        select: { id: true, operationId: true, status: true, answer: true, updatedAt: true },
      })
    : []
  const questionByOperationId = new Map(
    questions.map((question) => [question.operationId, question]),
  )
  const citationByEvidenceId = new Map(
    review.citations.map((citation) => [citation.evidenceId, citation]),
  )
  const selectedCitations = parsedSelections.data.map((selection) => {
    const citation = citationByEvidenceId.get(selection.evidenceId)
    if (!citation || citation.fieldPath !== selection.fieldPath) {
      throw new WebsiteMappingError(
        'INVALID_INPUT',
        `Selected evidence does not match ${selection.fieldPath}.`,
      )
    }
    if (
      selection.fieldPath !== 'venue.name' &&
      selection.fieldPath !== 'venue.description' &&
      !knowledgeMappings[selection.fieldPath]
    ) {
      throw new WebsiteMappingError(
        'INVALID_INPUT',
        `${selection.fieldPath} has no reviewed Venue Package mapping.`,
      )
    }
    const fieldClarifications = review.clarifications.filter(
      ({ fieldPath }) => fieldPath === selection.fieldPath,
    )
    for (const clarification of fieldClarifications) {
      if (questionByOperationId.get(clarification.operationId)?.status !== 'ANSWERED') {
        throw new WebsiteMappingError(
          'PRECONDITION_FAILED',
          `Founder/admin clarification for ${selection.fieldPath} must be answered before mapping.`,
        )
      }
    }
    return citation
  })

  const questionEvidence = review.clarifications
    .filter(({ fieldPath }) =>
      parsedSelections.data.some((selection) => selection.fieldPath === fieldPath),
    )
    .map((clarification) => {
      const question = questionByOperationId.get(clarification.operationId)!
      return {
        discrepancyId: clarification.discrepancyId,
        questionId: question.id,
        status: question.status,
        answerHash: sha256(question.answer ?? ''),
        updatedAt: question.updatedAt.toISOString(),
      }
    })
  const mappingReviewHash = sha256(
    stableJson({
      researchHash: review.researchHash,
      selections: [...parsedSelections.data].sort((left, right) =>
        left.fieldPath.localeCompare(right.fieldPath),
      ),
      questionEvidence,
    }),
  )
  const payload: PayloadV3 = {
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: { create: [], update: [], delete: [] },
  }
  const identity: { name?: string; description?: string } = {}
  for (const citation of selectedCitations) {
    if (citation.fieldPath === 'venue.name') identity.name = citation.value
    else if (citation.fieldPath === 'venue.description') identity.description = citation.value
    else {
      const mapping = knowledgeMappings[citation.fieldPath]!
      payload.knowledgeEntries.create.push({
        itemKey: deterministicUuid(
          `pathfinder:website-mapping-item:v1:${input.tenantId}:${input.venueId}:${input.runId}:${review.researchHash}:${citation.fieldPath}:${citation.evidenceId}`,
        ),
        provenance: {
          sourceType: 'PATHFINDER_INTAKE',
          sourceName: `Reviewed website: ${citation.fieldPath}`,
          sourceUrl: citation.sourceUrl,
          contentOrigin: 'HUMAN_AUTHORED',
        },
        value: {
          title: mapping.title,
          category: mapping.category,
          content: citation.value,
          isEnabled: true,
        },
      })
    }
  }
  if (Object.keys(identity).length) payload.venue = { identity }
  const parsedPayload = VenuePackagePayloadV3.safeParse(payload)
  if (!parsedPayload.success) {
    throw new WebsiteMappingError(
      'PRECONDITION_FAILED',
      `Mapped website candidate is invalid: ${parsedPayload.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' | ')}`,
    )
  }
  const candidateHash = sha256(canonicalVenuePackagePayload(input.venueId, parsedPayload.data))
  return {
    runId: input.runId,
    receiptId: input.receiptId,
    researchHash: review.researchHash,
    mappingReviewHash,
    payload: parsedPayload.data,
    candidateHash,
    selections: parsedSelections.data,
    clarificationEvidence: questionEvidence,
    ready: true as const,
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
    answersGrantAuthority: false as const,
  }
}
