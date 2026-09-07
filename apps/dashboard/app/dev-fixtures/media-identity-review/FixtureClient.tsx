'use client'

import { useMemo, useRef } from 'react'
import { mediaEvidenceLocatorId } from '@pathfinder/contracts/media-entity-resolution'
import type { MediaIdentityReviewDataSource } from '../../../components/admin/MediaIdentityReviewPanel'
import { MediaIdentityReviewPanel } from '../../../components/admin/MediaIdentityReviewPanel'

const scope = {
  tenantId: 'fixture-tenant',
  venueId: 'fixture-venue',
  projectId: 'fixture-project',
  sourceGeneration: '11111111-1111-4111-8111-111111111111',
}
const updatedAt = '2026-09-07T12:00:00.000Z'
const uploadAttemptId = '22222222-2222-4222-8222-222222222222'
const rawCandidates = [
  ['mention-a', 'North Hall greenhouse', 'north-hall.mp4'],
  ['mention-b', 'Greenhouse entrance', 'entrance.jpg'],
  ['mention-c', 'South conservatory', 'south.jpg'],
] as const
const candidates = rawCandidates.map(([candidateId, label, sourceId]) => ({
  candidateId,
  label,
  kind: 'extracted-entity',
  identifiers: [],
  contextKeys: [],
  evidence: [
    {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      uploadAttemptId,
      sourceId,
      sourceSha256: 'a'.repeat(64),
      observationIndex: 0,
      observationSha256: 'b'.repeat(64),
    },
  ],
}))

type FixtureReview = Awaited<ReturnType<MediaIdentityReviewDataSource['get']>>

export function FixtureClient() {
  const current = useRef<FixtureReview>(null)
  const dataSource = useMemo<MediaIdentityReviewDataSource>(
    () => ({
      preview: async () => ({ candidates, truncated: false, expectedUpdatedAt: updatedAt }),
      get: async () => current.current,
      save: async (input) => {
        if (input.expectedRevision === 0) {
          current.current = {
            id: '33333333-3333-4333-8333-333333333333',
            revision: 1,
            evidenceSnapshotHash: 'c'.repeat(64),
            createdAt: new Date(updatedAt),
            projection: {
              groups: candidates.map((item) => ({
                representativeId: item.candidateId,
                candidateIds: [item.candidateId],
              })),
              references: candidates.map((item) => ({
                candidateId: item.candidateId,
                representativeId: item.candidateId,
              })),
              activeMergeIds: [],
              relations: [],
              decisionCount: 0,
            },
            candidates: rawCandidates.map(([candidateId, label, sourceId]) => ({
              candidateId,
              label,
              kind: 'extracted-entity',
              evidenceLocatorIds: candidates
                .find((candidate) => candidate.candidateId === candidateId)!
                .evidence.map(mediaEvidenceLocatorId),
              sourceIds: [sourceId],
            })),
            decisions: [],
          }
        } else if (current.current && input.decision?.kind === 'MERGE') {
          const merge = input.decision
          const decision = {
            ...merge,
            requestId: input.requestId,
            reviewerId: 'fixture-reviewer',
          }
          const merged = new Set(merge.candidateIds)
          current.current = {
            ...current.current,
            revision: current.current.revision + 1,
            decisions: [...current.current.decisions, decision],
            projection: {
              groups: [
                {
                  representativeId: merge.representativeId,
                  candidateIds: merge.candidateIds,
                },
                ...current.current.projection.groups.filter(
                  (group) => !group.candidateIds.some((id) => merged.has(id)),
                ),
              ],
              references: current.current.projection.references.map((reference) =>
                merged.has(reference.candidateId)
                  ? {
                      ...reference,
                      representativeId: merge.representativeId,
                    }
                  : reference,
              ),
              activeMergeIds: [...current.current.projection.activeMergeIds, input.requestId],
              relations: current.current.projection.relations,
              decisionCount: current.current.decisions.length + 1,
            },
          }
        } else if (current.current && input.decision?.kind === 'PROPOSE_RELATION') {
          const proposal = input.decision
          const decision = {
            ...proposal,
            requestId: input.requestId,
            reviewerId: 'fixture-reviewer',
          }
          const representatives = new Map(
            current.current.projection.references.map((item) => [
              item.candidateId,
              item.representativeId,
            ]),
          )
          const fromCandidateId = representatives.get(proposal.fromCandidateId)!
          const toCandidateId = representatives.get(proposal.toCandidateId)!
          const { traversal, ...proposalWithoutTraversal } = proposal
          current.current = {
            ...current.current,
            revision: current.current.revision + 1,
            decisions: [...current.current.decisions, decision],
            projection: {
              ...current.current.projection,
              relations: [
                ...current.current.projection.relations,
                {
                  ...proposalWithoutTraversal,
                  ...(traversal ? { traversal } : {}),
                  proposalRequestId: input.requestId,
                  originalFromCandidateId: proposal.fromCandidateId,
                  originalToCandidateId: proposal.toCandidateId,
                  fromCandidateId,
                  toCandidateId,
                  reviewStatus: 'PENDING',
                  reviewRequestId: null,
                  endpointState:
                    fromCandidateId === toCandidateId
                      ? ('COLLAPSED' as const)
                      : ('RESOLVED' as const),
                  ambiguity: 'NONE',
                },
              ],
              decisionCount: current.current.decisions.length + 1,
            },
          }
        } else if (current.current && input.decision?.kind === 'REVIEW_RELATION') {
          const relationReview = input.decision
          current.current = {
            ...current.current,
            revision: current.current.revision + 1,
            decisions: [
              ...current.current.decisions,
              { ...relationReview, requestId: input.requestId, reviewerId: 'fixture-reviewer' },
            ],
            projection: {
              ...current.current.projection,
              relations: current.current.projection.relations.map((relation) =>
                relation.proposalRequestId === relationReview.proposalRequestId
                  ? {
                      ...relation,
                      reviewStatus: relationReview.verdict,
                      reviewRequestId: input.requestId,
                    }
                  : relation,
              ),
              decisionCount: current.current.decisions.length + 1,
            },
          }
        } else if (current.current && input.decision?.kind === 'REVERT_RELATION') {
          const reversion = input.decision
          current.current = {
            ...current.current,
            revision: current.current.revision + 1,
            decisions: [
              ...current.current.decisions,
              { ...reversion, requestId: input.requestId, reviewerId: 'fixture-reviewer' },
            ],
            projection: {
              ...current.current.projection,
              relations: current.current.projection.relations.map((relation) =>
                relation.reviewRequestId === reversion.reviewRequestId
                  ? { ...relation, reviewStatus: 'PENDING', reviewRequestId: null }
                  : relation,
              ),
              decisionCount: current.current.decisions.length + 1,
            },
          }
        }
        return {
          id: current.current!.id,
          revision: current.current!.revision,
          evidenceSnapshotHash: current.current!.evidenceSnapshotHash,
          projection: current.current!.projection,
          replayed: false,
        }
      },
    }),
    [],
  )

  return (
    <MediaIdentityReviewPanel
      scope={scope}
      expectedUpdatedAt={updatedAt}
      blocked={false}
      dataSource={dataSource}
    />
  )
}
