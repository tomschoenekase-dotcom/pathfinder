import { IntakeUploadReviewList } from '../../../components/admin/IntakeUploadReviewList'

const receivedAt = new Date('2026-08-22T15:00:00.000Z')

export default function IntakeUploadReviewFixturePage() {
  return (
    <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-pf-deep/60">
          Operator fixture
        </p>
        <IntakeUploadReviewList
          uploads={[
            {
              id: 'fixture-upload-queued',
              status: 'PRECHECK_PASSED',
              displayName: 'Visitor guide',
              fileName: 'visitor-guide.pdf',
              mimeType: 'application/pdf',
              byteSize: 2_400_000,
              rejectionCode: null,
              intakeRunId: null,
              verificationOperation: 'QUEUED',
              operatorActionRequired: false,
              createdAt: receivedAt,
            },
            {
              id: 'fixture-upload-running',
              status: 'VERIFYING',
              displayName: 'Audio tour',
              fileName: 'audio-tour.mp4',
              mimeType: 'video/mp4',
              byteSize: 48_000_000,
              rejectionCode: null,
              intakeRunId: null,
              verificationOperation: 'RUNNING',
              operatorActionRequired: false,
              createdAt: receivedAt,
            },
            {
              id: 'fixture-upload-recovery',
              status: 'VERIFYING',
              displayName: 'Accessibility map',
              fileName: 'accessibility-map.png',
              mimeType: 'image/png',
              byteSize: 1_500_000,
              rejectionCode: null,
              intakeRunId: null,
              verificationOperation: 'RECOVERY_QUEUED',
              operatorActionRequired: false,
              createdAt: receivedAt,
            },
          ]}
        />
      </div>
    </main>
  )
}
