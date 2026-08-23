import { ProspectMeetingHistory } from '../../../components/admin/ProspectMeetingHistory'

export default function ProspectMeetingsFixturePage() {
  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
      <div className="mx-auto max-w-3xl">
        <ProspectMeetingHistory
          meetings={[
            {
              id: 'meeting-1',
              title: 'Lakeside planning call',
              meetingType: 'GOOGLE_CALENDAR:DEFAULT',
              startedAt: '2026-08-22T15:00:00Z',
              processingStatus: 'PROCESSED',
              transcriptStatus: 'AVAILABLE',
              summary: 'The team reviewed visitor hours, fall programming, and remote onboarding.',
              sourceArtifactRef: 'https://calendar.google.com/calendar/event?eid=event_1',
              extractions: [
                { id: 'extraction-1', type: 'DECISION', content: 'Publish the fall hours.' },
                {
                  id: 'extraction-2',
                  type: 'FOLLOW_UP',
                  content: 'Send the onboarding checklist.',
                },
              ],
              transcriptArtifacts: [
                {
                  id: 'artifact-1',
                  sourceReference:
                    'https://meet.googleapis.com/v2/conferenceRecords/one/transcripts/two',
                  acquiredAt: '2026-08-22T16:00:00Z',
                  expiresAt: '2027-08-22T16:00:00Z',
                },
              ],
            },
            {
              id: 'meeting-2',
              title: 'API-only transcript provenance',
              meetingType: 'GOOGLE_MEET',
              startedAt: '2026-08-20T15:00:00Z',
              processingStatus: 'PROCESSED',
              transcriptStatus: 'AVAILABLE',
              summary: 'This fixture proves the honest unavailable state.',
              sourceArtifactRef:
                'https://meet.googleapis.com/v2/conferenceRecords/three/transcripts/four',
              extractions: [],
              transcriptArtifacts: [
                {
                  id: 'artifact-2',
                  sourceReference:
                    'https://meet.googleapis.com/v2/conferenceRecords/three/transcripts/four',
                  acquiredAt: '2026-08-20T16:00:00Z',
                  expiresAt: '2027-08-20T16:00:00Z',
                },
              ],
            },
          ]}
        />
      </div>
    </main>
  )
}
