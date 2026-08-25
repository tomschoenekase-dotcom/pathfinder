import type { TRPCContext } from '../context'
import { VenuePackageStoredPreview, VenuePackageValidationReport } from '../schemas/venue-package'
import {
  type IntakeBuilderLifecycleInput,
  projectIntakeBuilderLifecycle,
} from './intake-builder-lifecycle'
import {
  buildIntakeVenuePackageCandidate,
  IntakeVenuePackageCandidateError,
} from './intake-venue-package-candidate'

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

  const draft = run.packageHandoff?.packageDraft
  return projectIntakeBuilderLifecycle({
    runId: run.id,
    sourceKind: run.sourceKind,
    runStatus: run.status,
    evidenceCount: run._count.evidence,
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
