import { ProspectCorrespondenceHistory } from '../../../components/admin/ProspectCorrespondenceHistory'

export default function ProspectCorrespondenceFixturePage() {
  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
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
        />
      </div>
    </main>
  )
}
