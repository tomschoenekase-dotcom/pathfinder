import { z } from 'zod'

export const GOOGLE_MEET_TRANSCRIPT_RETENTION_DAYS = 365

export const GoogleCalendarEventStatus = z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED'])
export type GoogleCalendarEventStatus = z.infer<typeof GoogleCalendarEventStatus>

export const GoogleCalendarAttendee = z
  .object({
    email: z.string().email().max(320),
    displayName: z.string().trim().max(191).nullable().default(null),
    responseStatus: z.string().trim().max(64).nullable().default(null),
    organizer: z.boolean().default(false),
    self: z.boolean().default(false),
  })
  .strict()
export type GoogleCalendarAttendee = z.infer<typeof GoogleCalendarAttendee>

/** Durable source projection. Descriptions and inferred commitments are intentionally excluded. */
export const GoogleCalendarEventProjection = z
  .object({
    providerAccountId: z.string().trim().min(1).max(191),
    calendarId: z.string().trim().min(1).max(512),
    externalEventId: z.string().trim().min(1).max(1024),
    iCalUid: z.string().trim().max(1024).nullable(),
    recurringEventId: z.string().trim().max(1024).nullable(),
    originalStartAt: z.string().datetime({ offset: true }).nullable(),
    title: z.string().trim().max(500),
    eventType: z.string().trim().min(1).max(100),
    status: GoogleCalendarEventStatus,
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }).nullable(),
    timeZone: z.string().trim().min(1).max(100),
    organizerEmail: z.string().email().max(320).nullable(),
    attendees: z.array(GoogleCalendarAttendee).max(500),
    sourceReference: z.string().url().max(1000),
    providerUpdatedAt: z.string().datetime({ offset: true }),
    sequence: z.number().int().min(0),
  })
  .strict()
export type GoogleCalendarEventProjection = z.infer<typeof GoogleCalendarEventProjection>

export const GoogleMeetTranscriptEntry = z
  .object({
    externalEntryId: z.string().trim().min(1).max(1000),
    participantReference: z.string().trim().min(1).max(1000),
    text: z.string().max(100_000),
    languageCode: z.string().trim().min(1).max(35),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
  })
  .strict()
export type GoogleMeetTranscriptEntry = z.infer<typeof GoogleMeetTranscriptEntry>

/** A transcript-only artifact. There is deliberately no recording locator or payload field. */
export const GoogleMeetTranscriptArtifact = z
  .object({
    conferenceRecordName: z.string().trim().min(1).max(1000),
    transcriptName: z.string().trim().min(1).max(1000),
    sourceReference: z.string().url().max(1000),
    entries: z.array(GoogleMeetTranscriptEntry).max(10_000),
    acquiredAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((artifact, context) => {
    const acquiredAt = new Date(artifact.acquiredAt)
    const expiresAt = new Date(artifact.expiresAt)
    const expected = new Date(acquiredAt)
    expected.setUTCDate(expected.getUTCDate() + GOOGLE_MEET_TRANSCRIPT_RETENTION_DAYS)
    if (expiresAt.getTime() !== expected.getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Meet transcript expiry must be exactly 365 days after acquisition',
      })
    }
  })
export type GoogleMeetTranscriptArtifact = z.infer<typeof GoogleMeetTranscriptArtifact>

export const GmailBodyRetentionState = z.enum([
  'NOT_STORED',
  'TEMPORARY',
  'LEGACY_REVIEW_REQUIRED',
  'LEGAL_HOLD',
  'REMOVED',
])
export type GmailBodyRetentionState = z.infer<typeof GmailBodyRetentionState>

export type GmailBodyRetentionInventoryRow = Readonly<{
  id: string
  state: GmailBodyRetentionState
  hasTextBody: boolean
  hasHtmlBody: boolean
  expiresAt: Date | null
}>

export type GmailBodyRetentionDryRun = Readonly<{
  scanned: number
  sourceOnly: number
  temporaryActive: number
  eligibleForRemoval: number
  legacyReviewRequired: number
  legalHold: number
  inconsistent: readonly string[]
}>

/** Read-only classification. This function never mutates or authorizes deletion. */
export function buildGmailBodyRetentionDryRun(
  rows: readonly GmailBodyRetentionInventoryRow[],
  now: Date,
): GmailBodyRetentionDryRun {
  let sourceOnly = 0
  let temporaryActive = 0
  let eligibleForRemoval = 0
  let legacyReviewRequired = 0
  let legalHold = 0
  const inconsistent: string[] = []

  for (const row of rows) {
    const hasBody = row.hasTextBody || row.hasHtmlBody
    if (row.state === 'LEGAL_HOLD') legalHold += 1
    if (row.state === 'LEGACY_REVIEW_REQUIRED') legacyReviewRequired += 1
    if (!hasBody) sourceOnly += 1
    if (row.state === 'TEMPORARY') {
      if (!row.expiresAt || !hasBody) inconsistent.push(row.id)
      else if (row.expiresAt <= now) eligibleForRemoval += 1
      else temporaryActive += 1
    }
    if ((row.state === 'NOT_STORED' || row.state === 'REMOVED') && hasBody) {
      inconsistent.push(row.id)
    }
  }

  return {
    scanned: rows.length,
    sourceOnly,
    temporaryActive,
    eligibleForRemoval,
    legacyReviewRequired,
    legalHold,
    inconsistent: [...new Set(inconsistent)].sort(),
  }
}
