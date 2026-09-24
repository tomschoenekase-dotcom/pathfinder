import { describe, expect, it, vi } from 'vitest'
import { readNativeSalesSnapshot } from './prospect-sales-snapshot'

function fixture(messageCount: number) {
  const messages = Array.from({ length: Math.min(messageCount, 100) }, (_, i) => ({
    id: `message-${String(messageCount - i).padStart(3, '0')}`,
    occurredAt: new Date(Date.UTC(2026, 8, 21, 0, messageCount - i)),
    direction: 'INBOUND',
    textBody: `Point ${messageCount - i}`,
  }))
  const client = {
    prospectVenue: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'synthetic-venue',
        archivedAt: null,
        organization: { id: 'synthetic-org', archivedAt: null, opportunity: null },
        contacts: [],
        sources: [],
        emailThreads: [
          {
            id: 'synthetic-thread',
            messages,
            providerMappings: [],
            _count: { messages: messageCount },
          },
        ],
      }),
    },
    prospectImportSourceRecord: { findMany: vi.fn().mockResolvedValue([]) },
    prospectContact: { findMany: vi.fn().mockResolvedValue([]) },
  }
  return client
}

describe('native sales correspondence snapshot bounds', () => {
  it('keeps the latest message and restores chronological writer order', async () => {
    const client = fixture(100)
    const snapshot = await readNativeSalesSnapshot('synthetic-venue', client as never)
    expect(client.prospectVenue.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          emailThreads: expect.objectContaining({
            include: expect.objectContaining({
              messages: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 100 },
            }),
          }),
        }),
      }),
    )
    expect(snapshot.threads[0]?.messages[0]?.id).toBe('message-001')
    expect(snapshot.threads[0]?.messages.at(-1)?.id).toBe('message-100')
  })

  it('shows the newest message and marks its own thread incomplete', async () => {
    const client = fixture(101)
    const snapshot = await readNativeSalesSnapshot('synthetic-venue', client as never)
    expect(snapshot.threads[0]?.messages.at(-1)?.id).toBe('message-101')
    expect(snapshot.threads[0]?._count.messages).toBe(101)
    expect(snapshot.suppression.blocked).toBe(false)
    expect(snapshot.threadCoverage[0]).toEqual({
      threadId: 'synthetic-thread',
      complete: false,
      issues: [expect.stringContaining('latest 100 of 101')],
    })
  })

  it('does not expose an expired TEMPORARY body while cleanup is pending', async () => {
    const client = fixture(1)
    const row = await client.prospectVenue.findUnique()
    Object.assign(row.emailThreads[0].messages[0], {
      bodyRetentionState: 'TEMPORARY',
      bodyExpiresAt: new Date('2020-01-01T00:00:00Z'),
      replyProjection: { text: 'Point 1' },
    })
    const snapshot = await readNativeSalesSnapshot('synthetic-venue', client as never)
    expect(snapshot.threads[0]?.messages[0]?.textBody).toBeNull()
    expect(
      (snapshot.threads[0]?.messages[0] as { replyProjection?: unknown })?.replyProjection,
    ).toBeNull()
    expect(snapshot.suppression.blocked).toBe(false)
    expect(snapshot.threadCoverage[0]).toEqual({
      threadId: 'synthetic-thread',
      complete: false,
      issues: [expect.stringContaining('body unavailable for message message-001')],
    })
  })

  it('keeps unrelated thread coverage separate from a selected complete thread', async () => {
    const client = fixture(1)
    const row = await client.prospectVenue.findUnique()
    row.emailThreads.push({
      id: 'other-incomplete-thread',
      messages: [],
      providerMappings: [],
      _count: { messages: 101 },
    })
    const snapshot = await readNativeSalesSnapshot('synthetic-venue', client as never)
    expect(snapshot.suppression.blocked).toBe(false)
    expect(snapshot.threadCoverage).toEqual([
      { threadId: 'synthetic-thread', complete: true, issues: [] },
      {
        threadId: 'other-incomplete-thread',
        complete: false,
        issues: [expect.stringContaining('latest 0 of 101')],
      },
    ])
  })
})
