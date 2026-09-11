import { notFound } from 'next/navigation'
import { MediaIngestionReview } from '../../../components/admin/MediaIngestionReview'
import { TRPCProvider } from '../../../lib/trpc'

export default function MediaReviewFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  const at = new Date('2026-09-07T00:00:00Z')
  const project = {
    id: 'fixture-project',
    tenantId: 'fixture-tenant',
    venueId: 'fixture-venue',
    name: 'North Hall walkthrough',
    context: '',
    mode: 'BALANCED' as const,
    status: 'READY_FOR_REVIEW' as const,
    stage: 'review',
    progress: 100,
    sourceFileName: 'walkthrough.zip',
    sourceBytes: 1024,
    sourceLastModified: 123,
    sourceFingerprintAlgorithm: 'pathfinder-sha256-part-manifest-v1',
    uploadAttemptId: null,
    settings: {},
    coverage: {},
    questions: [],
    findings: [
      {
        sourceId: 'S-1',
        filename: 'north-hall.mp4',
        mediaType: 'VIDEO' as const,
        summary: 'The sign reads North Hall.',
        uncertainties: ['The entrance beyond the sign was not visible.'],
        videoAnalysisMethod: 'GOOGLE_STATIC_VIDEO_1FPS' as const,
        videoAnalysisCoverage: {
          inputScope: 'uploaded-video',
          visualCoverage: 'provider-static-1fps',
          audioCoverage: 'provider-video-audio',
          exhaustiveFrames: false,
        },
        observations: [
          {
            kind: 'visible_text',
            statement: 'North Hall',
            evidenceChannel: 'visible_text',
            directness: 'observed',
            confidence: 'probable',
            startSeconds: 12,
            endSeconds: 13,
          },
        ],
      },
    ],
    findingsNextCursor: null,
    draftJson: {
      schemaVersion: 1,
      places: [{ name: 'North Hall', type: 'room', tags: [], importanceScore: 50 }],
      knowledgeEntries: [],
    },
    estimatedCostCents: null,
    actualCostCents: 0,
    error: null,
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    reviewGeneration: '00000000-0000-4000-8000-000000000001',
    assets: [],
    assetsTruncated: false,
  } satisfies Parameters<typeof MediaIngestionReview>[0]['initialProject']
  return (
    <TRPCProvider scopeKey="media-review-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <p className="mb-4 text-sm text-pf-deep">Synthetic media review fixture</p>
          <MediaIngestionReview initialProject={project} />
        </div>
      </main>
    </TRPCProvider>
  )
}
