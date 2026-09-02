import {
  GOOGLE_MEET_TRANSCRIPT_RETENTION_DAYS,
  GoogleMeetTranscriptArtifact,
  type GoogleMeetTranscriptArtifact as GoogleMeetTranscriptArtifactType,
} from '@pathfinder/contracts/google-workspace-source'

import {
  GoogleCalendarSourceError,
  type GoogleWorkspaceCredentialLeaseProvider,
} from './calendar-source'

const MAX_SOURCE_PAGES = 100

function retainNextPageToken(seen: Set<string>, token: string | undefined) {
  if (!token) return undefined
  if (seen.size >= MAX_SOURCE_PAGES || seen.has(token)) {
    throw new GoogleCalendarSourceError('PERMANENT', 'Google source pagination did not converge')
  }
  seen.add(token)
  return token
}

export type GoogleMeetTranscript = Readonly<{ name: string }>
export type GoogleMeetTranscriptEntry = Readonly<{
  name: string
  participant: string
  text: string
  languageCode: string
  startTime: string
  endTime: string
}>

export type GoogleMeetApiClient = Readonly<{
  listTranscripts(input: {
    accessToken: string
    conferenceRecordName: string
    pageToken?: string
  }): Promise<{ transcripts: readonly GoogleMeetTranscript[]; nextPageToken?: string }>
  listTranscriptEntries(input: {
    accessToken: string
    transcriptName: string
    pageToken?: string
  }): Promise<{ entries: readonly GoogleMeetTranscriptEntry[]; nextPageToken?: string }>
}>

export type GoogleMeetTranscriptStore = Readonly<{
  upsertTranscript(input: {
    providerAccountId: string
    meetingId: string
    artifact: GoogleMeetTranscriptArtifactType
  }): Promise<'INSERTED' | 'UNCHANGED'>
  markTranscriptUnavailable(input: {
    providerAccountId: string
    meetingId: string
    conferenceRecordName: string
    checkedAt: Date
  }): Promise<void>
}>

function expiresOneYearAfter(acquiredAt: Date) {
  const expiresAt = new Date(acquiredAt)
  expiresAt.setUTCDate(expiresAt.getUTCDate() + GOOGLE_MEET_TRANSCRIPT_RETENTION_DAYS)
  return expiresAt
}

/** Transcript-only acquisition. The API surface intentionally exposes no recording method. */
export function createGoogleMeetTranscriptSource(dependencies: {
  credentials: GoogleWorkspaceCredentialLeaseProvider
  client: GoogleMeetApiClient
  store: GoogleMeetTranscriptStore
  now?: () => Date
}) {
  const now = dependencies.now ?? (() => new Date())
  return {
    async acquire(input: {
      providerAccountId: string
      credentialReferenceId: string
      meetingId: string
      conferenceRecordName: string
    }) {
      const lease = await dependencies.credentials.lease(input.credentialReferenceId)
      let transcriptPageToken: string | undefined
      const transcripts: GoogleMeetTranscript[] = []
      const transcriptPageTokens = new Set<string>()
      do {
        const page = await lease.withAccessToken((accessToken) =>
          dependencies.client.listTranscripts({
            accessToken,
            conferenceRecordName: input.conferenceRecordName,
            ...(transcriptPageToken ? { pageToken: transcriptPageToken } : {}),
          }),
        )
        transcripts.push(...page.transcripts)
        transcriptPageToken = retainNextPageToken(transcriptPageTokens, page.nextPageToken)
      } while (transcriptPageToken)

      const acquiredAt = now()
      if (transcripts.length === 0) {
        await dependencies.store.markTranscriptUnavailable({
          providerAccountId: input.providerAccountId,
          meetingId: input.meetingId,
          conferenceRecordName: input.conferenceRecordName,
          checkedAt: acquiredAt,
        })
        return { state: 'UNAVAILABLE' as const, acquired: 0 }
      }

      let acquired = 0
      for (const transcript of transcripts) {
        let entryPageToken: string | undefined
        const entries: GoogleMeetTranscriptEntry[] = []
        const entryPageTokens = new Set<string>()
        do {
          const page = await lease.withAccessToken((accessToken) =>
            dependencies.client.listTranscriptEntries({
              accessToken,
              transcriptName: transcript.name,
              ...(entryPageToken ? { pageToken: entryPageToken } : {}),
            }),
          )
          entries.push(...page.entries)
          entryPageToken = retainNextPageToken(entryPageTokens, page.nextPageToken)
        } while (entryPageToken)

        const artifact = GoogleMeetTranscriptArtifact.parse({
          conferenceRecordName: input.conferenceRecordName,
          transcriptName: transcript.name,
          sourceReference: `https://meet.googleapis.com/v2/${transcript.name}`,
          entries: entries.map((entry) => ({
            externalEntryId: entry.name,
            participantReference: entry.participant,
            text: entry.text,
            languageCode: entry.languageCode,
            startedAt: new Date(entry.startTime).toISOString(),
            endedAt: new Date(entry.endTime).toISOString(),
          })),
          acquiredAt: acquiredAt.toISOString(),
          expiresAt: expiresOneYearAfter(acquiredAt).toISOString(),
        })
        await dependencies.store.upsertTranscript({
          providerAccountId: input.providerAccountId,
          meetingId: input.meetingId,
          artifact,
        })
        acquired += 1
      }
      return { state: 'AVAILABLE' as const, acquired }
    },
  }
}
