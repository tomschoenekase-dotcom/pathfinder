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
import { loadInterviewClarificationReview } from './intake-interview-clarifications'
import {
  INTAKE_PDF_EXTRACTION_MAX_BYTES,
  INTAKE_TEXT_EXTRACTION_MAX_BYTES,
  INTAKE_TEXT_MIME_TYPES,
} from './intake-file-extraction-service'
import {
  buildWebsiteClarificationReview,
  WebsiteClarificationError,
} from './intake-website-clarifications'
import { WEBSITE_MAPPING_FIELD_PATHS } from './intake-website-mapping'

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
      evidence: {
        orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          sourceKind: true,
          locator: true,
          normalizedHash: true,
          confidence: true,
        },
      },
      upload: {
        select: {
          id: true,
          displayName: true,
          fileName: true,
          mimeType: true,
          category: true,
          byteSize: true,
          sha256: true,
          status: true,
          verifiedAt: true,
        },
      },
      fileExtractionReceipts: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: {
          id: true,
          outcome: true,
          extractor: true,
          extractorVersion: true,
          extractedText: true,
          extractedTextHash: true,
          extractedCharacterCount: true,
          extractedLineCount: true,
          errorCode: true,
          errorMessage: true,
          createdAt: true,
          review: {
            select: {
              id: true,
              decision: true,
              proposalRunId: true,
              proposalTitle: true,
              proposalNotesHash: true,
              rationale: true,
              createdBy: true,
              createdAt: true,
              proposalRun: { select: { status: true } },
            },
          },
        },
      },
      fileExtractionProposalReview: {
        select: {
          sourceRunId: true,
          receiptId: true,
          expectedExtractedTextHash: true,
        },
      },
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
      interviewClarificationResolutions: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          clarificationId: true,
          kind: true,
          amendedPublicText: true,
          rationale: true,
          createdAt: true,
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
  let interviewReview: Awaited<ReturnType<typeof loadInterviewClarificationReview>> | null = null
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
      if (
        run.sourceKind === 'INTERVIEW' &&
        built.issues.some(({ code }) => code === 'INTERVIEW_DISCREPANCY')
      ) {
        interviewReview = await loadInterviewClarificationReview({
          db: input.db,
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: input.runId,
        })
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
  const interviewClarificationOperationIds =
    interviewReview?.clarifications.map(({ operationId }) => operationId) ?? []
  const allClarificationOperationIds = [
    ...clarificationOperationIds,
    ...interviewClarificationOperationIds,
  ]
  const latestFileExtraction = run.fileExtractionReceipts?.[0] ?? null
  const inheritedFileReview = run.fileExtractionProposalReview ?? null
  const fileClarificationReceiptId =
    latestFileExtraction?.outcome === 'SUCCEEDED'
      ? latestFileExtraction.id
      : (inheritedFileReview?.receiptId ?? null)
  const fileClarificationExtractedTextHash =
    latestFileExtraction?.outcome === 'SUCCEEDED'
      ? latestFileExtraction.extractedTextHash
      : (inheritedFileReview?.expectedExtractedTextHash ?? null)
  const fileClarificationSourceRunId = inheritedFileReview?.sourceRunId ?? run.id
  const fileClarificationEligible =
    run.sourceKind === 'FILE_UPLOAD' &&
    latestFileExtraction?.outcome === 'SUCCEEDED' &&
    latestFileExtraction.review === null
  const [storedQuestions, clarificationIdentities, fileClarificationQuestions] = await Promise.all([
    allClarificationOperationIds.length > 0
      ? input.db.agentQuestion.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            operationId: { in: allClarificationOperationIds },
          },
          select: {
            id: true,
            operationId: true,
            status: true,
            answer: true,
            answeredAt: true,
            agentIdentityId: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
    allClarificationOperationIds.length > 0 || fileClarificationEligible
      ? input.db.agentIdentity.findMany({
          where: {
            tenantId: input.tenantId,
            enabled: true,
            agentType: 'CONTENT',
            accessCapabilities: { has: 'content.draft' },
            OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
          },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    fileClarificationReceiptId && fileClarificationExtractedTextHash
      ? input.db.agentQuestion.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            category: 'builder-file-clarification',
            AND: [
              { callbackMetadata: { path: ['receiptId'], equals: fileClarificationReceiptId } },
              { callbackMetadata: { path: ['runId'], equals: fileClarificationSourceRunId } },
              {
                callbackMetadata: {
                  path: ['extractedTextHash'],
                  equals: fileClarificationExtractedTextHash,
                },
              },
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            question: true,
            status: true,
            answer: true,
            answeredAt: true,
            evidence: true,
            callbackMetadata: true,
            blocking: true,
            agentIdentityId: true,
            updatedAt: true,
            fileClarificationResolution: {
              select: {
                id: true,
                kind: true,
                amendedExcerpt: true,
                rationale: true,
                createdAt: true,
              },
            },
          },
        })
      : Promise.resolve([]),
  ])
  const questionByOperationId = new Map(
    storedQuestions.map((question) => [question.operationId, question]),
  )
  const interviewResolutionByClarificationId = new Map(
    (run.interviewClarificationResolutions ?? []).map((resolution) => [
      resolution.clarificationId,
      resolution,
    ]),
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
              answeredAt: question.answeredAt,
              agentIdentityId: question.agentIdentityId,
              updatedAt: question.updatedAt,
              answerGuidanceOnly: true as const,
            }
          : null,
      }
    }) ?? []
  const interviewClarifications =
    interviewReview?.clarifications.map((clarification) => {
      const question = questionByOperationId.get(clarification.operationId)
      const resolution = interviewResolutionByClarificationId.get(clarification.clarificationId)
      return {
        clarificationId: clarification.clarificationId,
        questionId: clarification.questionId,
        fieldPath: clarification.fieldPath,
        reasons: clarification.reasons,
        evidence: clarification.evidence,
        proposedAnswer: 'proposedAnswer' in clarification ? clarification.proposedAnswer : null,
        resolution: resolution
          ? {
              resolutionId: resolution.id,
              kind: resolution.kind,
              amendedPublicText: resolution.amendedPublicText,
              rationale: resolution.rationale,
              createdAt: resolution.createdAt,
              grantsAuthority: false as const,
            }
          : null,
        question: question
          ? {
              id: question.id,
              status: question.status,
              answer: question.answer,
              answeredAt: question.answeredAt,
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
  if (draft && run.sourceKind === 'WEBSITE' && candidate && websiteReview) {
    candidate = { ...candidate, ready: true, issues: [] }
  }
  const uploadEvidence = run.evidence?.[0]
  const fileUpload =
    run.sourceKind === 'FILE_UPLOAD' &&
    run._count.evidence === 1 &&
    run.upload?.status === 'AWAITING_REVIEW' &&
    run.upload.verifiedAt !== null &&
    uploadEvidence?.sourceKind === 'FILE_UPLOAD' &&
    uploadEvidence.locator === `intake-upload:${run.upload.id}` &&
    uploadEvidence.normalizedHash === run.upload.sha256 &&
    Number(uploadEvidence.confidence) === 1
      ? {
          uploadId: run.upload.id,
          displayName: run.upload.displayName,
          fileName: run.upload.fileName,
          mimeType: run.upload.mimeType,
          category: run.upload.category,
          byteSize: run.upload.byteSize,
          sha256: run.upload.sha256,
          verifiedAt: run.upload.verifiedAt,
          deterministicTextExtractionAvailable:
            (run.upload.mimeType === 'application/pdf' &&
              run.upload.byteSize <= INTAKE_PDF_EXTRACTION_MAX_BYTES) ||
            ((INTAKE_TEXT_MIME_TYPES as readonly string[]).includes(run.upload.mimeType) &&
              run.upload.byteSize <= INTAKE_TEXT_EXTRACTION_MAX_BYTES),
        }
      : null
  const fileExtraction = latestFileExtraction
    ? {
        receiptId: latestFileExtraction.id,
        outcome: latestFileExtraction.outcome,
        extractor: latestFileExtraction.extractor,
        extractorVersion: latestFileExtraction.extractorVersion,
        extractedTextHash: latestFileExtraction.extractedTextHash,
        extractedCharacterCount: latestFileExtraction.extractedCharacterCount,
        extractedLineCount: latestFileExtraction.extractedLineCount,
        errorCode: latestFileExtraction.errorCode,
        errorMessage: latestFileExtraction.errorMessage,
        review: latestFileExtraction.review
          ? {
              reviewId: latestFileExtraction.review.id,
              decision: latestFileExtraction.review.decision,
              proposalRunId: latestFileExtraction.review.proposalRunId,
              proposalNotesHash: latestFileExtraction.review.proposalNotesHash,
            }
          : null,
      }
    : null
  const lifecycle = projectIntakeBuilderLifecycle({
    runId: run.id,
    sourceKind: run.sourceKind,
    runStatus: run.status,
    evidenceCount: run._count.evidence,
    fileUpload,
    fileExtraction,
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
    fileExtractionReview:
      latestFileExtraction?.outcome === 'SUCCEEDED' && latestFileExtraction.extractedText
        ? {
            receiptId: latestFileExtraction.id,
            extractor: latestFileExtraction.extractor,
            extractorVersion: latestFileExtraction.extractorVersion,
            extractedTextHash: latestFileExtraction.extractedTextHash!,
            extractedCharacterCount: latestFileExtraction.extractedCharacterCount,
            extractedLineCount: latestFileExtraction.extractedLineCount,
            preview: latestFileExtraction.extractedText.slice(0, 4_000),
            previewTruncated: latestFileExtraction.extractedText.length > 4_000,
            createdAt: latestFileExtraction.createdAt,
            reviewRequired: latestFileExtraction.review === null,
            review: latestFileExtraction.review
              ? {
                  reviewId: latestFileExtraction.review.id,
                  decision: latestFileExtraction.review.decision,
                  proposalRunId: latestFileExtraction.review.proposalRunId,
                  proposalStatus: latestFileExtraction.review.proposalRun?.status ?? null,
                  proposalTitle: latestFileExtraction.review.proposalTitle,
                  proposalNotesHash: latestFileExtraction.review.proposalNotesHash,
                  rationale: latestFileExtraction.review.rationale,
                  createdBy: latestFileExtraction.review.createdBy,
                  createdAt: latestFileExtraction.review.createdAt,
                }
              : null,
            grantsAuthority: false as const,
          }
        : null,
    fileClarificationReview:
      fileClarificationReceiptId && fileClarificationExtractedTextHash
        ? {
            receiptId: fileClarificationReceiptId,
            extractedTextHash: fileClarificationExtractedTextHash,
            sourceRunId: fileClarificationSourceRunId,
            carriedForward: inheritedFileReview !== null,
            canCreate: fileClarificationEligible,
            questions: fileClarificationQuestions.map((question) => {
              const metadata =
                question.callbackMetadata &&
                typeof question.callbackMetadata === 'object' &&
                !Array.isArray(question.callbackMetadata)
                  ? (question.callbackMetadata as Record<string, unknown>)
                  : {}
              const evidenceValues: unknown[] = Array.isArray(question.evidence)
                ? question.evidence
                : []
              const evidence = evidenceValues.flatMap((item) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return []
                const record = item as Record<string, unknown>
                return typeof record.label === 'string' && typeof record.reference === 'string'
                  ? [
                      {
                        label: record.label,
                        reference: record.reference,
                        ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
                      },
                    ]
                  : []
              })
              return {
                id: question.id,
                fieldPath:
                  typeof metadata.fieldPath === 'string' ? metadata.fieldPath : 'file evidence',
                reason: typeof metadata.reason === 'string' ? metadata.reason : 'MISSING_CONTEXT',
                blockerScope: question.blocking ? ('FOUNDATIONAL' as const) : ('LOCAL' as const),
                blocksTerminalReview: question.blocking,
                question: question.question,
                status: question.status,
                answer: question.answer,
                answeredAt: question.answeredAt,
                evidence,
                agentIdentityId: question.agentIdentityId,
                updatedAt: question.updatedAt,
                resolution: question.fileClarificationResolution
                  ? {
                      resolutionId: question.fileClarificationResolution.id,
                      kind: question.fileClarificationResolution.kind,
                      amendedExcerpt: question.fileClarificationResolution.amendedExcerpt,
                      rationale: question.fileClarificationResolution.rationale,
                      createdAt: question.fileClarificationResolution.createdAt,
                      grantsAuthority: false as const,
                    }
                  : null,
                answerGuidanceOnly: true as const,
              }
            }),
            eligibleIdentities: clarificationIdentities,
            foundationalPending: fileClarificationQuestions.filter(
              ({ blocking, status, fileClarificationResolution }) =>
                blocking && (status !== 'ANSWERED' || fileClarificationResolution === null),
            ).length,
            foundationalAnsweredAwaitingAmendment: fileClarificationQuestions.filter(
              ({ blocking, status, fileClarificationResolution }) =>
                blocking && status === 'ANSWERED' && fileClarificationResolution === null,
            ).length,
            localPending: fileClarificationQuestions.filter(
              ({ blocking, status }) => !blocking && status !== 'ANSWERED',
            ).length,
            answersGrantAuthority: false as const,
            sourceAmendmentRequired: true as const,
          }
        : null,
    websiteClarificationReview: websiteReview
      ? {
          receiptId: latestWebsiteResearch!.id,
          researchHash: websiteReview.researchHash,
          clarifications: websiteClarifications,
          mappingOptions: websiteReview.citations
            .filter(({ fieldPath }) =>
              (WEBSITE_MAPPING_FIELD_PATHS as readonly string[]).includes(fieldPath),
            )
            .map((citation) => ({
              evidenceId: citation.evidenceId,
              fieldPath: citation.fieldPath,
              value: citation.value,
              sourceUrl: citation.sourceUrl,
              locator: citation.locator,
              confidence: citation.confidence,
            })),
          eligibleIdentities: clarificationIdentities,
          answersGrantAuthority: false as const,
        }
      : null,
    interviewClarificationReview: interviewReview
      ? {
          reviewHash: interviewReview.reviewHash,
          clarifications: interviewClarifications,
          eligibleIdentities: clarificationIdentities,
          answersGrantAuthority: false as const,
          sourceAmendmentRequired: true as const,
        }
      : null,
  }
}
