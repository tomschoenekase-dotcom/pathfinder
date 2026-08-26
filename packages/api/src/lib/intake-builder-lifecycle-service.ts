import type { TRPCContext } from '../context'
import { VenuePackageStoredPreview, VenuePackageValidationReport } from '../schemas/venue-package'
import {
  type IntakeBuilderBlocker,
  type IntakeBuilderLifecycleInput,
  projectIntakeBuilderLifecycle,
} from './intake-builder-lifecycle'
import {
  buildIntakeVenuePackageCandidate,
  IntakeVenuePackageCandidateError,
} from './intake-venue-package-candidate'
import {
  buildWebsiteClarificationReview,
  WebsiteClarificationError,
} from './intake-website-clarifications'

const MAX_WEBSITE_RESEARCH_ATTEMPTS = 4

function projectWebsiteCandidate(
  researchSnapshot: unknown,
  candidateSnapshot: unknown,
  scope: { tenantId: string; venueId: string; runId: string; receiptId: string },
) {
  let review
  try {
    review = buildWebsiteClarificationReview({
      ...scope,
      researchSnapshot,
      candidateSnapshot,
    })
  } catch (error) {
    if (error instanceof WebsiteClarificationError) return null
    throw error
  }
  const issues: IntakeBuilderBlocker[] = []
  if (review.citations.length === 0) {
    issues.push({
      code: 'WEBSITE_NO_FACTS',
      path: 'citations',
      message: 'The bounded crawl retained pages but extracted no cited venue facts.',
    })
  }
  for (const discrepancy of review.clarifications) {
    const dateSensitive = discrepancy.reason === 'DATE_SENSITIVE'
    issues.push({
      code: dateSensitive ? 'WEBSITE_DATE_SENSITIVE_DISCREPANCY' : 'WEBSITE_CONTRADICTION',
      path: discrepancy.fieldPath,
      message: dateSensitive
        ? `Date-sensitive website claims for ${discrepancy.fieldPath} require review.`
        : `Contradictory website claims for ${discrepancy.fieldPath} require review.`,
    })
  }
  issues.push({
    code: 'WEBSITE_MAPPING_REQUIRED',
    path: 'candidate',
    message: 'Cited website facts require an explicit reviewed mapping into a Venue Package draft.',
  })
  return {
    ready: false,
    candidateHash: review.researchHash,
    candidateCount: review.citations.length,
    issues,
  }
}

export async function getIntakeBuilderLifecycle(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
}) {
  const run = await input.db.intakeRun.findFirst({
    where: {
      id: input.runId,
      tenantId: input.tenantId,
      venueId: input.venueId,
    },
    select: {
      id: true,
      sourceKind: true,
      status: true,
      _count: { select: { evidence: true } },
      websiteResearchReceipts: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_WEBSITE_RESEARCH_ATTEMPTS,
        select: {
          id: true,
          outcome: true,
          researchSnapshot: true,
          candidateSnapshot: true,
          attemptedFetches: true,
          fetchedPages: true,
          fetchedBytes: true,
          estimatedCostUnits: true,
          latencyMs: true,
          errorCode: true,
          errorMessage: true,
        },
      },
      packageHandoff: {
        select: {
          packageDraft: {
            select: {
              id: true,
              status: true,
              validationReport: true,
              previewPlan: true,
              duplicateAnalysis: { select: { status: true } },
            },
          },
        },
      },
    },
  })
  if (!run) {
    throw new IntakeVenuePackageCandidateError('NOT_FOUND', 'Intake Builder run not found')
  }

  let candidate: IntakeBuilderLifecycleInput['candidate'] = null
  let websiteReview: ReturnType<typeof buildWebsiteClarificationReview> | null = null
  if (run.sourceKind === 'STRUCTURED_BOOTSTRAP' || run.sourceKind === 'INTERVIEW') {
    try {
      const built = await buildIntakeVenuePackageCandidate({
        db: input.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        allowExistingHandoff: true,
      })
      candidate = {
        ready: built.ready,
        candidateHash: built.candidateHash,
        candidateCount: built.summary.candidateCount,
        issues: built.issues,
      }
    } catch (error) {
      if (!(error instanceof IntakeVenuePackageCandidateError)) throw error
      candidate = {
        ready: false,
        candidateHash: null,
        candidateCount: 0,
        issues: [{ code: error.code, path: 'sourceEvidence', message: error.message }],
      }
    }
  }
  const latestWebsiteResearch = run.websiteResearchReceipts[0] ?? null
  if (run.sourceKind === 'WEBSITE' && latestWebsiteResearch?.outcome === 'SUCCEEDED') {
    try {
      websiteReview = buildWebsiteClarificationReview({
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: run.id,
        receiptId: latestWebsiteResearch.id,
        researchSnapshot: latestWebsiteResearch.researchSnapshot,
        candidateSnapshot: latestWebsiteResearch.candidateSnapshot,
      })
    } catch (error) {
      if (!(error instanceof WebsiteClarificationError)) throw error
    }
    candidate = projectWebsiteCandidate(
      latestWebsiteResearch.researchSnapshot,
      latestWebsiteResearch.candidateSnapshot,
      {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: run.id,
        receiptId: latestWebsiteResearch.id,
      },
    )
  }

  const clarificationOperationIds =
    websiteReview?.clarifications.map(({ operationId }) => operationId) ?? []
  const [storedQuestions, clarificationIdentities] =
    clarificationOperationIds.length > 0
      ? await Promise.all([
          input.db.agentQuestion.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              operationId: { in: clarificationOperationIds },
            },
            select: {
              id: true,
              operationId: true,
              status: true,
              answer: true,
              agentIdentityId: true,
              updatedAt: true,
            },
          }),
          input.db.agentIdentity.findMany({
            where: {
              tenantId: input.tenantId,
              enabled: true,
              agentType: 'CONTENT',
              accessCapabilities: { has: 'content.draft' },
              OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            select: { id: true, name: true },
          }),
        ])
      : [[], []]
  const questionByOperationId = new Map(
    storedQuestions.map((question) => [question.operationId, question]),
  )
  const websiteClarifications =
    websiteReview?.clarifications.map((clarification) => {
      const question = questionByOperationId.get(clarification.operationId)
      return {
        discrepancyId: clarification.discrepancyId,
        fieldPath: clarification.fieldPath,
        reason: clarification.reason,
        evidence: clarification.evidence,
        proposedAnswer: clarification.proposedAnswer,
        question: question
          ? {
              id: question.id,
              status: question.status,
              answer: question.answer,
              agentIdentityId: question.agentIdentityId,
              updatedAt: question.updatedAt,
              answerGuidanceOnly: true as const,
            }
          : null,
      }
    }) ?? []
  if (candidate && websiteReview) {
    candidate = {
      ...candidate,
      issues: [
        ...websiteClarifications.map((clarification) => ({
          code:
            clarification.reason === 'DATE_SENSITIVE'
              ? 'WEBSITE_DATE_SENSITIVE_DISCREPANCY'
              : 'WEBSITE_CONTRADICTION',
          path: clarification.fieldPath,
          message:
            clarification.question === null
              ? `Founder/admin clarification is required for ${clarification.fieldPath}.`
              : clarification.question.status === 'PENDING'
                ? `Founder/admin clarification is pending for ${clarification.fieldPath}.`
                : clarification.question.status === 'ANSWERED'
                  ? `Clarification for ${clarification.fieldPath} is guidance only; explicit mapping review is still required.`
                  : `Clarification for ${clarification.fieldPath} remains unresolved (${clarification.question.status.toLowerCase()}).`,
        })),
        {
          code: 'WEBSITE_MAPPING_REQUIRED',
          path: 'candidate',
          message:
            'Cited website facts require an explicit reviewed mapping into a Venue Package draft.',
        },
      ],
    }
  }

  const draft = run.packageHandoff?.packageDraft
  const lifecycle = projectIntakeBuilderLifecycle({
    runId: run.id,
    sourceKind: run.sourceKind,
    runStatus: run.status,
    evidenceCount: run._count.evidence,
    websiteResearch: latestWebsiteResearch
      ? {
          receiptId: latestWebsiteResearch.id,
          outcome: latestWebsiteResearch.outcome,
          attemptCount: run.websiteResearchReceipts.length,
          canRetry:
            latestWebsiteResearch.outcome !== 'SUCCEEDED' &&
            run.websiteResearchReceipts.length < MAX_WEBSITE_RESEARCH_ATTEMPTS,
          attemptedFetches: latestWebsiteResearch.attemptedFetches,
          fetchedPages: latestWebsiteResearch.fetchedPages,
          fetchedBytes: latestWebsiteResearch.fetchedBytes,
          estimatedCostUnits: latestWebsiteResearch.estimatedCostUnits,
          latencyMs: latestWebsiteResearch.latencyMs,
          errorCode: latestWebsiteResearch.errorCode,
          errorMessage: latestWebsiteResearch.errorMessage,
        }
      : null,
    candidate,
    packageDraft: draft
      ? {
          id: draft.id,
          status: draft.status,
          validationEvidence: VenuePackageValidationReport.safeParse(draft.validationReport).success
            ? 'VALID'
            : 'INVALID',
          simulationEvidence: VenuePackageStoredPreview.safeParse(draft.previewPlan).success
            ? 'VALID'
            : 'INVALID',
          semanticQa: draft.duplicateAnalysis?.status ?? 'MISSING',
        }
      : null,
  })
  return {
    ...lifecycle,
    websiteClarificationReview: websiteReview
      ? {
          receiptId: latestWebsiteResearch!.id,
          researchHash: websiteReview.researchHash,
          clarifications: websiteClarifications,
          eligibleIdentities: clarificationIdentities,
          answersGrantAuthority: false as const,
        }
      : null,
  }
}
