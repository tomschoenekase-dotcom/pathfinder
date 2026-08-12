import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type ChatlogReviewActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
export type ChatlogReviewActionClient = Pick<typeof db, '$transaction'>
export type ChatlogReviewActionErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT'

export class ChatlogReviewActionError extends Error {
  constructor(
    readonly code: ChatlogReviewActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ChatlogReviewActionError'
  }
}

const noteSelect = { id: true, note: true, authorId: true, createdAt: true } as const

function invalid(message: string): never {
  throw new ChatlogReviewActionError('INVALID_INPUT', message)
}

function assertInput(input: {
  tenantId: string
  venueId: string
  sessionId: string
  actor: ChatlogReviewActor
}): void {
  if (!input.tenantId.trim() || !input.venueId.trim() || !input.sessionId.trim()) {
    invalid('Exact tenant, venue, and session scope is required.')
  }
  if (
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim()
  ) {
    invalid('A human platform administrator is required.')
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

export async function setChatlogNotableAction(
  input: {
    tenantId: string
    venueId: string
    sessionId: string
    isNotable: boolean
    actor: ChatlogReviewActor
  },
  client: ChatlogReviewActionClient = db,
) {
  assertInput(input)
  return client.$transaction(async (tx) => {
    const before = await tx.visitorSession.findFirst({
      where: { id: input.sessionId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, isNotable: true },
    })
    if (!before) throw new ChatlogReviewActionError('NOT_FOUND', 'Session not found.')
    if (before.isNotable === input.isNotable) {
      return { id: before.id, isNotable: before.isNotable, replayed: true as const }
    }

    const changed = await tx.visitorSession.updateMany({
      where: {
        id: input.sessionId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        isNotable: before.isNotable,
      },
      data: { isNotable: input.isNotable },
    })
    if (changed.count !== 1) {
      throw new ChatlogReviewActionError(
        'CONFLICT',
        'Session review state changed; refresh and try again.',
      )
    }

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.isNotable ? 'admin.chatlog.marked_notable' : 'admin.chatlog.unmarked_notable',
        targetType: 'VisitorSession',
        targetId: input.sessionId,
        beforeState: { isNotable: before.isNotable },
        afterState: { isNotable: input.isNotable },
      },
      tx,
    )
    return { id: before.id, isNotable: input.isNotable, replayed: false as const }
  })
}

export async function addChatlogNoteAction(
  input: {
    tenantId: string
    venueId: string
    sessionId: string
    requestId: string
    note: string
    actor: ChatlogReviewActor
  },
  client: ChatlogReviewActionClient = db,
) {
  assertInput(input)
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.requestId,
    )
  ) {
    invalid('A valid note request UUID is required.')
  }
  const note = input.note.trim()
  if (!note || note.length > 2000) invalid('Note must be 1 to 2000 characters.')

  const createOrReplay = () =>
    client.$transaction(async (tx) => {
      const existing = await tx.adminChatlogNote.findUnique({
        where: { id: input.requestId },
        select: { ...noteSelect, tenantId: true, venueId: true, sessionId: true },
      })
      if (existing) {
        if (
          existing.tenantId !== input.tenantId ||
          existing.venueId !== input.venueId ||
          existing.sessionId !== input.sessionId ||
          existing.authorId !== input.actor.id ||
          existing.note !== note
        ) {
          throw new ChatlogReviewActionError(
            'CONFLICT',
            'Note request ID was already used for different content or scope.',
          )
        }
        return { ...existing, replayed: true as const }
      }

      const session = await tx.visitorSession.findFirst({
        where: { id: input.sessionId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true },
      })
      if (!session) throw new ChatlogReviewActionError('NOT_FOUND', 'Session not found.')

      const created = await tx.adminChatlogNote.create({
        data: {
          id: input.requestId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          sessionId: input.sessionId,
          authorId: input.actor.id,
          note,
        },
        select: noteSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.chatlog.note_added',
          targetType: 'AdminChatlogNote',
          targetId: created.id,
          afterState: { sessionId: input.sessionId, noteLength: note.length },
        },
        tx,
      )
      return { ...created, replayed: false as const }
    })

  try {
    return await createOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    return createOrReplay()
  }
}
