import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  type Touch = { kind: 'db-touch' | 'external-touch'; path: string; args: unknown[] }
  const dbTouches: Touch[] = []
  const externalTouches: Touch[] = []
  function makeDbProxy(parts: string[]): unknown {
    return new Proxy(() => undefined, {
      get(_target, property) {
        if (property === 'then') return undefined
        return makeDbProxy([...parts, String(property)])
      },
      apply(_target, _thisArg, args: unknown[]) {
        if (parts.join('.') === '$transaction' && typeof args[0] === 'function') {
          return (args[0] as (tx: unknown) => unknown)(rootDb)
        }
        const touch: Touch = { kind: 'db-touch', path: parts.join('.'), args }
        dbTouches.push(touch)
        return Promise.reject(touch)
      },
    })
  }

  const rootDb = makeDbProxy([])

  const external = (path: string) =>
    vi.fn((...args: unknown[]) => {
      const touch: Touch = { kind: 'external-touch', path, args }
      externalTouches.push(touch)
      return Promise.reject(touch)
    })

  return {
    db: rootDb,
    dbTouches,
    externalTouches,
    inviteOrganizationMember: external('external.inviteOrganizationMember'),
    listPendingOrganizationInvitations: external('external.listPendingOrganizationInvitations'),
  }
})

type LegacyHarnessTx = {
  venue: { findFirst: (args: unknown) => unknown }
  place: { findFirst: (args: unknown) => unknown }
  venueKnowledgeEntry: { findFirst: (args: unknown) => unknown }
}

type LegacyHarnessClient = {
  $transaction: (callback: (tx: LegacyHarnessTx) => unknown) => unknown
}

vi.mock('@pathfinder/db', async () => {
  const { z } = await import('zod')
  return {
    VenueActionError: class VenueActionError extends Error {},
    createVenueAction: vi.fn(
      (input: { tenantId: string; baseSlug: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { tenantId: input.tenantId, slug: input.baseSlug } }),
        ),
    ),
    updateVenueAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    updateVenueAiConfigAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    updateVenueChatDesignAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    deleteVenueAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    LegacyContentActionError: class LegacyContentActionError extends Error {},
    createLegacyPlaceAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    bulkCreateLegacyPlacesAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    updateLegacyPlaceAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.place.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    retireLegacyPlaceAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.place.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    createLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    bulkCreateLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    updateLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venueKnowledgeEntry.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    retireLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venueKnowledgeEntry.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    OperationalUpdateActionError: class OperationalUpdateActionError extends Error {},
    operationalUpdateActionSelect: { id: true },
    createOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; fields: { venueId: string } },
        client: {
          $transaction: (
            callback: (tx: { venue: { findFirst: (args: unknown) => unknown } }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({
            where: { id: input.fields.venueId, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    updateOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; id: string },
        client: {
          $transaction: (
            callback: (tx: {
              operationalUpdate: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.operationalUpdate.findFirst({
            where: { id: input.id, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    scheduleOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; id: string },
        client: {
          $transaction: (
            callback: (tx: {
              operationalUpdate: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.operationalUpdate.findFirst({
            where: { id: input.id, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    expireOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; id: string },
        client: {
          $transaction: (
            callback: (tx: {
              operationalUpdate: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.operationalUpdate.findFirst({
            where: { id: input.id, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    IntakeActionError: class IntakeActionError extends Error {},
    websiteProposalInput: z
      .object({
        kind: z.literal('WEBSITE'),
        displayName: z.string(),
        websiteUri: z.string().url(),
      })
      .strict(),
    interviewProposalInput: z
      .object({ kind: z.literal('INTERVIEW'), displayName: z.string(), submission: z.unknown() })
      .strict(),
    createIntakeProposal: vi.fn(
      (input: { db: typeof harness.db; tenantId: string; venueId: string }) =>
        (input.db as { venue: { findFirst: (args: unknown) => unknown } }).venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        }),
    ),
    listIntakeProposals: vi.fn(
      (input: { db: typeof harness.db; tenantId: string; venueId: string }) =>
        (input.db as { venue: { findFirst: (args: unknown) => unknown } }).venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        }),
    ),
    linkIntakePackageDraft: vi.fn(
      (input: { db: typeof harness.db; tenantId: string; venueId: string; runId: string }) =>
        (
          input.db as {
            intakeRun: { findFirst: (args: unknown) => unknown }
          }
        ).intakeRun.findFirst({
          where: { id: input.runId, tenantId: input.tenantId, venueId: input.venueId },
          select: { id: true },
        }),
    ),
    SupportActionError: class SupportActionError extends Error {},
    appendSupportMessageAction: vi.fn(
      (
        input: { requestId: string; tenantId: string; venueId: string },
        client: {
          $transaction: (
            callback: (tx: {
              supportRequest: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.supportRequest.findFirst({
            where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
            select: { id: true, status: true, version: true },
          }),
        ),
    ),
    assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
    createSupportRequestAction: vi.fn(
      (
        input: { tenantId: string; venueId: string },
        client: {
          $transaction: (
            callback: (tx: { venue: { findFirst: (args: unknown) => unknown } }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    db: harness.db,
    lockContentVersionEntity: vi.fn().mockResolvedValue(undefined),
    lockOperationalUpdateCapacity: vi.fn().mockResolvedValue(undefined),
    lockVenueContentMutation: vi.fn().mockResolvedValue(undefined),
    setContentVersionContext: vi.fn().mockResolvedValue(undefined),
    writeAuditLog: vi.fn(),
    writeAuditLogStrict: vi.fn(),
  }
})

vi.mock('@pathfinder/jobs', () => ({
  enqueueEmbedKnowledgeEntry: vi.fn(),
  enqueueEmbedPlace: vi.fn(),
}))

vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn() }))

vi.mock('@pathfinder/config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return {
    ...actual,
    inviteOrganizationMember: harness.inviteOrganizationMember,
    listPendingOrganizationInvitations: harness.listPendingOrganizationInvitations,
  }
})

import type { TenantRole } from '@pathfinder/auth'
import { router } from './core'
import type { TRPCContext } from './context'
import { analyticsRouter } from './routers/analytics'
import { contentHistoryRouter } from './routers/content-history'
import { engagementQuestionRouter } from './routers/engagement-question'
import { intakeRouter } from './routers/intake'
import { knowledgeRouter } from './routers/knowledge'
import { operationalUpdateRouter } from './routers/operational-update'
import { placeRouter } from './routers/place'
import { portalRouter } from './routers/portal'
import { supportRouter } from './routers/support'
import { tenantRouter } from './routers/tenant'
import { venueRouter } from './routers/venue'
import { venuePackageRouter } from './routers/venue-package'
import cases from './testing/tenant-procedure-cases.json'

const ATTACKER_TENANT_ID = 'tenant_attacker'

const testRouter = router({
  analytics: analyticsRouter,
  contentHistory: contentHistoryRouter,
  engagementQuestion: engagementQuestionRouter,
  intake: intakeRouter,
  knowledge: knowledgeRouter,
  operationalUpdate: operationalUpdateRouter,
  place: placeRouter,
  portal: portalRouter,
  support: supportRouter,
  tenant: tenantRouter,
  venue: venueRouter,
  venuePackage: venuePackageRouter,
})

type ProcedureCase = {
  path: string
  kind: 'query' | 'mutation'
  minimumRole: TenantRole
  firstTouch: string
  input: unknown
}

function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$futureMinutes === 'number') {
      return new Date(Date.now() + record.$futureMinutes * 60_000)
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, materialize(item)]))
  }
  return value
}

function authoritativeTenant(touch: {
  kind: 'db-touch' | 'external-touch'
  path: string
  args: unknown[]
}): unknown {
  if (touch.path === 'external.inviteOrganizationMember') {
    return (touch.args[0] as { organizationId?: unknown } | undefined)?.organizationId
  }
  if (touch.path === 'external.listPendingOrganizationInvitations') return touch.args[0]

  const operation = touch.args[0] as
    | { where?: { id?: unknown; tenantId?: unknown }; data?: { tenantId?: unknown } }
    | undefined
  if (touch.path.startsWith('tenant.')) return operation?.where?.id
  return operation?.where?.tenantId ?? operation?.data?.tenantId
}

function context(role: TenantRole): TRPCContext {
  return {
    db: harness.db as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'attacker_user',
      activeTenantId: ATTACKER_TENANT_ID,
      role,
      isPlatformAdmin: false,
    },
  }
}

function clearTouches() {
  harness.dbTouches.length = 0
  harness.externalTouches.length = 0
}

async function invoke(entry: ProcedureCase, role: TenantRole): Promise<unknown> {
  const [routerName, procedureName] = entry.path.split('.')
  if (!routerName || !procedureName) throw new Error(`Malformed procedure path: ${entry.path}`)

  const caller = testRouter.createCaller(context(role)) as unknown as Record<
    string,
    Record<string, (input?: unknown) => Promise<unknown>>
  >
  const procedure = caller[routerName]?.[procedureName]
  if (!procedure) throw new Error(`Procedure is not callable: ${entry.path}`)
  const input = materialize(entry.input)
  return entry.input === null ? procedure() : procedure(input)
}

describe('generated tenant-procedure cross-tenant boundary', () => {
  beforeEach(() => {
    clearTouches()
    vi.clearAllMocks()
  })

  it.each(cases as ProcedureCase[])(
    '$path reaches only attacker-scoped boundaries',
    async (entry) => {
      const belowMinimumRole =
        entry.minimumRole === 'OWNER' ? 'MANAGER' : entry.minimumRole === 'MANAGER' ? 'STAFF' : null
      if (belowMinimumRole) {
        await expect(invoke(entry, belowMinimumRole)).rejects.toMatchObject({ code: 'FORBIDDEN' })
        expect(harness.dbTouches).toHaveLength(0)
        expect(harness.externalTouches).toHaveLength(0)
        clearTouches()
      }

      let thrown: unknown
      try {
        await invoke(entry, entry.minimumRole)
      } catch (error) {
        thrown = error
      }

      const expectedKind = entry.firstTouch.startsWith('external.') ? 'external-touch' : 'db-touch'
      expect((thrown as { cause?: unknown } | undefined)?.cause).toMatchObject({
        kind: expectedKind,
      })

      const touches = expectedKind === 'db-touch' ? harness.dbTouches : harness.externalTouches
      const unexpectedTouches =
        expectedKind === 'db-touch' ? harness.externalTouches : harness.dbTouches
      expect(touches.map((touch) => touch.path)).toContain(entry.firstTouch)
      expect(touches.length).toBeGreaterThan(0)
      expect(unexpectedTouches).toHaveLength(0)
      for (const touch of touches) {
        expect(authoritativeTenant(touch), touch.path).toBe(ATTACKER_TENANT_ID)
      }
    },
  )
})
