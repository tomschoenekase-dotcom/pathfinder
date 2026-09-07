'use client'

import { useMemo } from 'react'

import {
  MediaIntakeHandoffPanel,
  type MediaIntakeHandoffAdapter,
} from '../../../components/admin/MediaIntakeHandoffPanel'
import { TRPCProvider } from '../../../lib/trpc'
import { MediaIntakeEvidenceReader } from '../../../components/admin/MediaIntakeEvidenceReader'

export function FixtureClient() {
  const adapter = useMemo<MediaIntakeHandoffAdapter>(() => {
    let firstRequest: string | null = null
    return {
      preview: async ({ sourceCursor }) => ({
        sourceGeneration: '5c4cae78-84b6-41b7-a152-6593566eeb72',
        updatedAt: '2026-09-07T07:30:00.000Z',
        ready: true,
        issues: [],
        items: [
          {
            kind: 'place',
            itemIndex: 0,
            itemHash: 'a'.repeat(64),
            label: 'North Hall and the east entrance visitor information desk',
          },
          {
            kind: 'knowledge',
            itemIndex: 0,
            itemHash: 'b'.repeat(64),
            label: 'Arrival assistance',
          },
        ],
        sources: sourceCursor
          ? [{ sourceId: 's2', filename: 'reception-assistance-sign.jpg' }]
          : [{ sourceId: 's1', filename: 'north-hall-walkthrough.mp4' }],
        nextSourceCursor: sourceCursor ? null : 's1',
      }),
      previewTemporal: async ({ claims }) => ({
        evaluatedAt: '2026-09-07T12:00:00.000Z',
        authorityBasis: 'REVIEW_ASSERTED',
        authorityVerified: false,
        reviewReceiptHash: 'c'.repeat(64),
        reconciliation: {
          comparisonCount: 1,
          comparisonsTruncated: false,
          selectedClaimIds: claims.map((claim) => claim.claimId),
        },
        items: [
          {
            kind: 'place',
            itemIndex: 0,
            itemHash: 'a'.repeat(64),
            label: 'North Hall and the east entrance visitor information desk',
            handoffStatus: 'HELD',
            holdReasons: ['DATE_BOUND', 'NO_CURRENT_SUPPORT'],
          },
          {
            kind: 'knowledge',
            itemIndex: 0,
            itemHash: 'b'.repeat(64),
            label: 'Arrival assistance',
            handoffStatus: 'ELIGIBLE',
            holdReasons: [],
          },
        ],
      }),
      create: async (request) => {
        if (firstRequest === null) {
          firstRequest = JSON.stringify(request)
          throw new Error('Synthetic acknowledgement loss')
        }
        if (JSON.stringify(request) !== firstRequest)
          throw new Error('Retry changed the retained request')
        return { runId: 'fixture-media-review-run' }
      },
    }
  }, [])
  return (
    <TRPCProvider scopeKey="media-handoff-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <p className="mb-5 text-sm text-pf-deep/70">Synthetic saved media review</p>
          <MediaIntakeHandoffPanel
            scope={{
              tenantId: 'fixture-tenant',
              venueId: 'fixture-venue',
              projectId: 'fixture-project',
            }}
            blocked={false}
            adapter={adapter}
          />
          <MediaIntakeEvidenceReader
            scope={{
              tenantId: 'fixture-tenant',
              venueId: 'fixture-venue',
              runId: 'fixture-media-review-run',
            }}
            readPage={async ({ runId, offset }) => ({
              runId,
              offset,
              snapshotHash: 'a'.repeat(64),
              totalCodeUnits: 40000,
              sourceCount: 2,
              text:
                offset === 0
                  ? 'Retained source: north-hall-walkthrough.mp4\nMethod: Google static video, 1 frame per second.\nUncertainty: the route beyond the sign was not filmed.'
                  : 'Retained source: reception-assistance-sign.jpg\nReview: confirmed the visible assistance sign. No routing inference was accepted.',
              nextOffset: offset === 0 ? 20000 : null,
            })}
          />
        </div>
      </main>
    </TRPCProvider>
  )
}
