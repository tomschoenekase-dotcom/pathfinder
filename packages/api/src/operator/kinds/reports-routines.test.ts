/* eslint-disable @typescript-eslint/no-explicit-any -- loose fakes for the Prisma delegate surface */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  createRoutine: vi.fn(),
  setEnabled: vi.fn(),
  updateRoutine: vi.fn(),
  requestDraft: vi.fn(),
  kick: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  publishWeeklyReportAction: mocks.publish,
  createAgentRoutineAction: mocks.createRoutine,
  setAgentRoutineEnabledAction: mocks.setEnabled,
  updateAgentRoutineDefinitionAction: mocks.updateRoutine,
}))
vi.mock('@pathfinder/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/jobs')>()),
  enqueueGenerationDispatchKick: mocks.kick,
}))
vi.mock('../../lib/weekly-report-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/weekly-report-generation')>()),
  requestWeeklyReportDraftAction: mocks.requestDraft,
}))

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { AgentRoutineActionError, WeeklyReportActionError } from '@pathfinder/db'

import { isAlwaysAskKind, OPERATOR_LOCKED_CAPABILITIES } from '../autonomy'
import { OperatorStaleError, previewDigestOf } from '../proposals'
import { createOperatorRegistry } from '../registry'
import { reportsGenerateKind, reportsPublishKind } from './reports'
import {
  routinesCreateKind,
  routinesDisableKind,
  routinesEnableKind,
  routinesUpdateKind,
} from './routines'

const NOW = new Date('2026-10-02T12:00:00.000Z')
const TENANT = 'tenant-a'
const VENUE = 'venue-a'
const OP = '8a1f1c0e-2f87-4b5e-9d57-6a2b6d7a9d10'
const VERSION = '2026-10-01T00:00:00.000Z'

function fakeDb(handlers: Record<string, Record<string, (args: any) => unknown>> = {}) {
  const calls: { model: string; method: string; args: any }[] = []
  const database = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_u, method: string) => async (args: any) => {
              calls.push({ model, method, args })
              return (handlers[model]?.[method] ?? (() => (method === 'findMany' ? [] : null)))(
                args,
              )
            },
          },
        ),
    },
  ) as any
  return { database, calls }
}

const grant = {
  grantId: 'grant-1',
  allTenants: false,
  tenantIds: [TENANT],
  capabilities: [...OperatorCapability.options],
} as any
const ctx = (database: any) => ({ database, grant, now: NOW }) as any
const apply = (database: any) =>
  ({
    ...ctx(database),
    actor: { type: 'HUMAN', id: 'user_owner', role: 'PLATFORM_ADMIN' },
    proposalId: 'p1',
    operationId: OP,
  }) as any

const scope = { tenantId: TENANT, venueId: VENUE }
const base = {
  tenant: { findUnique: () => ({ id: TENANT }) },
  venue: { findFirst: () => ({ id: VENUE }) },
}

const reportRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'rep-1',
  venueId: VENUE,
  status: 'FAILED',
  weekStart: new Date('2026-06-29T00:00:00Z'),
  weekEnd: new Date('2026-07-05T00:00:00Z'),
  title: 'Weekly',
  updatedAt: new Date(VERSION),
  executionLeaseExpiresAt: null,
  ...overrides,
})

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('registration and approval policy', () => {
  it('registers every new proposal tool against its kind', () => {
    const registry = createOperatorRegistry()
    for (const tool of [
      'reports.propose_generate',
      'reports.propose_publish',
      'routines.propose_create',
      'routines.propose_update',
      'routines.propose_enable',
      'routines.propose_disable',
    ]) {
      expect(registry.kinds.has(tool), tool).toBe(true)
      expect(registry.listTools().find((entry) => entry.name === tool)?.effect).toBe('proposal')
    }
  })
  it('always asks a person for generate, publish and enable', () => {
    for (const kind of ['reports.generate', 'reports.publish', 'routines.enable']) {
      expect(isAlwaysAskKind(kind), kind).toBe(true)
    }
    expect(isAlwaysAskKind('routines.disable')).toBe(false)
    expect(OPERATOR_LOCKED_CAPABILITIES.has('reports:propose')).toBe(true)
    expect(OPERATOR_LOCKED_CAPABILITIES.has('routines:propose')).toBe(false)
  })
})

describe('reports.publish', () => {
  const args = { ...scope, reportId: 'rep-1', expectedUpdatedAt: VERSION, operationId: OP }
  it('binds to the observed version: a moved report differs from the approved target', async () => {
    const { database } = fakeDb({
      weeklyReport: {
        findFirst: () =>
          reportRow({ status: 'DRAFT', updatedAt: new Date('2026-10-01T00:00:05Z') }),
      },
    })
    expect(await reportsPublishKind.targetVersion(args, ctx(database))).toBe(VERSION)
    expect(await reportsPublishKind.currentVersion(args, ctx(database))).not.toBe(VERSION)
  })
  it('says publishing is not delivery in the approval preview and the result', async () => {
    const preview = reportsPublishKind.describe(args)
    expect(preview.lines.join(' ')).toContain('not delivery')
    mocks.publish.mockResolvedValue({ ok: true })
    const { database } = fakeDb({
      weeklyReport: { findFirst: () => reportRow({ status: 'PUBLISHED' }) },
    })
    const outcome = await reportsPublishKind.apply(args, apply(database))
    expect(outcome.result).toMatchObject({ status: 'PUBLISHED', delivered: false })
    expect(mocks.publish.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      venueId: VENUE,
      reportId: 'rep-1',
      actor: { type: 'HUMAN', id: 'user_owner' },
    })
  })
  it('turns a conflict or wrong status into a stale rejection, never a silent publish', async () => {
    const { database } = fakeDb({ weeklyReport: { findFirst: () => reportRow() } })
    for (const code of ['CONFLICT', 'INVALID_STATUS'] as const) {
      mocks.publish.mockRejectedValueOnce(new WeeklyReportActionError(code, 'moved'))
      await expect(reportsPublishKind.apply(args, apply(database))).rejects.toBeInstanceOf(
        OperatorStaleError,
      )
    }
    mocks.publish.mockRejectedValueOnce(new WeeklyReportActionError('NOT_FOUND', 'gone'))
    await expect(reportsPublishKind.apply(args, apply(database))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
  it('reconciles only what it can prove: untouched draft is not applied, published is unknown', async () => {
    const draft = fakeDb({ weeklyReport: { findFirst: () => reportRow({ status: 'DRAFT' }) } })
    expect(await reportsPublishKind.reconcile!(args, apply(draft.database))).toEqual({
      state: 'not_applied',
    })
    const published = fakeDb({
      weeklyReport: { findFirst: () => reportRow({ status: 'PUBLISHED' }) },
    })
    expect(await reportsPublishKind.reconcile!(args, apply(published.database))).toEqual({
      state: 'unknown',
    })
  })
  it('hides a report of another venue or tenant at authorization', async () => {
    const { database } = fakeDb({ ...base, weeklyReport: { findFirst: () => null } })
    await expect(reportsPublishKind.authorize!(args, ctx(database))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
  it('changes the preview digest when the target version changes (approval cannot replay across versions)', () => {
    const first = previewDigestOf(reportsPublishKind, args, VERSION)
    expect(first).toBe(previewDigestOf(reportsPublishKind, args, VERSION))
    expect(first).not.toBe(previewDigestOf(reportsPublishKind, args, '2026-10-02T00:00:00.000Z'))
  })
})

describe('reports.generate', () => {
  const fresh = {
    ...scope,
    weekStart: '2026-09-21T00:00:00.000Z',
    weekEnd: '2026-09-27T23:59:59.000Z',
    operationId: OP,
  }
  const retry = { ...scope, retryOfReportId: 'rep-1', expectedUpdatedAt: VERSION, operationId: OP }
  const requested = {
    dispatchId: 'd1',
    reportId: 'rep-new',
    requestId: OP,
    dispatchState: 'PENDING',
    replayed: false,
    enqueueAllowed: true,
  }

  it('uses the operation id as the request id, kicks the dispatch and never publishes', async () => {
    mocks.requestDraft.mockResolvedValue(requested)
    const { database } = fakeDb({
      weeklyReport: { findFirst: () => reportRow({ id: 'rep-new', status: 'GENERATING' }) },
    })
    const outcome = await reportsGenerateKind.apply(fresh, apply(database))
    expect(mocks.requestDraft.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      venueId: VENUE,
      requestId: OP,
      actor: { id: 'user_owner', role: 'PLATFORM_ADMIN' },
    })
    expect(mocks.kick).toHaveBeenCalledWith('d1')
    expect(outcome.result).toMatchObject({ reportId: 'rep-new', published: false, replayed: false })
  })
  it('still succeeds when the kick fails, because the durable dispatch is retried', async () => {
    mocks.requestDraft.mockResolvedValue(requested)
    mocks.kick.mockRejectedValue(new Error('redis down'))
    const { database } = fakeDb({ weeklyReport: { findFirst: () => reportRow() } })
    await expect(reportsGenerateKind.apply(fresh, apply(database))).resolves.toBeDefined()
  })
  it('reconciles by the request-id receipt', async () => {
    const none = fakeDb({})
    expect(await reportsGenerateKind.reconcile!(fresh, apply(none.database))).toEqual({
      state: 'not_applied',
    })
    const done = fakeDb({
      generationRequestDispatch: { findFirst: () => ({ recordId: 'rep-new', status: 'CONSUMED' }) },
      weeklyReport: { findFirst: () => reportRow({ id: 'rep-new' }) },
    })
    const result: any = await reportsGenerateKind.reconcile!(fresh, apply(done.database))
    expect(result.state).toBe('applied')
    expect(result.outcome.result).toMatchObject({ reportId: 'rep-new', replayed: true })
    expect(JSON.stringify(none.calls)).toContain(OP)
  })
  it('retries a FAILED report with its own week and title', async () => {
    mocks.requestDraft.mockResolvedValue(requested)
    const { database } = fakeDb({ weeklyReport: { findFirst: () => reportRow() } })
    await reportsGenerateKind.apply(retry, apply(database))
    const request = mocks.requestDraft.mock.calls[0]![0]
    expect(request.weekStart.toISOString()).toBe('2026-06-29T00:00:00.000Z')
    expect(request.title).toBe('Weekly')
  })
  it('refuses to retry a report whose worker is alive or whose state is unknown', async () => {
    const live = fakeDb({
      weeklyReport: {
        findFirst: () =>
          reportRow({
            status: 'GENERATING',
            executionLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
          }),
      },
    })
    await expect(reportsGenerateKind.apply(retry, apply(live.database))).rejects.toBeInstanceOf(
      OperatorStaleError,
    )
    const unknown = fakeDb({
      weeklyReport: { findFirst: () => reportRow({ status: 'GENERATING' }) },
      jobRecord: {
        findMany: () => [{ id: 'j', status: 'COMPLETE', failureDisposition: null }],
      },
    })
    await expect(reportsGenerateKind.apply(retry, apply(unknown.database))).rejects.toBeInstanceOf(
      OperatorStaleError,
    )
    const published = fakeDb({
      weeklyReport: { findFirst: () => reportRow({ status: 'PUBLISHED' }) },
    })
    await expect(
      reportsGenerateKind.apply(retry, apply(published.database)),
    ).rejects.toBeInstanceOf(OperatorStaleError)
    expect(mocks.requestDraft).not.toHaveBeenCalled()
  })
  it('allows a retry of a GENERATING report that has no job at all', async () => {
    mocks.requestDraft.mockResolvedValue(requested)
    const { database } = fakeDb({
      weeklyReport: { findFirst: () => reportRow({ status: 'GENERATING' }) },
    })
    await expect(reportsGenerateKind.apply(retry, apply(database))).resolves.toBeDefined()
  })
  it('keys a retry to the observed report version', async () => {
    const { database } = fakeDb({
      weeklyReport: { findFirst: () => reportRow({ updatedAt: new Date('2026-10-02T00:00:00Z') }) },
    })
    expect(await reportsGenerateKind.targetVersion(retry, ctx(database))).toBe(VERSION)
    expect(await reportsGenerateKind.currentVersion(retry, ctx(database))).toBe(
      '2026-10-02T00:00:00.000Z',
    )
    expect(await reportsGenerateKind.targetVersion(fresh, ctx(database))).toBeNull()
  })
})

describe('routines kinds', () => {
  const routineRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    venueId: VENUE,
    routineKey: 'freshness',
    enabled: false,
    intervalSeconds: 3600,
    maxRunsPerDay: 24,
    updatedAt: new Date(VERSION),
    agentIdentity: { enabled: true },
    ...overrides,
  })
  const existing = { ...scope, routineId: 'rt-1', expectedUpdatedAt: VERSION, operationId: OP }

  it('creates only through the action that always saves the routine disabled', async () => {
    const args = routinesCreateKind.parse({
      ...scope,
      routineKey: 'freshness',
      agentIdentityId: 'agent-1',
      prompt: 'Check source freshness only.',
      intervalSeconds: 3600,
      operationId: OP,
    })
    expect(routinesCreateKind.describe(args).lines.join(' ')).toContain('created disabled')
    mocks.createRoutine.mockResolvedValue({ routine: { id: 'rt-1' }, replayed: false })
    const { database } = fakeDb({ agentRoutine: { findFirst: () => routineRow() } })
    const outcome = await routinesCreateKind.apply(args, apply(database))
    expect(outcome.result).toMatchObject({ routineId: 'rt-1', enabled: false, replayed: false })
    // No enabled flag can be supplied: the contract is strict and the action never receives one.
    expect(mocks.createRoutine.mock.calls[0]![0]).not.toHaveProperty('enabled')
    expect(() => routinesCreateKind.parse({ ...args, enabled: true })).toThrow()
  })
  it('hides an agent identity outside the tenant at authorization', async () => {
    const args = routinesCreateKind.parse({
      ...scope,
      routineKey: 'k',
      agentIdentityId: 'foreign-agent',
      prompt: 'x',
      intervalSeconds: 60,
      operationId: OP,
    })
    const { database, calls } = fakeDb({ ...base, agentIdentity: { findFirst: () => null } })
    await expect(routinesCreateKind.authorize!(args, ctx(database))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(JSON.stringify(calls.find((c) => c.model === 'agentIdentity')?.args.where)).toContain(
      TENANT,
    )
  })
  it('maps a conflicting create to stale', async () => {
    const args = routinesCreateKind.parse({
      ...scope,
      routineKey: 'k',
      agentIdentityId: 'a',
      prompt: 'x',
      intervalSeconds: 60,
      operationId: OP,
    })
    mocks.createRoutine.mockRejectedValue(new AgentRoutineActionError('CONFLICT', 'different work'))
    await expect(routinesCreateKind.apply(args, apply(fakeDb({}).database))).rejects.toBeInstanceOf(
      OperatorStaleError,
    )
  })
  it('replay: a committed create is found by its audit receipt, an uncommitted one is not applied', async () => {
    const args = routinesCreateKind.parse({
      ...scope,
      routineKey: 'freshness',
      agentIdentityId: 'a',
      prompt: 'x',
      intervalSeconds: 60,
      operationId: OP,
    })
    const none = fakeDb({})
    expect(await routinesCreateKind.reconcile!(args, apply(none.database))).toEqual({
      state: 'not_applied',
    })
    const done = fakeDb({
      auditLog: { findFirst: () => ({ id: 'audit-1' }) },
      agentRoutine: { findFirst: () => routineRow() },
    })
    const result: any = await routinesCreateKind.reconcile!(args, apply(done.database))
    expect(result.state).toBe('applied')
    expect(JSON.stringify(done.calls.find((c) => c.model === 'auditLog')?.args.where)).toContain(OP)
  })

  it('enable: always needs a person, warns about messaging and cost, and refuses a disabled agent', async () => {
    const preview = routinesEnableKind.describe(existing).lines.join(' ')
    expect(preview).toContain('message people or spend money')
    const off = fakeDb({
      agentRoutine: { findFirst: () => routineRow({ agentIdentity: { enabled: false } }) },
    })
    await expect(routinesEnableKind.apply(existing, apply(off.database))).rejects.toBeInstanceOf(
      OperatorStaleError,
    )
    const already = fakeDb({ agentRoutine: { findFirst: () => routineRow({ enabled: true }) } })
    await expect(
      routinesEnableKind.apply(existing, apply(already.database)),
    ).rejects.toBeInstanceOf(OperatorStaleError)
    expect(mocks.setEnabled).not.toHaveBeenCalled()
  })
  it('enable: calls the canonical action with the approving human and the operation id', async () => {
    mocks.setEnabled.mockResolvedValue({})
    const rows = [routineRow(), routineRow({ enabled: true })]
    const { database } = fakeDb({ agentRoutine: { findFirst: () => rows.shift() } })
    const outcome = await routinesEnableKind.apply(existing, apply(database))
    expect(mocks.setEnabled.mock.calls[0]![0]).toMatchObject({
      operationId: OP,
      tenantId: TENANT,
      routineId: 'rt-1',
      enabled: true,
    })
    expect(mocks.setEnabled.mock.calls[0]![1]).toBe('user_owner')
    expect(outcome.result).toMatchObject({ enabled: true })
  })
  it('enable: stale when the routine moved after it was read', async () => {
    const { database } = fakeDb({
      agentRoutine: {
        findFirst: () => routineRow({ updatedAt: new Date('2026-10-02T00:00:00Z') }),
      },
    })
    expect(await routinesEnableKind.targetVersion(existing, ctx(database))).toBe(VERSION)
    expect(await routinesEnableKind.currentVersion(existing, ctx(database))).not.toBe(VERSION)
  })
  it('enable: reconciles by receipt, untouched version, or unknown', async () => {
    const receipt = fakeDb({
      auditLog: { findFirst: () => ({ id: 'a' }) },
      agentRoutine: { findFirst: () => routineRow({ enabled: true }) },
    })
    expect(
      ((await routinesEnableKind.reconcile!(existing, apply(receipt.database))) as any).state,
    ).toBe('applied')
    const untouched = fakeDb({ agentRoutine: { findFirst: () => routineRow() } })
    expect(await routinesEnableKind.reconcile!(existing, apply(untouched.database))).toEqual({
      state: 'not_applied',
    })
    const moved = fakeDb({
      agentRoutine: {
        findFirst: () => routineRow({ updatedAt: new Date('2026-10-02T00:00:00Z') }),
      },
    })
    expect(await routinesEnableKind.reconcile!(existing, apply(moved.database))).toEqual({
      state: 'unknown',
    })
  })
  it('enable can be reverted, and revert only ever disables', async () => {
    mocks.setEnabled.mockResolvedValue({})
    const { database } = fakeDb({ agentRoutine: { findFirst: () => routineRow() } })
    await routinesEnableKind.revert!(
      {
        id: 'p1',
        kind: 'routines.enable',
        args: existing,
        beforeSnapshot: null,
        afterSnapshot: { routineId: 'rt-1', venueId: VENUE },
        result: null,
        targetTenantId: TENANT,
        targetVenueId: VENUE,
        targetRef: null,
      },
      apply(database),
    )
    expect(mocks.setEnabled.mock.calls[0]![0]).toMatchObject({ enabled: false, routineId: 'rt-1' })
    expect(routinesDisableKind.revert).toBeUndefined()
  })

  it('disable: refuses an already disabled routine and otherwise disables', async () => {
    const off = fakeDb({ agentRoutine: { findFirst: () => routineRow() } })
    await expect(routinesDisableKind.apply(existing, apply(off.database))).rejects.toBeInstanceOf(
      OperatorStaleError,
    )
    mocks.setEnabled.mockResolvedValue({})
    const rows = [routineRow({ enabled: true }), routineRow()]
    const { database } = fakeDb({ agentRoutine: { findFirst: () => rows.shift() } })
    const outcome = await routinesDisableKind.apply(existing, apply(database))
    expect(mocks.setEnabled.mock.calls[0]![0]).toMatchObject({ enabled: false })
    expect(outcome.result).toMatchObject({ enabled: false })
  })

  it('update: only a disabled routine, only the named fields, and a conflict is stale', async () => {
    const args = routinesUpdateKind.parse({ ...existing, intervalSeconds: 7200 })
    const on = fakeDb({ agentRoutine: { findFirst: () => routineRow({ enabled: true }) } })
    await expect(routinesUpdateKind.apply(args, apply(on.database))).rejects.toBeInstanceOf(
      OperatorStaleError,
    )
    expect(mocks.updateRoutine).not.toHaveBeenCalled()
    mocks.updateRoutine.mockResolvedValue({})
    const { database } = fakeDb({
      agentRoutine: { findFirst: () => routineRow({ intervalSeconds: 7200 }) },
    })
    await routinesUpdateKind.apply(args, apply(database))
    const sent = mocks.updateRoutine.mock.calls[0]![0]
    expect(sent).toMatchObject({ intervalSeconds: 7200, routineId: 'rt-1' })
    expect(sent).not.toHaveProperty('prompt')
    mocks.updateRoutine.mockRejectedValueOnce(new AgentRoutineActionError('CONFLICT', 'moved'))
    await expect(routinesUpdateKind.apply(args, apply(database))).rejects.toBeInstanceOf(
      OperatorStaleError,
    )
  })
})
