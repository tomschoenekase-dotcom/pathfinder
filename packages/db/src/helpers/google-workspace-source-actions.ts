import { createHash } from 'node:crypto'

import type {
  GoogleCalendarEventProjection,
  GoogleMeetTranscriptArtifact,
} from '@pathfinder/contracts/google-workspace-source'
import { parseVerifiedActorContext, type VerifiedActorContext } from '@pathfinder/contracts/actor'
import type { InputJsonValue } from '@prisma/client/runtime/library'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type GoogleWorkspaceSourceClient = Pick<typeof db, '$transaction'>

function identity(parts: readonly string[]) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function json(value: unknown): InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as InputJsonValue
}

async function assertGmailAccount(tx: typeof db, providerAccountId: string) {
  const account = await tx.correspondenceProviderAccount.findFirst({
    where: {
      id: providerAccountId,
      provider: 'GMAIL',
      connectionStatus: { notIn: ['DISCONNECTED', 'DISABLED'] },
    },
    select: { id: true },
  })
  if (!account) throw new Error('Connected Google Workspace provider account was not found')
}

async function resolvedAttendees(tx: typeof db, event: GoogleCalendarEventProjection) {
  const emails = [...new Set(event.attendees.map((item) => item.email.toLowerCase()))]
  const contacts = emails.length
    ? await tx.prospectContact.findMany({
        where: { normalizedEmail: { in: emails }, archivedAt: null },
        select: { id: true, normalizedEmail: true, organizationId: true },
      })
    : []
  const byEmail = new Map<string, typeof contacts>()
  for (const contact of contacts) {
    if (!contact.normalizedEmail) continue
    const key = contact.normalizedEmail.toLowerCase()
    byEmail.set(key, [...(byEmail.get(key) ?? []), contact])
  }
  const uniqueContacts = event.attendees.map((attendee) => {
    const matches = byEmail.get(attendee.email.toLowerCase()) ?? []
    return { attendee, contact: matches.length === 1 ? matches[0]! : null }
  })
  const organizations = new Set(
    uniqueContacts.flatMap(({ contact }) => (contact ? [contact.organizationId] : [])),
  )
  return {
    attendees: uniqueContacts,
    organizationId: organizations.size === 1 ? [...organizations][0]! : null,
  }
}

/** Prisma adapters for the API source interfaces. Every write is provenance-bearing and audited. */
export function createGoogleWorkspaceSourceStores(
  input: { actor: VerifiedActorContext },
  client: GoogleWorkspaceSourceClient = db,
) {
  const actor = parseVerifiedActorContext(input.actor)
  if (actor.type !== 'INTEGRATION' && actor.type !== 'SYSTEM') {
    throw new Error('Google Workspace source persistence requires integration or system authority')
  }

  return {
    calendar: {
      async upsertEvent(event: GoogleCalendarEventProjection) {
        return client.$transaction(async (rawTx) => {
          const tx = rawTx as unknown as typeof db
          await assertGmailAccount(tx, event.providerAccountId)
          const existing = await tx.companyMeeting.findUnique({
            where: {
              providerAccountId_calendarId_externalId: {
                providerAccountId: event.providerAccountId,
                calendarId: event.calendarId,
                externalId: event.externalEventId,
              },
            },
            select: { id: true, eventSequence: true, providerUpdatedAt: true },
          })
          if (
            existing &&
            (existing.eventSequence ?? 0) === event.sequence &&
            existing.providerUpdatedAt?.toISOString() === event.providerUpdatedAt
          ) {
            return 'UNCHANGED' as const
          }
          const resolved = await resolvedAttendees(tx, event)
          const data = {
            providerAccountId: event.providerAccountId,
            calendarId: event.calendarId,
            externalProvider: 'google-calendar',
            externalId: event.externalEventId,
            iCalUid: event.iCalUid,
            recurringEventId: event.recurringEventId,
            originalStartAt: event.originalStartAt ? new Date(event.originalStartAt) : null,
            eventStatus: event.status,
            eventTimeZone: event.timeZone,
            organizerEmail: event.organizerEmail,
            providerUpdatedAt: new Date(event.providerUpdatedAt),
            eventSequence: event.sequence,
            title: event.title || '(untitled Google Calendar event)',
            meetingType: `GOOGLE_CALENDAR:${event.eventType}`.slice(0, 100),
            startedAt: new Date(event.startAt),
            endedAt: event.endAt ? new Date(event.endAt) : null,
            sourceArtifactRef: event.sourceReference,
            ...(resolved.organizationId ? { organizationId: resolved.organizationId } : {}),
            processingProvenance: {
              source: 'google-calendar',
              sourceReference: event.sourceReference,
              commitmentInference: 'DISALLOWED_FROM_TITLE',
            },
          }
          const meeting = existing
            ? await tx.companyMeeting.update({
                where: { id: existing.id },
                data,
                select: { id: true },
              })
            : await tx.companyMeeting.create({
                data: {
                  ...data,
                  idempotencyKey: `google-calendar:${identity([
                    event.providerAccountId,
                    event.calendarId,
                    event.externalEventId,
                  ])}`,
                },
                select: { id: true },
              })
          await tx.companyMeetingParticipant.deleteMany({ where: { meetingId: meeting.id } })
          if (resolved.attendees.length > 0) {
            await tx.companyMeetingParticipant.createMany({
              data: resolved.attendees.map(({ attendee, contact }) => ({
                meetingId: meeting.id,
                ...(contact ? { contactId: contact.id } : {}),
                displayName: attendee.displayName,
                email: attendee.email,
                responseStatus: attendee.responseStatus,
                isOrganizer: attendee.organizer,
                isSelf: attendee.self,
                isTorchiko: attendee.email.toLowerCase().endsWith('@torchiko.com'),
                externalRef: `mailto:${attendee.email}`,
              })),
            })
          }
          await writeAuditLogStrict(
            {
              actor,
              action: existing
                ? 'company-meeting.calendar-updated'
                : 'company-meeting.calendar-ingested',
              targetType: 'CompanyMeeting',
              targetId: meeting.id,
              idempotencyKey: `google-calendar:${identity([event.providerAccountId, event.calendarId, event.externalEventId])}`,
              sourceReferences: [{ ref: event.sourceReference }],
              afterState: { eventStatus: event.status, eventSequence: event.sequence },
            },
            tx,
          )
          return existing ? ('UPDATED' as const) : ('INSERTED' as const)
        })
      },

      async applyCancellation(cancellation: {
        providerAccountId: string
        calendarId: string
        externalEventId: string
        recurringEventId: string | null
        originalStartAt: string | null
        providerUpdatedAt: string
      }) {
        return client.$transaction(async (rawTx) => {
          const tx = rawTx as unknown as typeof db
          await assertGmailAccount(tx, cancellation.providerAccountId)
          const existing = await tx.companyMeeting.findUnique({
            where: {
              providerAccountId_calendarId_externalId: {
                providerAccountId: cancellation.providerAccountId,
                calendarId: cancellation.calendarId,
                externalId: cancellation.externalEventId,
              },
            },
            select: { id: true, eventStatus: true },
          })
          if (existing?.eventStatus === 'CANCELLED') return 'UNCHANGED' as const
          const occurredAt = new Date(
            cancellation.originalStartAt ?? cancellation.providerUpdatedAt,
          )
          const meeting = existing
            ? await tx.companyMeeting.update({
                where: { id: existing.id },
                data: {
                  eventStatus: 'CANCELLED',
                  providerUpdatedAt: new Date(cancellation.providerUpdatedAt),
                },
                select: { id: true },
              })
            : await tx.companyMeeting.create({
                data: {
                  providerAccountId: cancellation.providerAccountId,
                  calendarId: cancellation.calendarId,
                  externalProvider: 'google-calendar',
                  externalId: cancellation.externalEventId,
                  recurringEventId: cancellation.recurringEventId,
                  originalStartAt: cancellation.originalStartAt
                    ? new Date(cancellation.originalStartAt)
                    : null,
                  eventStatus: 'CANCELLED',
                  providerUpdatedAt: new Date(cancellation.providerUpdatedAt),
                  title: '(cancelled Google Calendar event)',
                  meetingType: 'GOOGLE_CALENDAR:deleted',
                  startedAt: occurredAt,
                  processingProvenance: { source: 'google-calendar', tombstone: true },
                  idempotencyKey: `google-calendar:${identity([
                    cancellation.providerAccountId,
                    cancellation.calendarId,
                    cancellation.externalEventId,
                  ])}`,
                },
                select: { id: true },
              })
          await writeAuditLogStrict(
            {
              actor,
              action: 'company-meeting.calendar-cancelled',
              targetType: 'CompanyMeeting',
              targetId: meeting.id,
              afterState: { eventStatus: 'CANCELLED' },
            },
            tx,
          )
          return 'CANCELLED' as const
        })
      },

      async commitSyncCursor(cursor: {
        providerAccountId: string
        calendarId: string
        syncToken: string
        completedAt: Date
      }) {
        await client.$transaction(async (rawTx) => {
          const tx = rawTx as unknown as typeof db
          await assertGmailAccount(tx, cursor.providerAccountId)
          await tx.googleCalendarSyncState.upsert({
            where: {
              providerAccountId_calendarId: {
                providerAccountId: cursor.providerAccountId,
                calendarId: cursor.calendarId,
              },
            },
            create: {
              providerAccountId: cursor.providerAccountId,
              calendarId: cursor.calendarId,
              syncCursor: cursor.syncToken,
              lastSuccessfulSyncAt: cursor.completedAt,
            },
            update: { syncCursor: cursor.syncToken, lastSuccessfulSyncAt: cursor.completedAt },
          })
        })
      },
    },

    meet: {
      async upsertTranscript(transcript: {
        providerAccountId: string
        meetingId: string
        artifact: GoogleMeetTranscriptArtifact
      }) {
        return client.$transaction(async (rawTx) => {
          const tx = rawTx as unknown as typeof db
          await assertGmailAccount(tx, transcript.providerAccountId)
          const meeting = await tx.companyMeeting.findUnique({
            where: { id: transcript.meetingId },
            select: { id: true, tenantId: true, providerAccountId: true },
          })
          if (!meeting) throw new Error('Meeting was not found for Meet transcript')
          if (meeting.providerAccountId !== transcript.providerAccountId) {
            throw new Error('Meeting does not belong to the Google Workspace provider account')
          }
          const existing = await tx.companyMeetingTranscriptArtifact.findUnique({
            where: {
              providerAccountId_transcriptName: {
                providerAccountId: transcript.providerAccountId,
                transcriptName: transcript.artifact.transcriptName,
              },
            },
            select: { id: true },
          })
          if (existing) return 'UNCHANGED' as const
          const artifact = await tx.companyMeetingTranscriptArtifact.create({
            data: {
              meetingId: transcript.meetingId,
              providerAccountId: transcript.providerAccountId,
              conferenceRecordName: transcript.artifact.conferenceRecordName,
              transcriptName: transcript.artifact.transcriptName,
              sourceReference: transcript.artifact.sourceReference,
              transcriptText: transcript.artifact.entries.map((entry) => entry.text).join('\n'),
              structuredEntries: json(transcript.artifact.entries),
              acquiredAt: new Date(transcript.artifact.acquiredAt),
              expiresAt: new Date(transcript.artifact.expiresAt),
            },
            select: { id: true },
          })
          await tx.companyMeeting.update({
            where: { id: transcript.meetingId },
            data: {
              transcriptStatus: 'AVAILABLE',
              sourceArtifactRef: transcript.artifact.sourceReference,
            },
          })
          await writeAuditLogStrict(
            {
              ...(meeting.tenantId ? { tenantId: meeting.tenantId } : {}),
              actor,
              action: 'company-meeting.transcript-acquired',
              targetType: 'CompanyMeetingTranscriptArtifact',
              targetId: artifact.id,
              sourceReferences: [{ ref: transcript.artifact.sourceReference }],
              afterState: { expiresAt: transcript.artifact.expiresAt, recordingRetained: false },
            },
            tx,
          )
          return 'INSERTED' as const
        })
      },

      async markTranscriptUnavailable(unavailable: {
        providerAccountId: string
        meetingId: string
        conferenceRecordName: string
        checkedAt: Date
      }) {
        await client.$transaction(async (rawTx) => {
          const tx = rawTx as unknown as typeof db
          await assertGmailAccount(tx, unavailable.providerAccountId)
          await tx.companyMeeting.updateMany({
            where: { id: unavailable.meetingId, transcriptStatus: { not: 'AVAILABLE' } },
            data: {
              transcriptStatus: 'UNAVAILABLE',
              processingProvenance: {
                transcriptCheckedAt: unavailable.checkedAt.toISOString(),
                conferenceRecordName: unavailable.conferenceRecordName,
                transcriptAvailable: false,
              },
            },
          })
          await writeAuditLogStrict(
            {
              actor,
              action: 'company-meeting.transcript-unavailable',
              targetType: 'CompanyMeeting',
              targetId: unavailable.meetingId,
              structuredReason: { conferenceRecordName: unavailable.conferenceRecordName },
              afterState: { transcriptStatus: 'UNAVAILABLE' },
            },
            tx,
          )
        })
      },
    },
  }
}
