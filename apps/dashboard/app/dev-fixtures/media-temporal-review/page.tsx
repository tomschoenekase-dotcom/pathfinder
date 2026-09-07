'use client'

import { useMemo } from 'react'
import { TRPCProvider } from '../../../lib/trpc'
import {
  MediaTemporalReviewPanel,
  type MediaTemporalReviewAdapter,
} from '../../../components/admin/MediaTemporalReviewPanel'

export default function MediaTemporalReviewFixture() {
  const adapter = useMemo<MediaTemporalReviewAdapter>(() => {
    let readAttempts = 0
    return {
      retain: async () => ({
        receiptId: '22222222-2222-4222-8222-222222222222',
        snapshotHash: 'e'.repeat(64),
        requestHash: 'f'.repeat(64),
        heldItems: [
          { itemHash: 'a'.repeat(64), reasons: ['DATE_BOUND'] },
          { itemHash: '9'.repeat(64), reasons: ['CONFLICT'] },
        ],
        replayed: false,
      }),
      readEvidence: async ({ offset }) => {
        readAttempts += 1
        if (readAttempts === 1) throw new Error('Fixture read acknowledgement loss')
        return {
          receiptId: '22222222-2222-4222-8222-222222222222',
          snapshotHash: 'e'.repeat(64),
          requestHash: 'f'.repeat(64),
          text:
            offset === 0
              ? '{\n  "target": "North entrance hours",\n  "outcome": "HELD"\n}'
              : '{\n  "target": "North entrance access",\n  "outcome": "HELD"\n}',
          offset,
          nextOffset: offset === 0 ? 64 : null,
          totalCodeUnits: 128,
        }
      },
      clarify: async () => ({ questionId: 'local-question-1', replayed: false }),
    }
  }, [])
  return (
    <TRPCProvider scopeKey="temporal-review-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <p className="mb-4 text-sm text-pf-deep/65">Reviewed media · North entrance</p>
          <MediaTemporalReviewPanel
            scope={{
              tenantId: 'fixture-tenant',
              venueId: 'fixture-venue',
              projectId: 'fixture-project',
            }}
            sourceGeneration="11111111-1111-4111-8111-111111111111"
            expectedUpdatedAt="2026-09-07T10:00:00.000Z"
            rationale="Both reviewed claims are date-bound and remain local."
            claims={[
              {
                claimId: 'hours',
                targetKey: 'entrance:hours',
                targetItemHash: 'a'.repeat(64),
                claimType: 'TEMPORARY_SCHEDULE',
                value: 'Open until six',
                valueHash: 'b'.repeat(64),
                authority: 'AUTHORIZED_STAFF',
                consequential: true,
                effectiveFrom: '2026-09-07T00:00:00.000Z',
                effectiveUntil: '2026-09-08T00:00:00.000Z',
                source: {
                  sourceId: 'schedule',
                  sourceSha256: 'c'.repeat(64),
                  sourceVersion: '11111111-1111-4111-8111-111111111111',
                  capturedAt: null,
                  observationIndex: 0,
                  observationSha256: 'd'.repeat(64),
                },
              },
              {
                claimId: 'access',
                targetKey: 'entrance:access',
                targetItemHash: '9'.repeat(64),
                claimType: 'STABLE_FACT',
                value: 'Ramp access requires confirmation',
                valueHash: '8'.repeat(64),
                authority: 'UNKNOWN',
                consequential: true,
                source: {
                  sourceId: 'schedule',
                  sourceSha256: 'c'.repeat(64),
                  sourceVersion: '11111111-1111-4111-8111-111111111111',
                  capturedAt: null,
                  observationIndex: 1,
                  observationSha256: '7'.repeat(64),
                },
              },
            ]}
            bindings={[
              {
                kind: 'knowledge',
                itemIndex: 0,
                itemHash: 'a'.repeat(64),
                sourceIds: ['schedule'],
              },
              {
                kind: 'place',
                itemIndex: 0,
                itemHash: '9'.repeat(64),
                sourceIds: ['schedule'],
              },
            ]}
            allHeld
            blocked={false}
            adapter={adapter}
          />
        </div>
      </main>
    </TRPCProvider>
  )
}
