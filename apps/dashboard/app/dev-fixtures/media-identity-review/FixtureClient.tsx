'use client'

import { useMemo, useRef } from 'react'
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
      ...scope,
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
              decisionCount: 0,
            },
            candidates: rawCandidates.map(([candidateId, label, sourceId]) => ({
              candidateId,
              label,
              kind: 'extracted-entity',
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
