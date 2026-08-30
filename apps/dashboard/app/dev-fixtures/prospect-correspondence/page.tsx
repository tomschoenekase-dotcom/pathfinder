import { ProspectCorrespondenceHistory } from '../../../components/admin/ProspectCorrespondenceHistory'
import { TRPCProvider } from '../../../lib/trpc'

export default function ProspectCorrespondenceFixturePage() {
  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
      <TRPCProvider scopeKey="fixture:prospect-correspondence">
        <div className="mx-auto max-w-3xl">
          <ProspectCorrespondenceHistory
            threads={[
              {
                id: 'thread-1',
                subject: 'Updated visitor hours and fall programming',
                messages: [
                  {
                    id: 'message-1',
                    direction: 'INBOUND',
                    status: 'RECEIVED',
                    fromAddress: 'curator@lakeside.example',
                    toAddresses: ['team@torchiko.com'],
                    bodyPreview:
                      'We updated visitor hours for September and added the fall sculpture program. The original Gmail message remains the canonical source.',
                    sourceReference:
                      'https://mail.google.com/mail/u/team%40torchiko.com/#all/message%2Fone',
                    attachmentMetadata: [
                      {
                        providerAttachmentId: 'attachment-1',
                        filename: 'lakeside-visitor-map.pdf',
                        mimeType: 'application/pdf',
                        sizeBytes: 245760,
                        downloadPolicy: 'METADATA_ONLY' as const,
                      },
                    ],
                    attachmentRetentionRequests: [
                      {
                        id: '33333333-3333-4333-8333-333333333333',
                        providerAttachmentId: 'attachment-1',
                        status: 'AWAITING_REVIEW' as const,
                        category: 'FLOOR_PLAN_OR_MAP' as const,
                        purpose: 'Potential source material for the visitor guide.',
                        reviewReason: null,
                      },
                    ],
                    occurredAt: '2026-08-22T12:00:00Z',
                  },
                  {
                    id: 'message-2',
                    direction: 'OUTBOUND',
                    status: 'SENT',
                    fromAddress: 'team@torchiko.com',
                    toAddresses: ['curator@lakeside.example'],
                    bodyPreview: 'Thanks—we recorded the update for review.',
                    sourceReference: null,
                    occurredAt: '2026-08-22T13:00:00Z',
                  },
                ],
              },
            ]}
            enableRetentionActions
          />
        </div>
      </TRPCProvider>
    </main>
  )
}
