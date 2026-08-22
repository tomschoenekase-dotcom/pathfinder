import { describe, expect, it, vi } from 'vitest'

import {
  createGoogleCalendarSource,
  projectGoogleCalendarEvent,
  type GoogleCalendarApiClient,
} from './calendar-source'

const credentials = {
  lease: vi.fn(async () => ({
    withAccessToken: async <T>(callback: (token: string) => Promise<T>) => callback('short-lived'),
  })),
}

describe('Google Calendar source', () => {
  it('projects rescheduled recurring instances with timezone and source provenance', () => {
    const projection = projectGoogleCalendarEvent({
      providerAccountId: 'account_1',
      calendarId: 'primary',
      event: {
        id: 'instance_1',
        status: 'confirmed',
        summary: 'Weekly check-in',
        recurringEventId: 'series_1',
        originalStartTime: { dateTime: '2026-08-22T09:00:00-05:00', timeZone: 'America/Chicago' },
        start: { dateTime: '2026-08-22T10:00:00-05:00', timeZone: 'America/Chicago' },
        end: { dateTime: '2026-08-22T10:30:00-05:00', timeZone: 'America/Chicago' },
        updated: '2026-08-20T12:00:00Z',
        sequence: 3,
      },
    })
    expect(projection).toMatchObject({
      recurringEventId: 'series_1',
      originalStartAt: '2026-08-22T14:00:00.000Z',
      startAt: '2026-08-22T15:00:00.000Z',
      timeZone: 'America/Chicago',
      sequence: 3,
    })
  })

  it('applies create/update and cancellation pages before advancing the cursor', async () => {
    const events = [
      {
        id: 'event_1',
        status: 'confirmed' as const,
        summary: 'Customer call',
        start: { dateTime: '2026-08-22T15:00:00Z' },
        end: { dateTime: '2026-08-22T15:30:00Z' },
        updated: '2026-08-20T00:00:00Z',
      },
      { id: 'deleted_1', status: 'cancelled' as const, updated: '2026-08-21T00:00:00Z' },
    ]
    const client = {
      listEvents: vi.fn(async (request: Parameters<GoogleCalendarApiClient['listEvents']>[0]) => {
        expect(request.calendarId).toBe('primary')
        return { events, nextSyncToken: 'sync_2' }
      }),
    }
    const store = {
      upsertEvent: vi.fn(async () => 'INSERTED' as const),
      applyCancellation: vi.fn(async () => 'CANCELLED' as const),
      commitSyncCursor: vi.fn(async () => undefined),
    }
    const source = createGoogleCalendarSource({
      credentials,
      client,
      store,
      now: () => new Date('2026-08-22T00:00:00Z'),
    })
    await expect(
      source.synchronize({
        providerAccountId: 'account_1',
        credentialReferenceId: 'credential_1',
        calendarId: 'primary',
      }),
    ).resolves.toMatchObject({ mode: 'BOUNDED_INITIAL', upserted: 1, cancelled: 1 })
    expect(store.commitSyncCursor).toHaveBeenCalledAfter(store.upsertEvent)
    expect(store.commitSyncCursor).toHaveBeenCalledAfter(store.applyCancellation)
    expect(client.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        showDeleted: true,
        singleEvents: true,
        timeMin: expect.any(String),
        timeMax: expect.any(String),
      }),
    )
  })

  it('uses the prior sync token without mixing bounded-window parameters', async () => {
    const client = {
      listEvents: vi.fn(async (request: Parameters<GoogleCalendarApiClient['listEvents']>[0]) => {
        expect(request.syncToken).toBe('sync_2')
        return { events: [], nextSyncToken: 'sync_3' }
      }),
    }
    const store = {
      upsertEvent: vi.fn(),
      applyCancellation: vi.fn(),
      commitSyncCursor: vi.fn(async () => undefined),
    }
    await createGoogleCalendarSource({ credentials, client, store }).synchronize({
      providerAccountId: 'account_1',
      credentialReferenceId: 'credential_1',
      calendarId: 'primary',
      syncToken: 'sync_2',
    })
    expect(client.listEvents).toHaveBeenCalledWith(expect.objectContaining({ syncToken: 'sync_2' }))
    expect(client.listEvents.mock.calls[0]![0]).not.toHaveProperty('timeMin')
    expect(client.listEvents.mock.calls[0]![0]).not.toHaveProperty('timeMax')
  })
})
