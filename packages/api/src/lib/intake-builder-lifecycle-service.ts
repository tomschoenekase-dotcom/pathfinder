import { createHash } from 'node:crypto'

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

const MAX_WEBSITE_RESEARCH_ATTEMPTS = 4

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function projectWebsiteCandidate(
  researchSnapshot: unknown,
  candidateSnapshot: unknown,
  expectedRunId: string,
) {
  const research = asRecord(researchSnapshot)
  const candidateBinding = asRecord(candidateSnapshot)
  const citations = Array.isArray(research?.citations) ? research.citations : null
  const discrepancies = Array.isArray(research?.discrepancies) ? research.discrepancies : null
  const pages = Array.isArray(research?.pages) ? research.pages : null
  const evidence = Array.isArray(research?.evidence) ? research.evidence : null
  const citationsValid = citations?.every((raw) => {
    const citation = asRecord(raw)
    return Boolean(
      citation &&
      typeof citation.evidenceId === 'string' &&
      typeof citation.fieldPath === 'string' &&
      typeof citation.value === 'string' &&
      typeof citation.sourceUrl === 'string' &&
      typeof citation.locator === 'string' &&
      typeof citation.confidence === 'number',
    )
  })
  const bindingKind = candidateBinding?.kind
  if (
    research?.schemaVersion !== 1 ||
    research.sourceId !== expectedRunId ||
    citations === null ||
    !citationsValid ||
    discrepancies === null ||
    pages === null ||
    evidence === null ||
    (bindingKind !== 'TYPED_INTERMEDIATE' && bindingKind !== 'VENUE_PACKAGE_DRAFT')
  ) {
    return null
  }
  const issues: IntakeBuilderBlocker[] = []
  if (citations.length === 0) {
    issues.push({
      code: 'WEBSITE_NO_FACTS',
      path: 'citations',
      message: 'The bounded crawl retained pages but extracted no cited venue facts.',
    })
  }
  for (const raw of discrepancies) {
    const discrepancy = asRecord(raw)
    if (!discrepancy || typeof discrepancy.fieldPath !== 'string') continue
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
    candidateHash: createHash('sha256')
      .update(stableJson({ researchSnapshot, candidateSnapshot }))
      .digest('hex'),
    candidateCount: citations.length,
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
    candidate = projectWebsiteCandidate(
      latestWebsiteResearch.researchSnapshot,
      latestWebsiteResearch.candidateSnapshot,
      run.id,
    )
  }

  const draft = run.packageHandoff?.packageDraft
  return projectIntakeBuilderLifecycle({
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
}
