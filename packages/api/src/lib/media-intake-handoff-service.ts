import { z } from 'zod'
import { MediaResolutionStateSchema } from '@pathfinder/contracts/media-resolution-state'

import { db, writeAuditLogStrict } from '@pathfinder/db'

import {
  MediaIntakeHandoffInput,
  mediaIntakeEvidenceLocator,
  mediaIntakeHash,
  validateMediaIntakeSnapshot,
  type MediaIntakeSnapshot,
} from './media-intake-snapshot'
import { buildReviewedMediaIntakeCandidate } from './media-intake-candidate'
import { validateResolutionEvidence } from './media-resolution-evidence'
import { reconcileMediaTemporalClaims } from './media-temporal-reconciliation'
import {
  mediaFindingsSchema,
  mediaQuestionSchema,
} from '../routers/admin/media-ingestion-review-schemas'

export class MediaIntakeHandoffError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_REVIEW',
    message: string,
  ) {
    super(message)
    this.name = 'MediaIntakeHandoffError'
  }
}

export type MediaIntakeHandoffClient = Pick<typeof db, '$transaction'>

const replaySelect = {
  id: true,
  tenantId: true,
  venueId: true,
  sourceKind: true,
  status: true,
  submissionRequestId: true,
  submissionInputHash: true,
  requestedBy: true,
  requestedByType: true,
  structuredBootstrap: true,
  evidence: {
    select: { sourceKind: true, locator: true, normalizedHash: true, confidence: true },
  },
} as const

function validateStoredHandoff(replay: {
  id: string
  tenantId: string
  venueId: string
  requestedBy: string
  requestedByType: string
  submissionRequestId: string | null
  submissionInputHash: string | null
  structuredBootstrap: unknown
  evidence: Array<{
    sourceKind: string
    locator: string
    normalizedHash: string
    confidence: unknown
  }>
}) {
  try {
    buildReviewedMediaIntakeCandidate(replay)
  } catch (error) {
    throw new MediaIntakeHandoffError(
      'CONFLICT',
      error instanceof Error ? error.message : 'Stored media handoff evidence changed.',
    )
  }
  const snapshot = validateMediaIntakeSnapshot(replay.structuredBootstrap)
  const expectedEvidence = new Map<string, string>()
  expectedEvidence.set('media-project-review:snapshot:v1', mediaIntakeHash(snapshot))
  for (const source of snapshot.sources)
    expectedEvidence.set(mediaIntakeEvidenceLocator(snapshot, source.sourceId), source.analysisHash)
  if (
    replay.evidence.length !== expectedEvidence.size ||
    new Set(replay.evidence.map((evidence) => evidence.locator)).size !== expectedEvidence.size ||
    replay.evidence.some(
      (evidence) =>
        evidence.sourceKind !== 'STRUCTURED_BOOTSTRAP' ||
        evidence.confidence?.toString() !== '1' ||
        expectedEvidence.get(evidence.locator) !== evidence.normalizedHash,
    )
  )
    throw new MediaIntakeHandoffError('CONFLICT', 'Stored media handoff evidence changed.')
  return snapshot
}

export async function createMediaIntakeHandoff(params: {
  db: MediaIntakeHandoffClient
  input: z.input<typeof MediaIntakeHandoffInput>
  actorId: string
}) {
  const input = MediaIntakeHandoffInput.parse(params.input)
  const actorId = z.string().min(1).max(191).parse(params.actorId)
  const submissionInputHash = mediaIntakeHash({ input, actorId })

  return params.db.$transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:media-intake:${input.tenantId}:${input.requestId}`}, 0))`
      const replay = await tx.intakeRun.findFirst({
        where: { tenantId: input.tenantId, submissionRequestId: input.requestId },
        select: replaySelect,
      })
      if (replay) {
        if (
          replay.tenantId !== input.tenantId ||
          replay.venueId !== input.venueId ||
          replay.sourceKind !== 'STRUCTURED_BOOTSTRAP' ||
          replay.submissionInputHash !== submissionInputHash ||
          replay.requestedBy !== actorId ||
          replay.requestedByType !== 'HUMAN'
        )
          throw new MediaIntakeHandoffError(
            'CONFLICT',
            'This request key is already bound to a different media review handoff.',
          )
        validateStoredHandoff(replay)
        return { runId: replay.id, status: replay.status, replayed: true }
      }

      const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM media_ingestion_projects
      WHERE id = ${input.projectId} AND tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
      FOR UPDATE
    `
      if (locked.length !== 1)
        throw new MediaIntakeHandoffError('NOT_FOUND', 'Reviewed media project not found.')
      const existingVersion = await tx.intakeRun.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          AND: [
            { structuredBootstrap: { path: ['kind'], equals: 'MEDIA_PROJECT_REVIEW' } },
            { structuredBootstrap: { path: ['projectId'], equals: input.projectId } },
            {
              structuredBootstrap: {
                path: ['sourceGeneration'],
                equals: input.sourceGeneration,
              },
            },
            {
              structuredBootstrap: {
                path: ['reviewedUpdatedAt'],
                equals: input.expectedUpdatedAt,
              },
            },
          ],
        },
        select: replaySelect,
      })
      if (existingVersion) {
        const snapshot = validateStoredHandoff(existingVersion)
        const currentReviewHash = mediaIntakeHash({
          actorId,
          bindings: input.bindings,
          rationale: input.rationale,
          identityReviewId: input.identityReviewId,
        })
        const storedReviewHash = mediaIntakeHash({
          actorId: snapshot.reviewedBy,
          bindings: snapshot.bindings,
          rationale: snapshot.reviewRationale,
          identityReviewId: snapshot.identityReview?.id,
        })
        if (currentReviewHash !== storedReviewHash)
          throw new MediaIntakeHandoffError(
            'CONFLICT',
            'This reviewed media version already has a different handoff decision.',
          )
        return { runId: existingVersion.id, status: existingVersion.status, replayed: true }
      }
      await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM media_ingestion_assets
      WHERE project_id = ${input.projectId} AND tenant_id = ${input.tenantId}
      FOR SHARE
    `

      const project = await tx.mediaIngestionProject.findFirst({
        where: { id: input.projectId, tenantId: input.tenantId, venueId: input.venueId },
        select: {
          id: true,
          name: true,
          status: true,
          stage: true,
          updatedAt: true,
          sourceObjectGeneration: true,
          uploadAttemptId: true,
          draftJson: true,
          findings: true,
          questions: true,
          assets: {
            where: { tenantId: input.tenantId },
            select: {
              id: true,
              sourceId: true,
              filename: true,
              mediaType: true,
              status: true,
              sha256: true,
            },
          },
        },
      })
      if (!project)
        throw new MediaIntakeHandoffError('NOT_FOUND', 'Reviewed media project not found.')
      if (
        project.status !== 'READY_FOR_REVIEW' ||
        project.stage !== 'review' ||
        project.sourceObjectGeneration !== input.sourceGeneration ||
        project.updatedAt.toISOString() !== input.expectedUpdatedAt
      )
        throw new MediaIntakeHandoffError(
          'CONFLICT',
          'The reviewed media project changed or is not ready for handoff.',
        )
      let identityReview: MediaIntakeSnapshot['identityReview']
      if (input.identityReviewId) {
        const reviews = await tx.$queryRaw<
          Array<{
            id: string
            revision: number
            state: unknown
            evidenceSnapshotHash: string
            evidenceSnapshot: unknown
          }>
        >`
          SELECT id, revision, state, evidence_snapshot_hash AS "evidenceSnapshotHash",
            evidence_snapshot AS "evidenceSnapshot"
          FROM media_entity_resolution_revisions
          WHERE tenant_id = ${input.tenantId} AND venue_id = ${input.venueId}
            AND project_id = ${input.projectId} AND source_generation = ${input.sourceGeneration}::uuid
          ORDER BY revision DESC LIMIT 1
        `
        const latest = reviews[0]
        if (!latest || latest.id !== input.identityReviewId)
          throw new MediaIntakeHandoffError(
            'CONFLICT',
            'The selected identity review is no longer the latest reviewed revision.',
          )
        identityReview = {
          id: latest.id,
          revision: latest.revision,
          state: MediaResolutionStateSchema.parse(latest.state),
          evidenceSnapshotHash: latest.evidenceSnapshotHash,
          evidenceSnapshot: latest.evidenceSnapshot,
        }
      }
      const questions = z.array(mediaQuestionSchema).max(500).parse(project.questions)
      if (questions.some((question) => question.answer === undefined || !question.answer.trim()))
        throw new MediaIntakeHandoffError(
          'INVALID_REVIEW',
          'Every media review question must be answered before handoff.',
        )
      const draft = project.draftJson
      const findings = mediaFindingsSchema.parse(project.findings)
      const findingBySource = new Map(findings.map((finding) => [finding.sourceId, finding]))
      if (findingBySource.size !== findings.length)
        throw new MediaIntakeHandoffError(
          'INVALID_REVIEW',
          'Media review contains duplicate finding source identities.',
        )
      const assetBySource = new Map(project.assets.map((asset) => [asset.sourceId, asset]))
      if (assetBySource.size !== project.assets.length)
        throw new MediaIntakeHandoffError(
          'INVALID_REVIEW',
          'Media review contains duplicate asset source identities.',
        )
      if (identityReview) {
        if (!project.uploadAttemptId)
          throw new MediaIntakeHandoffError(
            'INVALID_REVIEW',
            'The identity review has no current media processing generation.',
          )
        try {
          const currentEvidence = validateResolutionEvidence({
            scope: {
              tenantId: input.tenantId,
              projectId: input.projectId,
              uploadAttemptId: project.uploadAttemptId,
            },
            sourceGeneration: input.sourceGeneration,
            candidates: identityReview.state.candidates,
            findings,
            assets: project.assets,
          })
          if (currentEvidence.evidenceSnapshotHash !== identityReview.evidenceSnapshotHash)
            throw new Error('Frozen identity evidence no longer matches the current media review.')
        } catch (error) {
          throw new MediaIntakeHandoffError(
            'CONFLICT',
            error instanceof Error ? error.message : 'Identity review evidence changed.',
          )
        }
      }
      const referencedSourceIds = new Set(input.bindings.flatMap((binding) => binding.sourceIds))
      const sources: MediaIntakeSnapshot['sources'] = []
      for (const sourceId of referencedSourceIds) {
        const asset = assetBySource.get(sourceId)
        const finding = findingBySource.get(sourceId)
        if (!asset || asset.status !== 'COMPLETE' || !asset.sha256 || !finding)
          throw new MediaIntakeHandoffError(
            'INVALID_REVIEW',
            'A bound media source is missing complete immutable evidence.',
          )
        sources.push({
          sourceId,
          assetId: asset.id,
          sha256: asset.sha256,
          filename: asset.filename,
          mediaType: asset.mediaType,
          analysisHash: mediaIntakeHash(finding),
          finding,
        })
      }
      let snapshot: MediaIntakeSnapshot
      try {
        snapshot = validateMediaIntakeSnapshot({
          kind: 'MEDIA_PROJECT_REVIEW',
          version: 1,
          tenantId: input.tenantId,
          venueId: input.venueId,
          projectId: input.projectId,
          requestId: input.requestId,
          sourceGeneration: input.sourceGeneration,
          reviewedUpdatedAt: input.expectedUpdatedAt,
          reviewedBy: actorId,
          reviewRationale: input.rationale,
          draft,
          bindings: input.bindings,
          sources,
          ...(identityReview ? { identityReview } : {}),
          ...(input.temporalClaims
            ? {
                temporalReview: (() => {
                  if (!project.uploadAttemptId)
                    throw new MediaIntakeHandoffError(
                      'INVALID_REVIEW',
                      'Temporal evidence requires the current media processing generation.',
                    )
                  const evaluatedAt = new Date().toISOString()
                  const reconciliation = reconcileMediaTemporalClaims({
                    claims: input.temporalClaims,
                    now: evaluatedAt,
                  })
                  return {
                    claims: input.temporalClaims,
                    evaluatedAt,
                    sourceVersion: project.uploadAttemptId,
                    reconciliationHash: reconciliation.reconciliationHash,
                  }
                })(),
              }
            : {}),
        })
      } catch (error) {
        if (error instanceof MediaIntakeHandoffError) throw error
        throw new MediaIntakeHandoffError(
          'INVALID_REVIEW',
          error instanceof Error ? error.message : 'The reviewed media snapshot is invalid.',
        )
      }
      const snapshotHash = mediaIntakeHash(snapshot)
      const capturedAt = new Date()
      const run = await tx.intakeRun.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          status: 'AWAITING_REVIEW',
          displayName: `${project.name.slice(0, 224)} reviewed media proposal`,
          structuredBootstrap: snapshot,
          submissionRequestId: input.requestId,
          submissionInputHash,
          requestedBy: actorId,
          requestedByType: 'HUMAN',
        },
        select: replaySelect,
      })
      await tx.intakeEvidenceRecord.createMany({
        data: [
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            locator: 'media-project-review:snapshot:v1',
            normalizedHash: snapshotHash,
            confidence: 1,
            capturedAt,
          },
          ...snapshot.sources.map((source) => ({
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            sourceKind: 'STRUCTURED_BOOTSTRAP' as const,
            locator: mediaIntakeEvidenceLocator(snapshot, source.sourceId),
            normalizedHash: source.analysisHash,
            confidence: 1,
            capturedAt,
          })),
        ],
      })
      await tx.intakeRunEvent.createMany({
        data: [
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            kind: 'PROPOSAL_CREATED',
            actorId,
            metadata: { sourceKind: 'STRUCTURED_BOOTSTRAP', autoApprove: false, autoApply: false },
          },
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            kind: 'EVIDENCE_RECORDED',
            actorId,
            metadata: {
              evidenceKind: 'MEDIA_PROJECT_REVIEW',
              sourceCount: snapshot.sources.length,
            },
          },
        ],
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'admin.media-ingestion.intake-handoff-created',
          targetType: 'IntakeRun',
          targetId: run.id,
          sourceReferences: snapshot.sources.map((source) => ({
            locator: mediaIntakeEvidenceLocator(snapshot, source.sourceId),
            normalizedHash: source.analysisHash,
          })),
          afterState: {
            status: 'AWAITING_REVIEW',
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            mediaProjectId: input.projectId,
            sourceGeneration: input.sourceGeneration,
            snapshotHash,
            autoApprove: false,
            autoApply: false,
          },
        },
        tx,
      )
      return { runId: run.id, status: run.status, replayed: false }
    },
    { isolationLevel: 'Serializable' },
  )
}
