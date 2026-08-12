import { describe, expect, it, vi } from 'vitest'

import {
  addChatlogNoteAction,
  ChatlogReviewActionError,
  setChatlogNotableAction,
} from './chatlog-review-actions'

const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }

function client() {
  const tx = {
    visitorSession: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    adminChatlogNote: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return { tx, db: { $transaction: vi.fn(async (work) => work(tx)) } }
}

describe('canonical chatlog review actions', () => {
  it('toggles notable state with exact scope/CAS and strict sanitized audit', async () => {
    const { db, tx } = client()
    tx.visitorSession.findFirst.mockResolvedValue({ id: 'session-1', isNotable: false })
    tx.visitorSession.updateMany.mockResolvedValue({ count: 1 })

    const result = await setChatlogNotableAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        sessionId: 'session-1',
        isNotable: true,
        actor,
      },
      db as never,
    )

    expect(result).toEqual({ id: 'session-1', isNotable: true, replayed: false })
    expect(tx.visitorSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        isNotable: false,
      },
      data: { isNotable: true },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        actorId: 'admin-1',
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.chatlog.marked_notable',
        targetType: 'VisitorSession',
        targetId: 'session-1',
        beforeState: { isNotable: false },
        afterState: { isNotable: true },
      },
    })
  })

  it('replays an already-matching notable state without a write or audit', async () => {
    const { db, tx } = client()
    tx.visitorSession.findFirst.mockResolvedValue({ id: 'session-1', isNotable: true })

    const result = await setChatlogNotableAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        sessionId: 'session-1',
        isNotable: true,
        actor,
      },
      db as never,
    )

    expect(result.replayed).toBe(true)
    expect(tx.visitorSession.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('fails notable toggle on cross-scope lookup, CAS loss, or strict audit failure', async () => {
    const { db, tx } = client()
    tx.visitorSession.findFirst.mockResolvedValueOnce(null)
    await expect(
      setChatlogNotableAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          sessionId: 'other-session',
          isNotable: true,
          actor,
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    tx.visitorSession.findFirst.mockResolvedValue({ id: 'session-1', isNotable: false })
    tx.visitorSession.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(
      setChatlogNotableAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          sessionId: 'session-1',
          isNotable: true,
          actor,
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    tx.visitorSession.updateMany.mockResolvedValue({ count: 1 })
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      setChatlogNotableAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          sessionId: 'session-1',
          isNotable: true,
          actor,
        },
        db as never,
      ),
    ).rejects.toThrow('audit unavailable')
  })

  it('creates a scoped note and audits metadata without the private body', async () => {
    const { db, tx } = client()
    const createdAt = new Date('2026-08-11T20:00:00.000Z')
    tx.adminChatlogNote.findUnique.mockResolvedValue(null)
    tx.visitorSession.findFirst.mockResolvedValue({ id: 'session-1' })
    tx.adminChatlogNote.create.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      note: 'Private detail',
      authorId: 'admin-1',
      createdAt,
    })

    const result = await addChatlogNoteAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        sessionId: 'session-1',
        requestId: '11111111-1111-4111-8111-111111111111',
        note: ' Private detail ',
        actor,
      },
      db as never,
    )

    expect(result.replayed).toBe(false)
    expect(tx.adminChatlogNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: '11111111-1111-4111-8111-111111111111',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          sessionId: 'session-1',
          authorId: 'admin-1',
          note: 'Private detail',
        }),
      }),
    )
    const auditPayload = tx.auditLog.create.mock.calls[0]?.[0]
    expect(auditPayload).toEqual({
      data: {
        tenantId: 'tenant-1',
        actorId: 'admin-1',
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.chatlog.note_added',
        targetType: 'AdminChatlogNote',
        targetId: '11111111-1111-4111-8111-111111111111',
        afterState: { sessionId: 'session-1', noteLength: 14 },
      },
    })
    expect(JSON.stringify(auditPayload)).not.toContain('Private detail')
  })

  it('fails note creation closed when strict audit persistence fails', async () => {
    const { db, tx } = client()
    tx.adminChatlogNote.findUnique.mockResolvedValue(null)
    tx.visitorSession.findFirst.mockResolvedValue({ id: 'session-1' })
    tx.adminChatlogNote.create.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      note: 'Private detail',
      authorId: 'admin-1',
      createdAt: new Date('2026-08-11T20:00:00.000Z'),
    })
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      addChatlogNoteAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          sessionId: 'session-1',
          requestId: '11111111-1111-4111-8111-111111111111',
          note: 'Private detail',
          actor,
        },
        db as never,
      ),
    ).rejects.toThrow('audit unavailable')
  })

  it('replays the same note request and conflicts on changed content or scope', async () => {
    const { db, tx } = client()
    tx.adminChatlogNote.findUnique.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      sessionId: 'session-1',
      authorId: 'admin-1',
      note: 'Private detail',
      createdAt: new Date('2026-08-11T20:00:00.000Z'),
    })

    const replay = await addChatlogNoteAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        sessionId: 'session-1',
        requestId: '11111111-1111-4111-8111-111111111111',
        note: 'Private detail',
        actor,
      },
      db as never,
    )
    expect(replay.replayed).toBe(true)
    expect(tx.adminChatlogNote.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()

    await expect(
      addChatlogNoteAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          sessionId: 'session-1',
          requestId: '11111111-1111-4111-8111-111111111111',
          note: 'Changed private detail',
          actor,
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<ChatlogReviewActionError>)
  })

  it('retries a concurrent request-id collision as an exact replay', async () => {
    const { db, tx } = client()
    tx.adminChatlogNote.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      sessionId: 'session-1',
      authorId: 'admin-1',
      note: 'Private detail',
      createdAt: new Date('2026-08-11T20:00:00.000Z'),
    })
    tx.visitorSession.findFirst.mockResolvedValue({ id: 'session-1' })
    tx.adminChatlogNote.create.mockRejectedValueOnce({ code: 'P2002' })

    const result = await addChatlogNoteAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        sessionId: 'session-1',
        requestId: '11111111-1111-4111-8111-111111111111',
        note: 'Private detail',
        actor,
      },
      db as never,
    )
    expect(result.replayed).toBe(true)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid actor, scope, request identity, and note bounds before DB access', async () => {
    const { db } = client()
    const base = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      sessionId: 'session-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      note: 'Private detail',
      actor,
    }
    await expect(
      addChatlogNoteAction({ ...base, tenantId: '' }, db as never),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      addChatlogNoteAction({ ...base, actor: { ...actor, id: '' } }, db as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      addChatlogNoteAction({ ...base, requestId: '' }, db as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      addChatlogNoteAction({ ...base, requestId: 'nonempty-but-not-a-uuid' }, db as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(addChatlogNoteAction({ ...base, note: ' ' }, db as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})
