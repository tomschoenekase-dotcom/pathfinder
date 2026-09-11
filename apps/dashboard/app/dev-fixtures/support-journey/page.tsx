import { SupportWorkspace } from '../../../components/SupportWorkspace'
import { TRPCProvider } from '../../../lib/trpc'

const venue = { id: 'fixture-venue', name: 'Harbor History Museum' }
const completed = {
  id: 'fixture-support-request',
  venueId: venue.id,
  category: 'CONTENT_CORRECTION',
  status: 'COMPLETED',
  subject: 'Clarify the accessible entrance',
  missingInformation: [],
  clientVersion: 3,
  clientActivityAt: '2026-09-06T18:15:00.000Z',
  requesterIsCurrentUser: true,
  participantIsCurrentUser: false,
  canReply: true,
  statusChangedAt: '2026-09-06T18:15:00.000Z',
  createdAt: '2026-09-04T15:00:00.000Z',
  messages: [
    {
      id: 'fixture-client-message',
      authorKind: 'CLIENT',
      authorIsCurrentUser: true,
      body: 'Please note that the accessible entrance is on Harbor Street.',
      createdAt: '2026-09-04T15:00:00.000Z',
      attachments: [],
    },
    {
      id: 'fixture-support-message',
      authorKind: 'PLATFORM_ADMIN',
      authorIsCurrentUser: false,
      body: 'The visitor guidance has been reviewed and updated.',
      createdAt: '2026-09-06T18:15:00.000Z',
      attachments: [],
    },
  ],
  nextMessageCursor: null,
}

export default function SupportJourneyFixture() {
  return (
    <TRPCProvider scopeKey="support-journey-fixture">
      <SupportWorkspace
        venues={[venue]}
        activeVenue={venue}
        initialRequests={[completed]}
        initialNextCursor={null}
        initialDetail={completed}
        initialEligibleAttachments={[]}
        initialEligibleAttachmentsNextCursor={null}
      />
    </TRPCProvider>
  )
}
