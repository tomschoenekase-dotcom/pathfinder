import { CalendarDays, ExternalLink } from 'lucide-react'

import { safeGoogleWorkspaceSourceUrl } from '../../lib/google-workspace-source-url'

type MeetingExtraction = {
  id: string
  type: string
  content: string
}

type TranscriptArtifactMetadata = {
  id: string
  sourceReference: string
  acquiredAt: Date | string
  expiresAt: Date | string
}

export type ProspectMeeting = {
  id: string
  title: string
  meetingType: string
  startedAt: Date | string
  processingStatus: string
  transcriptStatus: string
  summary: string | null
  sourceArtifactRef: string | null
  extractions: MeetingExtraction[]
  transcriptArtifacts: TranscriptArtifactMetadata[]
}

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export function ProspectMeetingHistory({ meetings }: { meetings: ProspectMeeting[] }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-sky-700" aria-hidden="true" />
        <h2 className="font-semibold text-slate-950">Meetings</h2>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Torchiko keeps compact meeting knowledge and provenance. Full transcript retrieval remains
        in the authorized Google Workspace source.
      </p>
      {!meetings.length ? (
        <p className="mt-4 text-sm text-slate-500">No meetings recorded yet.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {meetings.map((meeting) => {
            const browserSource = safeGoogleWorkspaceSourceUrl(meeting.sourceArtifactRef)
            const transcript = meeting.transcriptArtifacts[0] ?? null
            const transcriptBrowserSource = safeGoogleWorkspaceSourceUrl(
              transcript?.sourceReference,
            )
            const source = browserSource ?? transcriptBrowserSource
            return (
              <article key={meeting.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-slate-900">{meeting.title}</h3>
                  <time className="text-xs text-slate-400">
                    {new Date(meeting.startedAt).toLocaleString()}
                  </time>
                </div>
                <p className="mt-1 text-xs font-semibold uppercase text-slate-500">
                  {label(meeting.meetingType)} · {label(meeting.processingStatus)} · transcript{' '}
                  {label(meeting.transcriptStatus)}
                </p>
                {meeting.summary ? (
                  <p className="mt-3 text-sm leading-6 text-slate-700">{meeting.summary}</p>
                ) : null}
                {meeting.extractions.length ? (
                  <ul className="mt-3 space-y-1 text-xs text-slate-600">
                    {meeting.extractions.slice(0, 5).map((extraction) => (
                      <li key={extraction.id}>
                        <span className="font-semibold">{label(extraction.type)}:</span>{' '}
                        {extraction.content}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {transcript ? (
                  <p className="mt-3 text-xs text-slate-500">
                    Transcript metadata retained through{' '}
                    {new Date(transcript.expiresAt).toLocaleDateString()}.
                  </p>
                ) : null}
                {source ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-sky-800 hover:border-sky-400 hover:bg-sky-50"
                  >
                    <span className="break-words">Open meeting source in Google {source.kind}</span>
                    <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                  </a>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    {transcript
                      ? 'Transcript provenance is recorded as an API-only reference; authorized Workspace tooling is required to retrieve it.'
                      : 'Original meeting source link unavailable.'}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
