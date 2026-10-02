import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  buildOperationalUpdatePreview,
  createOperationalUpdateAction,
  expireOperationalUpdateAction,
  OperationalUpdateActionError,
  scheduleOperationalUpdateAction,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
  type StoredOperatorProposal,
} from '../proposals'
import { venueActor } from './shared'

/**
 * Visitor notices (closures, changed hours, maintenance, events) over the canonical operational
 * update actions, which already keep the version history, the audit row and the cap on overlapping
 * notices. A notice that is live appears in the guide's answers, so the preview says so plainly.
 */

type UpdateState = {
  updateId: string
  venueId: string
  status: string
  isActive: boolean
  startsAt: string
  expiresAt: string
  updatedAt: string
  lifecycle: string
}

async function readUpdate(
  database: OperatorDatabase,
  tenantId: string,
  updateId: string,
  now: Date,
): Promise<UpdateState | null> {
  const row = await database.operationalUpdate.findFirst({
    where: { id: updateId, tenantId },
    select: {
      id: true,
      venueId: true,
      status: true,
      isActive: true,
      startsAt: true,
      expiresAt: true,
      updatedAt: true,
    },
  })
  return row
    ? {
        updateId: row.id,
        venueId: row.venueId,
        status: row.status,
        isActive: row.isActive,
        startsAt: row.startsAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lifecycle: buildOperationalUpdatePreview(row, now).lifecycle,
      }
    : null
}

/** A refusal from the canonical rules means the notice moved or is no longer valid: stale. */
function asStale(error: unknown): never {
  if (error instanceof OperationalUpdateActionError) throw new OperatorStaleError(error.message)
  throw error
}

function outcome(state: UpdateState, replayed: boolean) {
  return {
    result: {
      updateId: state.updateId,
      status: state.status,
      lifecycle: state.lifecycle,
      guestVisibleNow: state.lifecycle === 'LIVE',
      updatedAt: state.updatedAt,
      replayed,
    },
    after: state as unknown as JsonValue,
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const createInput = OPERATOR_MCP_INPUTS['venues.propose_operational_update']
type CreateArgs = ReturnType<typeof createInput.parse>

/** The notice id is derived from the operation, so a retry finds the notice it already made. */
const noticeId = (operationId: string) => `opu-${operationId}`

export const operationalUpdateCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'venues.operational-update',
  tool: 'venues.propose_operational_update',
  capability: 'venues:propose',
  parse: (raw) => createInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context: OperatorKindContext) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    if (args.placeId) {
      const place = await context.database.place.findFirst({
        where: { id: args.placeId, venueId: args.venueId, tenantId: args.tenantId },
        select: { id: true },
      })
      if (!place) throw new OperatorNotFoundError()
    }
  },
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: args.goLive
      ? 'Show this notice to visitors now (it appears in the guide’s answers)'
      : 'Save this notice as a draft (visitors do not see it)',
    lines: [
      `${args.updateType} · ${args.severity} · ${args.priority}`,
      `title: ${args.title}`,
      ...(args.body ? [`details: ${args.body}`] : []),
      ...(args.redirectTo ? [`send visitors to: ${args.redirectTo}`] : []),
      `from ${args.startsAt} to ${args.expiresAt}`,
    ],
  }),
  snapshot: async (args) =>
    ({ venueId: args.venueId, title: args.title, goLive: args.goLive }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const id = noticeId(context.operationId)
    const existing = await readUpdate(context.database, args.tenantId, id, context.now)
    if (existing) return outcome(existing, true)
    try {
      await createOperationalUpdateAction(
        {
          tenantId: args.tenantId,
          actor: venueActor(context.actor, 'MANAGER'),
          id,
          schedule: args.goLive,
          now: context.now,
          fields: {
            venueId: args.venueId,
            placeId: args.placeId ?? null,
            updateType: args.updateType,
            severity: args.severity,
            priority: args.priority,
            title: args.title,
            body: args.body ?? null,
            redirectTo: args.redirectTo ?? null,
            startsAt: new Date(args.startsAt),
            expiresAt: new Date(args.expiresAt),
          },
        },
        context.database,
      )
    } catch (error) {
      asStale(error)
    }
    return outcome((await readUpdate(context.database, args.tenantId, id, context.now))!, false)
  },
  /** The notice id carries the operation, so its presence proves the create committed. */
  reconcile: async (args, context) => {
    const state = await readUpdate(
      context.database,
      args.tenantId,
      noticeId(context.operationId),
      context.now,
    )
    return state ? { state: 'applied', outcome: outcome(state, false) } : { state: 'not_applied' }
  },
  /** A live notice is ended; a draft stays a draft (notices are kept, never removed). */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const after = original.afterSnapshot as UpdateState | null
    if (!after?.updateId || !original.targetTenantId) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    const current = await readUpdate(
      context.database,
      original.targetTenantId,
      after.updateId,
      context.now,
    )
    if (!current) throw new OperatorNotFoundError()
    if (current.updatedAt !== after.updatedAt) {
      throw new OperatorStaleError('The notice changed after it was created.')
    }
    if (current.isActive && current.status === 'PUBLISHED') {
      try {
        await expireOperationalUpdateAction(
          {
            tenantId: original.targetTenantId,
            actor: venueActor(context.actor, 'MANAGER'),
            id: after.updateId,
            expectedUpdatedAt: new Date(after.updatedAt),
            now: context.now,
          },
          context.database,
        )
      } catch (error) {
        asStale(error)
      }
    }
    return outcome(
      (await readUpdate(context.database, original.targetTenantId, after.updateId, context.now))!,
      false,
    )
  },
}

// ---------------------------------------------------------------------------
// schedule (go live) and end, both bound to the version the human saw
// ---------------------------------------------------------------------------

type ExistingArgs = Readonly<{
  tenantId: string
  venueId: string
  updateId: string
  expectedUpdatedAt: string
}>

function existingKind<Args extends ExistingArgs>(spec: {
  kind: string
  tool: OperatorProposalKind<Args>['tool']
  parse: (raw: unknown) => Args
  title: string
  run: (args: Args, context: OperatorApplyContext) => Promise<unknown>
}): OperatorProposalKind<Args> {
  return {
    kind: spec.kind,
    tool: spec.tool,
    capability: 'venues:propose',
    parse: spec.parse,
    target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
    authorize: async (args, context: OperatorKindContext) => {
      await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
      const current = await readUpdate(context.database, args.tenantId, args.updateId, context.now)
      if (!current || current.venueId !== args.venueId) throw new OperatorNotFoundError()
    },
    targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
    currentVersion: async (args, context) =>
      (await readUpdate(context.database, args.tenantId, args.updateId, context.now))?.updatedAt ??
      null,
    describe: (args) => ({ title: spec.title, lines: [`notice ${args.updateId}`] }),
    snapshot: async (args, context) =>
      (await readUpdate(
        context.database,
        args.tenantId,
        args.updateId,
        context.now,
      )) as unknown as JsonValue,
    apply: async (args, context) => {
      try {
        await spec.run(args, context)
      } catch (error) {
        asStale(error)
      }
      return outcome(
        (await readUpdate(context.database, args.tenantId, args.updateId, context.now))!,
        false,
      )
    },
    /** Untouched since the human saw it means nothing was written; anything else needs a person. */
    reconcile: async (args, context) => {
      const current = await readUpdate(context.database, args.tenantId, args.updateId, context.now)
      if (!current) return { state: 'unknown' }
      return current.updatedAt === new Date(args.expectedUpdatedAt).toISOString()
        ? { state: 'not_applied' }
        : { state: 'unknown' }
    },
  }
}

const scheduleInput = OPERATOR_MCP_INPUTS['venues.propose_operational_update_schedule']
export const operationalUpdateScheduleKind = existingKind({
  kind: 'venues.operational-update-schedule',
  tool: 'venues.propose_operational_update_schedule',
  parse: (raw) => scheduleInput.parse(raw),
  title: 'Show this saved notice to visitors (it appears in the guide’s answers)',
  run: (args, context) =>
    scheduleOperationalUpdateAction(
      {
        tenantId: args.tenantId,
        actor: venueActor(context.actor, 'MANAGER'),
        id: args.updateId,
        expectedUpdatedAt: new Date(args.expectedUpdatedAt),
        now: context.now,
      },
      context.database,
    ),
})

const endInput = OPERATOR_MCP_INPUTS['venues.propose_operational_update_end']
export const operationalUpdateEndKind = existingKind({
  kind: 'venues.operational-update-end',
  tool: 'venues.propose_operational_update_end',
  parse: (raw) => endInput.parse(raw),
  title: 'End this notice now (visitors stop seeing it; the notice is kept)',
  run: (args, context) =>
    expireOperationalUpdateAction(
      {
        tenantId: args.tenantId,
        actor: venueActor(context.actor, 'MANAGER'),
        id: args.updateId,
        expectedUpdatedAt: new Date(args.expectedUpdatedAt),
        now: context.now,
      },
      context.database,
    ),
})

export const OPERATIONAL_UPDATE_KINDS = [
  operationalUpdateCreateKind,
  operationalUpdateScheduleKind,
  operationalUpdateEndKind,
]
