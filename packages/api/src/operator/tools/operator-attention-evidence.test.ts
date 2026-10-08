/* eslint-disable @typescript-eslint/no-explicit-any -- loose fakes for the Prisma delegate surface */
import { describe, expect, it } from 'vitest'
import { buildGuestAnswerEvidenceBundle } from '../../lib/guest-answer-evidence'

import {
  OPERATOR_MCP_INPUTS,
  OPERATOR_MCP_OUTPUTS,
  OperatorCapability,
} from '@pathfinder/contracts/operator-mcp'

import { GUEST_CHAT_PROMPT_VERSION } from '@pathfinder/contracts/prompt-contract'

import { classifyGeneratingReport } from '../report-generation'
import { createOperatorRegistry, type OperatorCallContext } from '../registry'
import { attentionState } from './attention'
import { localDate, redactGuestText } from './evidence'
import { routineHealth } from './routines'

const NOW = new Date('2026-10-02T12:00:00.000Z')
const TENANT = 'tenant-a'
const OTHER = 'tenant-b'
const VENUE = 'venue-a'

type Call = { model: string; method: string; args: any }

/**
 * A recording fake of the Prisma delegates the new reads use. Each model method answers from a
 * handler (default: empty), and every call is recorded so a test can prove every query carried the
 * authenticated tenant.
 */
function fakeDb(handlers: Record<string, Record<string, (args: any) => unknown>> = {}) {
  const calls: Call[] = []
  const base: Record<string, (args: any) => unknown> = {
    findFirst: () => null,
    findUnique: () => null,
    findMany: () => [],
    count: () => 0,
    groupBy: () => [],
  }
  const database = new Proxy(
    {},
    {
      get(_target, model: string) {
        return new Proxy(
          {},
          {
            get(_t, method: string) {
              return async (args: any) => {
                calls.push({ model, method, args })
                return (handlers[model]?.[method] ?? base[method] ?? (() => null))(args)
              }
            },
          },
        )
      },
    },
  ) as any
  return { database, calls }
}

function context(
  database: any,
  overrides: Partial<{ capabilities: string[]; tenantIds: string[]; allTenants: boolean }> = {},
): OperatorCallContext {
  return {
    config: {} as any,
    database,
    grant: {
      grantId: 'grant-1',
      allTenants: overrides.allTenants ?? false,
      tenantIds: overrides.tenantIds ?? [TENANT],
      capabilities: overrides.capabilities ?? [...OperatorCapability.options],
    } as any,
    kinds: new Map() as any,
    now: NOW,
    requestId: 'req-1',
    venueRead: (async () => ({})) as any,
  }
}

const tenantAndVenue = {
  tenant: { findUnique: () => ({ id: TENANT }) },
  venue: { findFirst: () => ({ id: VENUE }) },
}

const registry = createOperatorRegistry()
const call = (name: string, args: unknown, ctx: OperatorCallContext) =>
  registry.callTool(name, args, ctx) as Promise<any>

/** Every recorded query that names a tenant-scoped model must carry exactly this tenant. */
function expectEveryQueryScopedTo(calls: Call[], tenantId: string, skip: string[] = []) {
  for (const entry of calls) {
    if (skip.includes(entry.model)) continue
    const where = JSON.stringify(entry.args?.where ?? {})
    expect(where, `${entry.model}.${entry.method}`).toContain(tenantId)
    if (tenantId === TENANT) expect(where).not.toContain(OTHER)
  }
}

describe('catalog', () => {
  it('lists every new tool with a parseable output contract', () => {
    const names = createOperatorRegistry()
      .listTools()
      .map((tool) => tool.name)
    for (const name of [
      'reports.get',
      'reports.reconcile_generating',
      'venues.list_sessions',
      'venues.get_answer_evidence',
      'routines.get_run_status',
      'operator.get_attention',
      'reports.propose_generate',
      'reports.propose_publish',
      'routines.propose_create',
      'routines.propose_update',
      'routines.propose_enable',
      'routines.propose_disable',
    ]) {
      expect(names).toContain(name)
      expect(OPERATOR_MCP_OUTPUTS[name as keyof typeof OPERATOR_MCP_OUTPUTS]).toBeDefined()
    }
  })

  it('rejects unknown input keys and bad windows or time zones', () => {
    const sessions = OPERATOR_MCP_INPUTS['venues.list_sessions']
    const base = {
      tenantId: TENANT,
      venueId: VENUE,
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-08T00:00:00.000Z',
      timeZone: 'Europe/London',
    }
    expect(sessions.parse(base).classification).toBe('guest')
    expect(() => sessions.parse({ ...base, extra: 1 })).toThrow()
    expect(() => sessions.parse({ ...base, timeZone: 'Not/AZone' })).toThrow()
    expect(() => sessions.parse({ ...base, windowEnd: base.windowStart })).toThrow()
    expect(() => sessions.parse({ ...base, windowEnd: '2027-01-01T00:00:00.000Z' })).toThrow()
    const generate = OPERATOR_MCP_INPUTS['reports.propose_generate']
    const op = '8a1f1c0e-2f87-4b5e-9d57-6a2b6d7a9d10'
    expect(() => generate.parse({ tenantId: TENANT, venueId: VENUE, operationId: op })).toThrow()
    expect(() =>
      generate.parse({ tenantId: TENANT, venueId: VENUE, operationId: op, retryOfReportId: 'r1' }),
    ).toThrow()
    expect(() =>
      OPERATOR_MCP_INPUTS['routines.propose_update'].parse({
        tenantId: TENANT,
        venueId: VENUE,
        routineId: 'r',
        expectedUpdatedAt: NOW.toISOString(),
        operationId: op,
      }),
    ).toThrow()
  })
})

describe('classifyGeneratingReport', () => {
  const base = { now: NOW, jobCount: 0, latestJob: null, leaseExpiresAt: null }
  it('does not use age: a live lease is running whatever the age', () => {
    const verdict = classifyGeneratingReport({
      ...base,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    })
    expect(verdict.classification).toBe('job_running_with_heartbeat')
    expect(verdict.leaseLive).toBe(true)
  })
  it('classifies no job, failed job and everything else as unknown', () => {
    expect(classifyGeneratingReport(base).classification).toBe('no_job_found')
    expect(
      classifyGeneratingReport({
        ...base,
        jobCount: 1,
        latestJob: { id: 'j', status: 'FAILED', failureDisposition: 'UNRECOVERABLE' },
      }).classification,
    ).toBe('job_failed')
    // A job says running but the lease expired: the evidence disagrees, so it is unknown.
    const stale = classifyGeneratingReport({
      ...base,
      jobCount: 1,
      latestJob: { id: 'j', status: 'RUNNING', failureDisposition: null },
      leaseExpiresAt: new Date(NOW.getTime() - 1),
    })
    expect(stale.classification).toBe('unknown')
    expect(stale.leaseLive).toBe(false)
    expect(
      classifyGeneratingReport({
        ...base,
        jobCount: 1,
        latestJob: { id: 'j', status: 'COMPLETE', failureDisposition: null },
      }).classification,
    ).toBe('unknown')
  })
})

describe('reports.get', () => {
  const longBody = 'Section. '.repeat(900)
  const row = {
    id: 'rep-1',
    weekStart: new Date('2026-06-29T00:00:00Z'),
    weekEnd: new Date('2026-07-05T23:59:59Z'),
    status: 'DRAFT',
    title: 'Weekly',
    content: longBody,
    answerCount: 4,
    sessionCount: 12,
    error: null,
    generatedAt: new Date('2026-07-06T01:00:00Z'),
    publishedAt: null,
    createdBy: 'user_author',
    createdAt: new Date('2026-07-06T00:00:00Z'),
    updatedAt: new Date('2026-07-06T01:00:00Z'),
  }
  it('returns the whole body, never the 500-character preview, with honest unavailable fields', async () => {
    const { database, calls } = fakeDb({
      ...tenantAndVenue,
      weeklyReport: { findFirst: () => row },
      auditLog: {
        findMany: () => [
          {
            id: 'a1',
            actorId: 'user_reviewer',
            actorRole: 'PLATFORM_ADMIN',
            action: 'admin.report.edited',
            createdAt: new Date('2026-07-06T02:00:00Z'),
          },
        ],
      },
      jobRecord: {
        findMany: () => [
          {
            id: 'job-1',
            jobName: 'weekly-report-process',
            status: 'COMPLETE',
            error: null,
            attemptNumber: 1,
            maxAttempts: 3,
            failureDisposition: null,
            startedAt: new Date('2026-07-06T00:30:00Z'),
            completedAt: new Date('2026-07-06T01:00:00Z'),
            createdAt: new Date('2026-07-06T00:30:00Z'),
          },
        ],
      },
    })
    const output = await call(
      'reports.get',
      { tenantId: TENANT, venueId: VENUE, reportId: 'rep-1' },
      context(database),
    )
    expect(output.body.text).toBe(longBody)
    expect(output.body.truncated).toBe(false)
    expect(output.bodyChars).toBe(longBody.length)
    expect(output.denominators).toMatchObject({
      publicSessions: 12,
      capturedAnswers: 4,
      totalMessages: 'unavailable',
    })
    expect(output.window.timeZone).toBeNull()
    expect(output.sources.releaseId).toBeNull()
    expect(output.people).toMatchObject({
      author: 'user_author',
      recipients: { state: 'unavailable' },
    })
    expect(output.people.reviewers).toHaveLength(1)
    expect(output.delivery.state).toBe('not_modeled')
    expect(output.version).toBe(row.updatedAt.toISOString())
    expect(output.configuration.enabled).toBe(false)
    expectEveryQueryScopedTo(calls, TENANT, ['tenant'])
  })
  it('is not found for another tenant and never queries it', async () => {
    const { database, calls } = fakeDb(tenantAndVenue)
    await expect(
      call(
        'reports.get',
        { tenantId: OTHER, venueId: VENUE, reportId: 'rep-1' },
        context(database),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls).toHaveLength(0)
  })
  it('is not found when the report is in another venue or tenant row', async () => {
    const { database } = fakeDb({ ...tenantAndVenue, weeklyReport: { findFirst: () => null } })
    await expect(
      call(
        'reports.get',
        { tenantId: TENANT, venueId: VENUE, reportId: 'foreign' },
        context(database),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('requires the reports:read capability', async () => {
    const { database } = fakeDb(tenantAndVenue)
    await expect(
      call(
        'reports.get',
        { tenantId: TENANT, venueId: VENUE, reportId: 'rep-1' },
        context(database, { capabilities: ['venues:read'] }),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
  })
})

describe('reports.reconcile_generating', () => {
  const generating = (id: string, createdAt: string, lease: Date | null = null) => ({
    id,
    venueId: VENUE,
    weekStart: new Date('2026-06-29T00:00:00Z'),
    weekEnd: new Date('2026-07-05T00:00:00Z'),
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    executionLeaseExpiresAt: lease,
  })
  it('classifies each report from its own job evidence and reports age only as context', async () => {
    const reports = [
      generating('r-none', '2026-07-04T00:00:00Z'),
      generating('r-failed', '2026-07-04T00:00:01Z'),
      generating('r-live', '2026-07-04T00:00:02Z', new Date(NOW.getTime() + 30_000)),
    ]
    const { database, calls } = fakeDb({
      ...tenantAndVenue,
      weeklyReport: { findMany: () => reports },
      generationRequestDispatch: {
        findFirst: () => ({ status: 'CONSUMED', attempts: 1, lastError: null }),
      },
      jobRecord: {
        findMany: (args: any) =>
          args.where.payload.equals === 'r-failed'
            ? [
                {
                  id: 'job-f',
                  jobName: 'weekly-report-process',
                  status: 'FAILED',
                  error: 'boom',
                  attemptNumber: 3,
                  maxAttempts: 3,
                  failureDisposition: 'ATTEMPTS_EXHAUSTED',
                  startedAt: new Date('2026-07-04T00:10:00Z'),
                  completedAt: new Date('2026-07-04T00:11:00Z'),
                  createdAt: new Date('2026-07-04T00:10:00Z'),
                },
              ]
            : [],
      },
    })
    const output = await call(
      'reports.reconcile_generating',
      { tenantId: TENANT },
      context(database),
    )
    expect(output.items.map((item: any) => [item.reportId, item.classification])).toEqual([
      ['r-none', 'no_job_found'],
      ['r-failed', 'job_failed'],
      ['r-live', 'job_running_with_heartbeat'],
    ])
    // All three are about 90 days old; age did not make any of them "failed".
    expect(output.items.every((item: any) => item.ageMinutes > 100_000)).toBe(true)
    expect(output.items[1].evidence.latestJob.failureDisposition).toBe('ATTEMPTS_EXHAUSTED')
    expect(output.complete).toBe(true)
    expectEveryQueryScopedTo(calls, TENANT, ['tenant', 'venue'])
  })
  it('pages with a cursor that must belong to the query', async () => {
    const reports = Array.from({ length: 26 }, (_, index) =>
      generating(
        `r-${String(index).padStart(2, '0')}`,
        `2026-07-04T00:00:${String(index).padStart(2, '0')}Z`,
      ),
    )
    const first = fakeDb({ ...tenantAndVenue, weeklyReport: { findMany: () => reports } })
    const page = await call(
      'reports.reconcile_generating',
      { tenantId: TENANT },
      context(first.database),
    )
    expect(page.items).toHaveLength(25)
    expect(page.complete).toBe(false)
    // Cursors are opaque and bound to the issuing query; the handler position is inside.
    const position = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')).p
    expect(position).toContain('|r-24')
    const foreign = fakeDb({ ...tenantAndVenue, weeklyReport: { findFirst: () => null } })
    await expect(
      call(
        'reports.reconcile_generating',
        { tenantId: TENANT, cursor: page.nextCursor },
        context(foreign.database),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })
})

describe('venues.list_sessions', () => {
  const session = (id: string, at: string, scope = 'PUBLIC') => ({
    id,
    startedAt: new Date(at),
    lastActiveAt: new Date(at),
    experienceScope: scope,
    entrySurface: null,
    dispositionOperationId: null,
  })
  const args = {
    tenantId: TENANT,
    venueId: VENUE,
    windowStart: '2026-09-30T00:00:00.000Z',
    windowEnd: '2026-10-02T00:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  }
  it('reports included, excluded and unavailable counts and never confuses visitor with total messages', async () => {
    const { database, calls } = fakeDb({
      ...tenantAndVenue,
      visitorSession: {
        groupBy: () => [
          { experienceScope: 'PUBLIC', _count: { _all: 5 } },
          { experienceScope: 'SECOND_LAYER', _count: { _all: 2 } },
          { experienceScope: 'LEGACY', _count: { _all: 1 } },
        ],
        findMany: () => [session('s1', '2026-10-01T03:30:00Z')],
      },
      message: {
        groupBy: () => [
          { sessionId: 's1', role: 'user', _count: { _all: 3 } },
          { sessionId: 's1', role: 'assistant', _count: { _all: 3 } },
        ],
      },
      guestChatTurn: {
        groupBy: (input: any) =>
          input.by.length === 2
            ? [{ sessionId: 's1', status: 'COMPLETE', _count: { _all: 3 } }]
            : [{ sessionId: 's1', _count: { _all: 1 } }],
      },
    })
    const output = await call('venues.list_sessions', args, context(database))
    expect(output.counts).toMatchObject({
      included: 5,
      excluded: { guest: 0, employee: 2, other: 1 },
      unavailable: { testClassification: true },
    })
    expect(output.items[0]).toMatchObject({
      classification: 'guest',
      visitorMessages: 3,
      assistantMessages: 3,
      totalMessages: 6,
      localDate: '2026-09-30',
      turns: 3,
    })
    expect(output.window.timeZone).toBe('America/Los_Angeles')
    expect(JSON.stringify(output)).not.toContain('content')
    expectEveryQueryScopedTo(calls, TENANT, ['tenant', 'venue'])
  })
  it('filters employee sessions and excludes guests', async () => {
    const { database, calls } = fakeDb({
      ...tenantAndVenue,
      visitorSession: {
        groupBy: () => [
          { experienceScope: 'PUBLIC', _count: { _all: 5 } },
          { experienceScope: 'SECOND_LAYER', _count: { _all: 2 } },
        ],
        findMany: () => [session('e1', '2026-10-01T10:00:00Z', 'SECOND_LAYER')],
      },
    })
    const output = await call(
      'venues.list_sessions',
      { ...args, classification: 'employee' },
      context(database),
    )
    expect(output.counts.included).toBe(2)
    expect(output.counts.excluded.guest).toBe(5)
    expect(output.items[0].classification).toBe('employee')
    const find = calls.find(
      (entry) => entry.model === 'visitorSession' && entry.method === 'findMany',
    )
    expect(find?.args.where.experienceScope).toBe('SECOND_LAYER')
  })
  it('paginates with a bound cursor and rejects one from outside the query', async () => {
    const rows = Array.from({ length: 26 }, (_, index) =>
      session(`s-${index}`, `2026-10-01T00:${String(59 - index).padStart(2, '0')}:00Z`),
    )
    const { database } = fakeDb({
      ...tenantAndVenue,
      visitorSession: { groupBy: () => [], findMany: () => rows },
    })
    const first = await call('venues.list_sessions', args, context(database))
    expect(first.items).toHaveLength(25)
    expect(first.complete).toBe(false)
    const foreign = fakeDb({
      ...tenantAndVenue,
      visitorSession: { groupBy: () => [], findFirst: () => null, findMany: () => [] },
    })
    await expect(
      call(
        'venues.list_sessions',
        { ...args, cursor: first.nextCursor },
        context(foreign.database),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })
  it('is not found for a tenant outside the grant', async () => {
    const { database } = fakeDb(tenantAndVenue)
    await expect(
      call('venues.list_sessions', { ...args, tenantId: OTHER }, context(database)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('labels local dates in the requested zone', () => {
    expect(localDate(new Date('2026-10-01T03:30:00Z'), 'America/Los_Angeles')).toBe('2026-09-30')
    expect(localDate(new Date('2026-10-01T03:30:00Z'), 'UTC')).toBe('2026-10-01')
  })
})

describe('venues.get_answer_evidence', () => {
  const sha = 'a'.repeat(64)
  const bundle = {
    schemaVersion: 'guest-answer-evidence-v1',
    promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
    answerHash: sha,
    systemPromptHash: sha,
    evidenceSetHash: sha,
    routeConfigurationVersion: 'route-7',
    system: { staticPart: 'static', dynamicPart: 'dynamic' },
    sources: [
      {
        sourceId: 'published-content:mod1:rev9',
        kind: 'PUBLISHED_CONTENT',
        label: 'Opening hours',
        rank: 0,
        snapshot: '{"hours":"9 to 5","contact":"desk@example.com"}',
        snapshotHash: sha,
      },
    ],
  }
  const turn = (overrides: Record<string, unknown> = {}) => ({
    id: 'turn-1',
    turnSequence: 1,
    status: 'COMPLETE',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    completedAt: new Date('2026-10-01T10:00:03Z'),
    fallbackCode: null,
    failureCode: null,
    replayMetadata: { places: [], citations: [], answerEvidence: bundle },
    userMessageId: 'm-user',
    assistantMessageId: 'm-assistant',
    providerOperations: [{ usageReference: 'usage-1' }],
    ...overrides,
  })
  const handlers = (turnRow: any, extra: Record<string, any> = {}) => ({
    ...tenantAndVenue,
    visitorSession: {
      findFirst: () => ({ id: 's1', experienceScope: 'PUBLIC', dispositionOperationId: null }),
    },
    guestChatTurn: {
      findMany: (args: any) =>
        args.where.replayMetadata
          ? [{ id: 'turn-1' }]
          : [{ ...turnRow, providerOperations: undefined }],
      findFirst: () => turnRow,
    },
    message: {
      findMany: () => [
        { id: 'm-user', content: 'Call me on +1 415 555 0100 or mail jo@example.com' },
        { id: 'm-assistant', content: 'The desk opens at nine.' },
      ],
    },
    aiUsageEvent: {
      findMany: () => [
        {
          id: 'usage-1',
          provider: 'example-provider',
          model: 'example-model',
          routeModelKey: 'chat',
          capability: 'GUEST_CHAT',
          fallbackUsed: false,
          success: true,
          errorCode: null,
          latencyMs: 900,
          attempts: 1,
        },
      ],
    },
    analyticsEvent: {
      findFirst: () => ({ metadata: { totalMs: 1200, modelMs: 900, retrievalMs: 80 } }),
    },
    ...extra,
  })
  const args = { tenantId: TENANT, venueId: VENUE, sessionId: 's1', turnSequence: 1 }

  it('returns stored sources and revisions, model, latency and redacted text', async () => {
    const { database, calls } = fakeDb(handlers(turn()))
    const output = await call('venues.get_answer_evidence', args, context(database))
    expect(output.turn.evidence.state).toBe('stored')
    expect(output.turn.evidence.guideCoverageState).toBe('UNKNOWN')
    expect(output.turn.evidence.guideCoverage).toBeNull()
    expect(output.turn.evidence.sources[0]).toMatchObject({
      moduleId: 'mod1',
      revisionId: 'rev9',
      kind: 'PUBLISHED_CONTENT',
    })
    expect(output.turn.evidence.routeConfigurationVersion).toBe('route-7')
    expect(output.turn.model.calls[0]).toMatchObject({ model: 'example-model', latencyMs: 900 })
    expect(output.turn.latency).toMatchObject({ state: 'recorded', totalMs: 1200 })
    expect(output.turn.release.releaseId).toBeNull()
    expect(output.turn.textMode).toBe('redacted')
    const question = output.turn.question.text
    expect(question).not.toContain('jo@example.com')
    expect(question).not.toContain('555')
    expect(output.turn.evidence.sources[0].excerpt.text).not.toContain('desk@example.com')
    expect(output.turns[0]).toMatchObject({ turnSequence: 1, evidenceStored: true })
    expectEveryQueryScopedTo(calls, TENANT, ['tenant', 'venue', 'aiUsageEvent'])
    const usage = calls.find((entry) => entry.model === 'aiUsageEvent')
    expect(JSON.stringify(usage?.args.where)).toContain(TENANT)
  })

  it.each(['valid', 'stale-overall', 'disposed'] as const)('projects %s stored coverage through the strict operator output contract', async (caseName) => {
    const guideCoverage = {
      schemaVersion: 'guest-guide-coverage-v1', mode: 'FULL', loadStatus: 'READY',
      projectionPath: 'LEGACY', incomplete: false, placeCount: 2, knowledgeCount: 1,
      includedDetailCount: 3, promptChars: 900, promptSha256: sha, detailIdSetSha256: sha,
    }
    const withCoverage = buildGuestAnswerEvidenceBundle({
      assistantResponse: 'The desk opens at nine.', staticSystemPrompt: 'Static fictional rules.',
      dynamicSystemPrompt: 'Current fictional facts.',
      sources: [{ sourceId: 'venue:fictional', kind: 'VENUE_PROFILE', label: 'Fictional park',
        snapshot: { guideCoverage } }],
    })
    const retained = caseName === 'stale-overall' ? { ...withCoverage, evidenceSetHash: sha } : withCoverage
    const overrides = caseName === 'disposed' ? {
      visitorSession: { findFirst: () => ({ id: 's1', experienceScope: 'PUBLIC', dispositionOperationId: 'fictional-disposition' }) },
    } : {}
    const { database, calls } = fakeDb(handlers(turn({ replayMetadata: {
      places: [], citations: [], answerEvidence: retained,
    } }), overrides))
    const output = await call('venues.get_answer_evidence', args, context(database))
    expect(output.turn.evidence.guideCoverageState).toBe(caseName === 'valid' ? 'KNOWN' : 'UNKNOWN')
    expect(output.turn.evidence.guideCoverage).toEqual(caseName === 'valid' ? guideCoverage : null)
    if (caseName === 'disposed') expect(calls.some((entry) => entry.model === 'message')).toBe(false)
  })

  it('says unavailable, not zero or fine, when nothing was stored', async () => {
    const { database } = fakeDb(
      handlers(turn({ replayMetadata: { places: [], citations: [] }, providerOperations: [] }), {
        analyticsEvent: { findFirst: () => null },
        aiUsageEvent: { findMany: () => [] },
        guestChatTurn: {
          findMany: () => [],
          findFirst: () =>
            turn({ replayMetadata: { places: [], citations: [] }, providerOperations: [] }),
        },
      }),
    )
    const output = await call('venues.get_answer_evidence', args, context(database))
    expect(output.turn.evidence).toMatchObject({ state: 'unavailable', sourceCount: 0 })
    expect(output.turn.evidence.reason).toContain('stored no answer evidence')
    expect(output.turn.model.state).toBe('unavailable')
    expect(output.turn.latency.state).toBe('unavailable')
    expect(output.turn.outcome.providerFallbackUsed).toBeNull()
    expect(output.turn.attribution.state).toBe('none')
  })

  it('withholds visitor text when the conversation was disposed', async () => {
    const { database } = fakeDb(
      handlers(turn(), {
        visitorSession: {
          findFirst: () => ({
            id: 's1',
            experienceScope: 'PUBLIC',
            dispositionOperationId: 'disposition-1',
          }),
        },
      }),
    )
    const output = await call('venues.get_answer_evidence', args, context(database))
    expect(output.disposed).toBe(true)
    expect(output.turn.textMode).toBe('withheld')
    expect(output.turn.question).toBeNull()
    expect(output.turn.answer).toBeNull()
  })

  it('lists turns when none is named, and is not found for a session outside the tenant', async () => {
    const { database } = fakeDb(handlers(turn()))
    const listed = await call(
      'venues.get_answer_evidence',
      { tenantId: TENANT, venueId: VENUE, sessionId: 's1' },
      context(database),
    )
    expect(listed.turn).toBeNull()
    expect(listed.turnsComplete).toBe(true)
    const missing = fakeDb({ ...tenantAndVenue, visitorSession: { findFirst: () => null } })
    await expect(
      call('venues.get_answer_evidence', args, context(missing.database)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('redacts addresses, phone numbers and long digit runs', () => {
    expect(redactGuestText('jo@example.com, +44 20 7946 0958, card 4111111111111111')).toBe(
      '[address withheld], [number withheld], card [number withheld]',
    )
  })
})

describe('routines.get_run_status', () => {
  const routine = (overrides: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    venueId: VENUE,
    routineKey: 'freshness-check',
    intervalSeconds: 3600,
    maxAttempts: 1,
    maxRunsPerDay: 24,
    perRunBudgetE8Usd: null,
    dailyBudgetE8Usd: null,
    enabled: true,
    nextRunAt: new Date(NOW.getTime() + 600_000),
    lastRunAt: null,
    lastSkipReason: null,
    createdBy: 'user_owner',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    agentIdentity: { id: 'agent-1', name: 'Monitor', enabled: true },
    budgetCents: null,
    budgetCurrency: null,
    budgetPeriod: null,
    estimatedRunCostCents: null,
    stopRules: {},
    stoppedAt: null,
    stopReason: null,
    ...overrides,
  })
  const run = (status: string) => ({
    agentRunId: 'run-1',
    scheduledFor: new Date('2026-10-02T11:00:00Z'),
    agentRun: { status, errorCode: null, startedAt: null, completedAt: null },
  })
  const status = async (routineRow: any, dispatches: any[], runsToday = 0) => {
    const { database, calls } = fakeDb({
      ...tenantAndVenue,
      agentRoutine: { findFirst: () => routineRow },
      agentRoutineDispatch: { findMany: () => dispatches, count: () => runsToday },
    })
    const output = await call(
      'routines.get_run_status',
      { tenantId: TENANT, routineId: 'rt-1' },
      context(database),
    )
    return { output, calls }
  }
  it('is unknown, never ok, when nothing has run, and reports no budget and no stop yet', async () => {
    const { output, calls } = await status(routine(), [])
    expect(output.health).toBe('unknown')
    expect(output.lastResult).toBeNull()
    expect(output.schedule).toMatchObject({
      kind: 'interval',
      timeZone: null,
      cadence: 'every 1 hour(s)',
    })
    expect(output.limits.cost).toMatchObject({ enforced: false })
    expect(output.limits.cost.budget).toBeNull()
    expect(output.limits.stopRules).toEqual({
      subject: null,
      maxReminders: null,
      endsAt: null,
      stoppedAt: null,
      stopReason: null,
    })
    expect(output.stopConditions.find((s: any) => s.key === 'stopped_by_rule').active).toBe(false)
    expect(output.stopConditions.find((s: any) => s.key === 'budget_exceeded').active).toBeNull()
    expect(output.owner.createdBy).toBe('user_owner')
    expectEveryQueryScopedTo(calls, TENANT, ['tenant'])
  })
  it('reports ok, attention and a stop condition from evidence', async () => {
    expect((await status(routine(), [run('COMPLETED')])).output.health).toBe('ok')
    expect((await status(routine(), [run('FAILED')])).output.health).toBe('attention')
    const limited = await status(routine(), [run('COMPLETED')], 24)
    expect(limited.output.stopConditions.find((s: any) => s.key === 'daily_run_limit').active).toBe(
      true,
    )
    expect((await status(routine({ enabled: false }), [])).output.health).toBe('unknown')
    expect(
      routineHealth({
        enabled: true,
        intervalSeconds: 60,
        nextRunAt: new Date(NOW.getTime() - 3_600_000),
        lastSkipReason: null,
        latestRun: { status: 'COMPLETED' },
        now: NOW,
      }).health,
    ).toBe('attention')
  })
  it('reports an enforced budget with the period spend, and a routine that stopped itself', async () => {
    const budgeted = routine({
      budgetCents: 500,
      budgetCurrency: 'USD',
      budgetPeriod: 'DAY',
      estimatedRunCostCents: 40,
      lastSkipReason: 'BUDGET_EXCEEDED',
      stopRules: {
        subject: { kind: 'SUPPORT_REQUEST', id: 'req-1' },
        maxReminders: 3,
        endsAt: '2026-12-01T00:00:00.000Z',
      },
      enabled: false,
      stoppedAt: new Date('2026-10-02T10:00:00Z'),
      stopReason: 'TARGET_REPLIED',
    })
    const { database, calls } = fakeDb({
      ...tenantAndVenue,
      agentRoutine: { findFirst: () => budgeted },
      agentRoutineDispatch: { findMany: () => [], count: () => 0 },
      agentRoutineBudgetUsage: { findFirst: () => ({ spentCents: 120 }) },
    })
    const output = await call(
      'routines.get_run_status',
      { tenantId: TENANT, routineId: 'rt-1' },
      context(database),
    )
    expect(output.limits.cost).toMatchObject({
      enforced: true,
      budget: {
        amountCents: 500,
        currency: 'USD',
        period: 'DAY',
        estimatedRunCostCents: 40,
        spentCents: 120,
        remainingCents: 380,
      },
    })
    expect(output.limits.stopRules).toMatchObject({
      subject: { kind: 'SUPPORT_REQUEST', id: 'req-1' },
      maxReminders: 3,
      stopReason: 'TARGET_REPLIED',
    })
    expect(output.stopConditions.find((s: any) => s.key === 'stopped_by_rule').active).toBe(true)
    expect(output.stopConditions.find((s: any) => s.key === 'budget_exceeded').active).toBe(true)
    expectEveryQueryScopedTo(calls, TENANT, ['tenant'])
  })
  it('is not found for a routine of another tenant', async () => {
    const { database } = fakeDb({ ...tenantAndVenue, agentRoutine: { findFirst: () => null } })
    await expect(
      call(
        'routines.get_run_status',
        { tenantId: TENANT, routineId: 'foreign' },
        context(database),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('operator.get_attention', () => {
  it('never turns an unmeasured category into clear', () => {
    expect(attentionState({ kind: 'unknown', reason: 'x' })).toBe('unknown')
    expect(attentionState({ kind: 'measured', count: 0, items: [] })).toBe('clear')
    expect(attentionState({ kind: 'measured', count: 2, items: [] })).toBe('attention')
    expect(
      attentionState({ kind: 'measured', count: 0, items: [], unknownReason: 'no dates' }),
    ).toBe('unknown')
  })

  it('aggregates records with ids and next actions, flags unknowns, and binds the tenant', async () => {
    const { database, calls } = fakeDb({
      tenant: { findUnique: () => ({ id: TENANT }) },
      operatorProposal: {
        count: () => 1,
        findMany: () => [
          {
            id: 'prop-1',
            planId: null,
            kind: 'reports.publish',
            status: 'PENDING',
            failureCode: null,
            targetVenueId: VENUE,
            createdAt: new Date('2026-10-01T00:00:00Z'),
          },
        ],
      },
      agentQuestion: {
        count: () => 1,
        findMany: () => [
          {
            id: 'q-1',
            venueId: VENUE,
            question: 'Which hours apply?',
            createdAt: new Date('2026-09-30T00:00:00Z'),
          },
        ],
      },
      weeklyReport: {
        count: () => 1,
        findMany: () => [
          {
            id: 'rep-old',
            venueId: VENUE,
            weekStart: new Date('2026-06-29T00:00:00Z'),
            weekEnd: new Date('2026-07-05T00:00:00Z'),
            createdAt: new Date('2026-07-04T00:00:00Z'),
            updatedAt: new Date('2026-07-04T00:00:00Z'),
            executionLeaseExpiresAt: null,
          },
        ],
      },
      venueKnowledgeEntry: { count: (args: any) => (args.where.lastReviewedAt === null ? 3 : 0) },
      place: { count: () => 0 },
      billingAccount: {
        findFirst: () => ({
          id: 'bill-1',
          status: 'ACTIVE',
          reconciliationHealth: 'UNKNOWN',
          updatedAt: NOW,
        }),
      },
    })
    const output = await call('operator.get_attention', { tenantId: TENANT }, context(database))
    const byKey = Object.fromEntries(output.categories.map((c: any) => [c.key, c]))
    expect(byKey.pending_decisions).toMatchObject({ state: 'attention', count: 1 })
    expect(byKey.pending_decisions.items[0]).toMatchObject({
      recordType: 'operator_proposal',
      recordId: 'prop-1',
    })
    expect(byKey.blocking_questions.items[0].recordId).toBe('q-1')
    expect(byKey.generating_reports.items[0]).toMatchObject({
      recordType: 'weekly_report',
      recordId: 'rep-old',
    })
    expect(byKey.generating_reports.items[0].summary.text).toContain('no_job_found')
    // Sources never reviewed and billing never reconciled are unknown, not clear and not failed.
    expect(byKey.stale_sources).toMatchObject({ state: 'unknown', count: 0 })
    expect(byKey.stale_sources.unknownReason).toContain('3 enabled source')
    expect(byKey.billing_exceptions).toMatchObject({ state: 'unknown', count: null })
    expect(byKey.failed_jobs.state).toBe('clear')
    expect(byKey.expiring_notices.state).toBe('clear')
    expect(output.totals.attention + output.totals.unknown + output.totals.clear).toBe(
      output.categories.length,
    )
    const scoped = calls.filter(
      (entry) => !['tenant', 'prospectEmailMessage'].includes(entry.model),
    )
    for (const entry of scoped) {
      const where = JSON.stringify(entry.args?.where ?? {})
      expect(
        where.includes(TENANT) || where.includes('grant-1'),
        `${entry.model}.${entry.method}`,
      ).toBe(true)
    }
    const mail = calls.find((entry) => entry.model === 'prospectEmailMessage')
    expect(JSON.stringify(mail?.args.where)).toContain(TENANT)
  })

  it('marks categories unknown when the grant lacks the capability or a measure fails', async () => {
    const { database } = fakeDb({
      tenant: { findUnique: () => ({ id: TENANT }) },
      operatorProposal: {
        count: () => {
          throw new Error('db down')
        },
      },
    })
    const output = await call(
      'operator.get_attention',
      { tenantId: TENANT },
      context(database, { capabilities: ['operator:read'] }),
    )
    const byKey = Object.fromEntries(output.categories.map((c: any) => [c.key, c]))
    expect(byKey.pending_decisions).toMatchObject({ state: 'unknown', count: null })
    expect(byKey.billing_exceptions.unknownReason).toContain('billing:read')
    expect(byKey.generating_reports.state).toBe('unknown')
  })

  it('is not found for a tenant outside the grant', async () => {
    const { database, calls } = fakeDb({ tenant: { findUnique: () => ({ id: OTHER }) } })
    await expect(
      call('operator.get_attention', { tenantId: OTHER }, context(database)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls).toHaveLength(0)
  })
})
