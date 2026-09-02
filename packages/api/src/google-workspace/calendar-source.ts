import {
  GoogleCalendarEventProjection,
  type GoogleCalendarEventProjection as GoogleCalendarEventProjectionType,
} from '@pathfinder/contracts/google-workspace-source'

export class GoogleCalendarSourceError extends Error {
  constructor(
    readonly code: 'SYNC_TOKEN_EXPIRED' | 'AUTHENTICATION_REQUIRED' | 'TRANSIENT' | 'PERMANENT',
    message: string,
  ) {
    super(message)
    this.name = 'GoogleCalendarSourceError'
  }
}

export type GoogleCalendarApiEvent = Readonly<{
  id: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  eventType?: string
  htmlLink?: string
  updated?: string
  sequence?: number
  iCalUID?: string
  recurringEventId?: string
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string }
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  organizer?: { email?: string }
  attendees?: readonly Readonly<{
    email?: string
    displayName?: string
    responseStatus?: string
    organizer?: boolean
    self?: boolean
  }>[]
}>

export type GoogleCalendarApiClient = Readonly<{
  listEvents(input: {
    accessToken: string
    calendarId: string
    pageToken?: string
    syncToken?: string
    timeMin?: string
    timeMax?: string
    showDeleted: true
    singleEvents: true
  }): Promise<{
    events: readonly GoogleCalendarApiEvent[]
    nextPageToken?: string
    nextSyncToken?: string
  }>
}>

export type GoogleWorkspaceAuthorizationLease = Readonly<{
  withAccessToken<T>(callback: (accessToken: string) => Promise<T>): Promise<T>
}>

export type GoogleWorkspaceCredentialLeaseProvider = Readonly<{
  lease(credentialReferenceId: string): Promise<GoogleWorkspaceAuthorizationLease>
}>

export type GoogleCalendarSourceStore = Readonly<{
  upsertEvent(
    projection: GoogleCalendarEventProjectionType,
  ): Promise<'INSERTED' | 'UPDATED' | 'UNCHANGED'>
  applyCancellation(input: {
    providerAccountId: string
    calendarId: string
    externalEventId: string
    recurringEventId: string | null
    originalStartAt: string | null
    providerUpdatedAt: string
  }): Promise<'CANCELLED' | 'UNCHANGED'>
  commitSyncCursor(input: {
    providerAccountId: string
    calendarId: string
    syncToken: string
    completedAt: Date
  }): Promise<void>
}>

const MAX_SOURCE_PAGES = 100

function retainNextPageToken(seen: Set<string>, token: string | undefined) {
  if (!token) return undefined
  if (seen.size >= MAX_SOURCE_PAGES || seen.has(token)) {
    throw new GoogleCalendarSourceError('PERMANENT', 'Google source pagination did not converge')
  }
  seen.add(token)
  return token
}

function eventDate(
  value: { dateTime?: string; date?: string; timeZone?: string } | undefined,
): { instant: string; timeZone: string } | null {
  if (!value) return null
  if (value.dateTime) {
    const instant = new Date(value.dateTime)
    if (Number.isNaN(instant.getTime())) return null
    return { instant: instant.toISOString(), timeZone: value.timeZone ?? 'UTC' }
  }
  if (value.date && /^\d{4}-\d{2}-\d{2}$/u.test(value.date)) {
    return { instant: `${value.date}T00:00:00.000Z`, timeZone: value.timeZone ?? 'UTC' }
  }
  return null
}

function sourceReference(event: GoogleCalendarApiEvent) {
  if (event.htmlLink) {
    try {
      return new URL(event.htmlLink).toString()
    } catch {
      // Fall through to a bounded provider reference.
    }
  }
  return `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(event.id)}`
}

export function projectGoogleCalendarEvent(input: {
  providerAccountId: string
  calendarId: string
  event: GoogleCalendarApiEvent
}): GoogleCalendarEventProjectionType | null {
  const start = eventDate(input.event.start)
  if (!start) return null
  const end = eventDate(input.event.end)
  const originalStart = eventDate(input.event.originalStartTime)
  const attendees = (input.event.attendees ?? [])
    .filter((attendee): attendee is typeof attendee & { email: string } => Boolean(attendee.email))
    .map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName?.trim() || null,
      responseStatus: attendee.responseStatus?.trim() || null,
      organizer: attendee.organizer ?? false,
      self: attendee.self ?? false,
    }))

  return GoogleCalendarEventProjection.parse({
    providerAccountId: input.providerAccountId,
    calendarId: input.calendarId,
    externalEventId: input.event.id,
    iCalUid: input.event.iCalUID ?? null,
    recurringEventId: input.event.recurringEventId ?? null,
    originalStartAt: originalStart?.instant ?? null,
    title: (input.event.summary ?? '').trim().slice(0, 500),
    eventType: input.event.eventType ?? 'default',
    status:
      input.event.status === 'cancelled'
        ? 'CANCELLED'
        : input.event.status === 'tentative'
          ? 'TENTATIVE'
          : 'CONFIRMED',
    startAt: start.instant,
    endAt: end?.instant ?? null,
    timeZone: input.event.start?.timeZone ?? input.event.end?.timeZone ?? start.timeZone,
    organizerEmail: input.event.organizer?.email ?? null,
    attendees,
    sourceReference: sourceReference(input.event),
    providerUpdatedAt: new Date(input.event.updated ?? 0).toISOString(),
    sequence: Math.max(0, input.event.sequence ?? 0),
  })
}

/**
 * Bounded Calendar source synchronization. It never creates, edits, or accepts events and it
 * cannot infer commitments from titles. The cursor advances only after every page is persisted.
 */
export function createGoogleCalendarSource(dependencies: {
  credentials: GoogleWorkspaceCredentialLeaseProvider
  client: GoogleCalendarApiClient
  store: GoogleCalendarSourceStore
  now?: () => Date
  historicalDays?: number
  futureDays?: number
}) {
  const now = dependencies.now ?? (() => new Date())
  const historicalDays = dependencies.historicalDays ?? 365
  const futureDays = dependencies.futureDays ?? 180

  return {
    async synchronize(input: {
      providerAccountId: string
      credentialReferenceId: string
      calendarId: string
      syncToken?: string
    }) {
      const lease = await dependencies.credentials.lease(input.credentialReferenceId)
      const startedAt = now()
      const timeMin = new Date(startedAt.getTime() - historicalDays * 86_400_000).toISOString()
      const timeMax = new Date(startedAt.getTime() + futureDays * 86_400_000).toISOString()
      let pageToken: string | undefined
      let nextSyncToken: string | undefined
      const pageTokens = new Set<string>()
      let upserted = 0
      let cancelled = 0

      do {
        const page = await lease.withAccessToken((accessToken) =>
          dependencies.client.listEvents({
            accessToken,
            calendarId: input.calendarId,
            showDeleted: true,
            singleEvents: true,
            ...(pageToken ? { pageToken } : {}),
            ...(input.syncToken ? { syncToken: input.syncToken } : { timeMin, timeMax }),
          }),
        )
        for (const event of page.events) {
          const projection = projectGoogleCalendarEvent({
            providerAccountId: input.providerAccountId,
            calendarId: input.calendarId,
            event,
          })
          if (projection) {
            await dependencies.store.upsertEvent(projection)
            upserted += 1
          } else if (event.status === 'cancelled') {
            await dependencies.store.applyCancellation({
              providerAccountId: input.providerAccountId,
              calendarId: input.calendarId,
              externalEventId: event.id,
              recurringEventId: event.recurringEventId ?? null,
              originalStartAt: eventDate(event.originalStartTime)?.instant ?? null,
              providerUpdatedAt: new Date(event.updated ?? 0).toISOString(),
            })
            cancelled += 1
          }
        }
        pageToken = retainNextPageToken(pageTokens, page.nextPageToken)
        nextSyncToken = page.nextSyncToken ?? nextSyncToken
      } while (pageToken)

      if (!nextSyncToken)
        throw new GoogleCalendarSourceError(
          'PERMANENT',
          'Calendar sync returned no final sync token',
        )
      await dependencies.store.commitSyncCursor({
        providerAccountId: input.providerAccountId,
        calendarId: input.calendarId,
        syncToken: nextSyncToken,
        completedAt: now(),
      })
      return {
        mode: input.syncToken ? ('INCREMENTAL' as const) : ('BOUNDED_INITIAL' as const),
        upserted,
        cancelled,
        syncToken: nextSyncToken,
      }
    },
  }
}
