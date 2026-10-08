import { GuestAnswerEvidenceBundleSchema } from '@pathfinder/contracts/guest-answer-attribution'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { projectGuestGuideCoverage } from '../../lib/guest-guide-coverage'

import { operatorUntrustedText, redactAddresses } from '../crm-projection'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { decodeKeysetCursor, encodeKeysetCursor, pageResult, requireCursorInScope } from './page'

type SessionClass = 'guest' | 'employee' | 'other'

const SCOPE_BY_CLASS = { guest: 'PUBLIC', employee: 'SECOND_LAYER' } as const

export function classifySessionScope(scope: string): SessionClass {
  return scope === 'PUBLIC' ? 'guest' : scope === 'SECOND_LAYER' ? 'employee' : 'other'
}

/**
 * Visitor text reaches the operator redacted by default: addresses, phone-like numbers and long
 * digit runs (cards, ids) are withheld. This is a privacy floor, not a promise that free text is
 * free of personal data, so the result is still marked untrusted and bounded.
 */
export function redactGuestText(value: string): string {
  return redactAddresses(value)
    .replace(/\+?\d[\d\s().-]{6,}\d/gu, '[number withheld]')
    .replace(/\d{6,}/gu, '[number withheld]')
}

const EVIDENCE_PRESENT = {
  path: ['answerEvidence', 'evidenceSetHash'],
  string_starts_with: '',
} as const

/** Local calendar date for an instant in an IANA zone, as YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

const listSessions: OperatorReadTool = {
  name: 'venues.list_sessions',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.list_sessions'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const database = context.database
    const start = new Date(input.windowStart)
    const end = new Date(input.windowEnd)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const windowWhere = { ...scope, startedAt: { gte: start, lt: end } }
    const matching =
      input.classification === 'all'
        ? {}
        : { experienceScope: SCOPE_BY_CLASS[input.classification] }
    const where = { ...windowWhere, ...matching }

    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    await requireCursorInScope(after?.id, (id) =>
      database.visitorSession.findFirst({
        where: { ...where, id, startedAt: after!.at },
        select: { id: true },
      }),
    )
    const [byScope, rows] = await Promise.all([
      database.visitorSession.groupBy({
        by: ['experienceScope'],
        where: windowWhere,
        _count: { _all: true },
      }),
      database.visitorSession.findMany({
        where: {
          ...where,
          ...(after
            ? {
                AND: [
                  {
                    OR: [
                      { startedAt: { lt: after.at } },
                      { startedAt: after.at, id: { lt: after.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          startedAt: true,
          lastActiveAt: true,
          experienceScope: true,
          entrySurface: true,
          dispositionOperationId: true,
        },
      }),
    ])
    const page = rows.slice(0, input.limit)
    const ids = page.map((row) => row.id)
    const [messageGroups, turnGroups, fallbackGroups, evidenceGroups] =
      ids.length === 0
        ? [[], [], [], []]
        : await Promise.all([
            database.message.groupBy({
              by: ['sessionId', 'role'],
              where: { ...scope, sessionId: { in: ids } },
              _count: { _all: true },
            }),
            database.guestChatTurn.groupBy({
              by: ['sessionId', 'status'],
              where: { ...scope, sessionId: { in: ids } },
              _count: { _all: true },
            }),
            database.guestChatTurn.groupBy({
              by: ['sessionId'],
              where: { ...scope, sessionId: { in: ids }, fallbackCode: { not: null } },
              _count: { _all: true },
            }),
            database.guestChatTurn.groupBy({
              by: ['sessionId'],
              where: { ...scope, sessionId: { in: ids }, replayMetadata: EVIDENCE_PRESENT },
              _count: { _all: true },
            }),
          ])
    const count = (
      groups: ReadonlyArray<{ sessionId: string; _count: { _all: number } }>,
      id: string,
    ) => groups.filter((group) => group.sessionId === id).reduce((sum, g) => sum + g._count._all, 0)

    const scopeCount = (scopeName: string) =>
      byScope.find((group) => group.experienceScope === scopeName)?._count._all ?? 0
    const guest = scopeCount('PUBLIC')
    const employee = scopeCount('SECOND_LAYER')
    const total = byScope.reduce((sum, group) => sum + group._count._all, 0)
    const other = total - guest - employee
    const includedFor = {
      guest,
      employee,
      all: total,
    }[input.classification]

    return {
      tenantId: input.tenantId,
      venueId: input.venueId,
      window: {
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone: input.timeZone,
      },
      classification: input.classification,
      ...pageResult(
        page.map((row) => {
          const visitorMessages = count(
            messageGroups.filter((group) => group.role === 'user'),
            row.id,
          )
          const assistantMessages = count(
            messageGroups.filter((group) => group.role === 'assistant'),
            row.id,
          )
          return {
            sessionId: row.id,
            startedAt: row.startedAt.toISOString(),
            localDate: localDate(row.startedAt, input.timeZone),
            lastActiveAt: row.lastActiveAt.toISOString(),
            classification: classifySessionScope(row.experienceScope),
            entrySurface: row.entrySurface,
            disposed: row.dispositionOperationId !== null,
            turns: count(turnGroups, row.id),
            visitorMessages,
            assistantMessages,
            totalMessages: visitorMessages + assistantMessages,
            fallbackTurns: count(fallbackGroups, row.id),
            failedTurns: count(
              turnGroups.filter((group) => group.status === 'FAILED'),
              row.id,
            ),
            turnsWithStoredEvidence: count(evidenceGroups, row.id),
          }
        }),
        rows.length > input.limit
          ? encodeKeysetCursor(page.at(-1)!.startedAt, page.at(-1)!.id)
          : null,
      ),
      counts: {
        included: includedFor,
        excluded: {
          guest: input.classification === 'employee' ? guest : 0,
          employee: input.classification === 'guest' ? employee : 0,
          other: input.classification === 'all' ? 0 : other,
        },
        unavailable: {
          testClassification: true as const,
          note: 'Sessions are recorded as guest or employee only. Test or internal guest sessions cannot be told apart and are counted as guest sessions.',
        },
      },
    }
  },
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null
}

const getAnswerEvidence: OperatorReadTool = {
  name: 'venues.get_answer_evidence',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_answer_evidence'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const database = context.database
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const session = await database.visitorSession.findFirst({
      where: { id: input.sessionId, ...scope },
      select: { id: true, experienceScope: true, dispositionOperationId: true },
    })
    if (!session) throw new OperatorNotFoundError()
    const disposed = session.dispositionOperationId !== null

    const [turnRows, evidenceRows] = await Promise.all([
      database.guestChatTurn.findMany({
        where: { ...scope, sessionId: session.id },
        orderBy: { turnSequence: 'asc' },
        take: 101,
        select: {
          id: true,
          turnSequence: true,
          status: true,
          createdAt: true,
          fallbackCode: true,
          failureCode: true,
        },
      }),
      database.guestChatTurn.findMany({
        where: { ...scope, sessionId: session.id, replayMetadata: EVIDENCE_PRESENT },
        take: 101,
        select: { id: true },
      }),
    ])
    const stored = new Set(evidenceRows.map((row) => row.id))
    const listed = turnRows.slice(0, 100)
    const turns = listed.map((turn) => ({
      turnSequence: turn.turnSequence,
      turnId: turn.id,
      status: turn.status,
      createdAt: turn.createdAt.toISOString(),
      fallbackCode: turn.fallbackCode,
      failureCode: turn.failureCode,
      evidenceStored: stored.has(turn.id),
    }))
    const base = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      sessionId: session.id,
      classification: classifySessionScope(session.experienceScope),
      disposed,
      turns,
      turnsComplete: turnRows.length <= 100,
    }
    if (input.turnSequence === undefined) return { ...base, turn: null }

    const turn = await database.guestChatTurn.findFirst({
      where: { ...scope, sessionId: session.id, turnSequence: input.turnSequence },
      select: {
        id: true,
        turnSequence: true,
        status: true,
        createdAt: true,
        completedAt: true,
        fallbackCode: true,
        failureCode: true,
        replayMetadata: true,
        userMessageId: true,
        assistantMessageId: true,
        providerOperations: { select: { usageReference: true } },
      },
    })
    if (!turn) throw new OperatorNotFoundError()

    const messageIds = [turn.userMessageId, turn.assistantMessageId].filter(
      (id): id is string => id !== null,
    )
    const usageIds = turn.providerOperations
      .map((operation) => operation.usageReference)
      .filter((id): id is string => id !== null)
    const [messages, usage, timing, attribution] = await Promise.all([
      disposed || messageIds.length === 0
        ? Promise.resolve([])
        : database.message.findMany({
            where: { ...scope, sessionId: session.id, id: { in: messageIds } },
            select: { id: true, content: true },
          }),
      usageIds.length === 0
        ? Promise.resolve([])
        : database.aiUsageEvent.findMany({
            where: { tenantId: input.tenantId, id: { in: usageIds } },
            orderBy: { createdAt: 'asc' },
            take: 10,
            select: {
              id: true,
              provider: true,
              model: true,
              routeModelKey: true,
              capability: true,
              fallbackUsed: true,
              success: true,
              errorCode: true,
              latencyMs: true,
              attempts: true,
            },
          }),
      turn.userMessageId === null
        ? Promise.resolve(null)
        : database.analyticsEvent.findFirst({
            where: {
              ...scope,
              eventType: 'message.received',
              userMessageId: turn.userMessageId,
            },
            select: { metadata: true },
          }),
      database.guestAnswerAttribution.findFirst({
        where: { ...scope, guestChatTurnId: turn.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          createdAt: true,
          claimCount: true,
          supportedCount: true,
          unsupportedCount: true,
          uncertainCount: true,
          evaluatorModel: true,
        },
      }),
    ])
    const text = (id: string | null) => {
      const content = messages.find((message) => message.id === id)?.content
      return content === undefined ? null : operatorUntrustedText(redactGuestText(content))
    }

    const metadata =
      turn.replayMetadata && typeof turn.replayMetadata === 'object'
        ? (turn.replayMetadata as Record<string, unknown>)
        : null
    const parsed =
      metadata && metadata.answerEvidence !== undefined
        ? GuestAnswerEvidenceBundleSchema.safeParse(metadata.answerEvidence)
        : null
    const bundle = parsed?.success ? parsed.data : null
    const evidenceReason = bundle
      ? null
      : parsed
        ? 'Stored evidence failed validation and is not shown.'
        : 'This turn stored no answer evidence. Turns before evidence capture, and failed or fallback turns, have none.'
    const shown = bundle?.sources.slice(0, 25) ?? []

    const timingMetadata =
      timing?.metadata && typeof timing.metadata === 'object'
        ? (timing.metadata as Record<string, unknown>)
        : null
    const totalMs = numberOrNull(timingMetadata?.totalMs)
    const modelMs = numberOrNull(timingMetadata?.modelMs)
    const retrievalMs = numberOrNull(timingMetadata?.retrievalMs)
    const latencyRecorded = totalMs !== null || modelMs !== null || retrievalMs !== null

    return {
      ...base,
      turn: {
        turnId: turn.id,
        turnSequence: turn.turnSequence,
        status: turn.status,
        createdAt: turn.createdAt.toISOString(),
        completedAt: turn.completedAt?.toISOString() ?? null,
        textMode: disposed ? ('withheld' as const) : ('redacted' as const),
        question: disposed ? null : text(turn.userMessageId),
        answer: disposed ? null : text(turn.assistantMessageId),
        evidence: {
          state: bundle ? ('stored' as const) : ('unavailable' as const),
          reason: evidenceReason,
          schemaVersion: bundle?.schemaVersion ?? null,
          promptContractVersion: bundle?.promptContractVersion ?? null,
          evidenceSetHash: bundle?.evidenceSetHash ?? null,
          answerHash: bundle?.answerHash ?? null,
          routeConfigurationVersion: bundle?.routeConfigurationVersion ?? null,
          sourceCount: bundle?.sources.length ?? 0,
          ...projectGuestGuideCoverage({
            evidence: bundle,
            assistantResponse: messages.find((message) => message.id === turn.assistantMessageId)?.content ?? null,
          }),
          sourcesShown: shown.length,
          sources: shown.map((source) => {
            const published = source.sourceId.startsWith('published-content:')
              ? source.sourceId.split(':')
              : null
            return {
              sourceId: source.sourceId.slice(0, 300),
              kind: source.kind,
              label: operatorUntrustedText(source.label),
              rank: source.rank,
              snapshotHash: source.snapshotHash,
              moduleId: published?.[1] ?? null,
              revisionId: published?.[2] ?? null,
              // Sources are venue-authored content, not visitor text; only addresses are withheld.
              excerpt: operatorUntrustedText(redactAddresses(source.snapshot), 300),
            }
          }),
        },
        release: {
          releaseId: null,
          note: 'Turns record the prompt contract and route configuration versions above, not a release id.',
        },
        model: {
          state: usage.length > 0 ? ('recorded' as const) : ('unavailable' as const),
          reason:
            usage.length > 0
              ? null
              : 'No usage record is linked to this turn, so the model that answered is not known.',
          calls: usage.map((call) => ({
            usageId: call.id,
            provider: call.provider.slice(0, 100),
            model: call.model.slice(0, 191),
            routeModelKey: call.routeModelKey,
            capability: call.capability.slice(0, 64),
            fallbackUsed: call.fallbackUsed,
            success: call.success,
            errorCode: call.errorCode?.slice(0, 120) ?? null,
            latencyMs: call.latencyMs,
            attempts: call.attempts,
          })),
        },
        latency: {
          state: latencyRecorded ? ('recorded' as const) : ('unavailable' as const),
          reason: latencyRecorded
            ? null
            : 'No response timing event exists for this turn. Employee sessions and older turns record none.',
          totalMs,
          modelMs,
          retrievalMs,
        },
        outcome: {
          fallbackCode: turn.fallbackCode,
          failureCode: turn.failureCode,
          providerFallbackUsed: usage.length > 0 ? usage.some((call) => call.fallbackUsed) : null,
        },
        attribution: attribution
          ? {
              state: 'recorded' as const,
              attributionId: attribution.id,
              createdAt: attribution.createdAt.toISOString(),
              claimCount: attribution.claimCount,
              supportedCount: attribution.supportedCount,
              unsupportedCount: attribution.unsupportedCount,
              uncertainCount: attribution.uncertainCount,
              evaluatorModel: attribution.evaluatorModel.slice(0, 191),
            }
          : {
              state: 'none' as const,
              attributionId: null,
              createdAt: null,
              claimCount: null,
              supportedCount: null,
              unsupportedCount: null,
              uncertainCount: null,
              evaluatorModel: null,
            },
      },
    }
  },
}

export const evidenceReadTools: readonly OperatorReadTool[] = [listSessions, getAnswerEvidence]
