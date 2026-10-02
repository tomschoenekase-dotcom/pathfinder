import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import type { RoutineStopRules } from '@pathfinder/contracts'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  AgentRoutineActionError,
  createAgentRoutineAction,
  setAgentRoutineEnabledAction,
  updateAgentRoutineDefinitionAction,
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

type RoutineState = {
  routineId: string
  venueId: string
  routineKey: string
  enabled: boolean
  intervalSeconds: number
  maxRunsPerDay: number
  agentEnabled: boolean
  updatedAt: string
}

async function readRoutine(
  database: OperatorDatabase,
  where: { tenantId: string; venueId: string } & ({ id: string } | { routineKey: string }),
): Promise<RoutineState | null> {
  const row = await database.agentRoutine.findFirst({
    where,
    select: {
      id: true,
      venueId: true,
      routineKey: true,
      enabled: true,
      intervalSeconds: true,
      maxRunsPerDay: true,
      updatedAt: true,
      agentIdentity: { select: { enabled: true } },
    },
  })
  return row
    ? {
        routineId: row.id,
        venueId: row.venueId,
        routineKey: row.routineKey,
        enabled: row.enabled,
        intervalSeconds: row.intervalSeconds,
        maxRunsPerDay: row.maxRunsPerDay,
        agentEnabled: row.agentIdentity.enabled,
        updatedAt: row.updatedAt.toISOString(),
      }
    : null
}

const byId = (tenantId: string, venueId: string, id: string) => ({ tenantId, venueId, id })

/**
 * A stop-rule subject must exist where the routine lives, so a typo cannot create a reminder that
 * stops itself immediately (or never). Support requests are tenant and venue scoped. Prospect
 * contacts are platform records with no proven tenant relation, so tenant routines refuse them
 * without even looking the contact up.
 */
async function assertStopSubject(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
  rules: RoutineStopRules | undefined,
) {
  const subject = rules?.subject
  if (!subject) return
  if (subject.kind !== 'SUPPORT_REQUEST') throw new OperatorNotFoundError()
  const found = await database.supportRequest.findFirst({
    where: { id: subject.id, tenantId, venueId },
    select: { id: true },
  })
  if (!found) throw new OperatorNotFoundError()
}

function describeStopRules(rules: RoutineStopRules | undefined): string[] {
  if (!rules) return []
  return [
    ...(rules.subject
      ? [
          `stops when the ${rules.subject.kind.toLowerCase().replace('_', ' ')} is answered, closed or suppressed`,
        ]
      : []),
    ...(rules.maxReminders !== undefined ? [`stops after ${rules.maxReminders} runs`] : []),
    ...(rules.endsAt !== undefined ? [`stops at ${rules.endsAt}`] : []),
  ]
}

function describeBudget(
  budget:
    | { amountCents: number; currency: string; period: string; estimatedRunCostCents: number }
    | null
    | undefined,
): string[] {
  if (budget === undefined) return []
  if (budget === null) return ['removes the dollar budget']
  return [
    `budget ${budget.amountCents} ${budget.currency} cents per ${budget.period.toLowerCase()}, reserving ${budget.estimatedRunCostCents} per run; a run that does not fit is refused (BUDGET_EXCEEDED)`,
  ]
}

function mapRoutineError(error: unknown): never {
  if (error instanceof AgentRoutineActionError) {
    if (error.code === 'NOT_FOUND') throw new OperatorNotFoundError()
    // A moved, taken or out-of-scope definition means the proposal no longer matches the world.
    throw new OperatorStaleError(error.message)
  }
  throw error
}

/** Whether the canonical routine audit row for this operation exists (the commit receipt). */
async function receipt(
  database: OperatorDatabase,
  tenantId: string,
  operationId: string,
  action: string,
): Promise<boolean> {
  const row = await database.auditLog.findFirst({
    where: { tenantId, idempotencyKey: operationId, action },
    select: { id: true },
  })
  return row !== null
}

function outcomeOf(state: RoutineState, extra: Record<string, JsonValue> = {}) {
  return {
    result: {
      routineId: state.routineId,
      enabled: state.enabled,
      intervalSeconds: state.intervalSeconds,
      maxRunsPerDay: state.maxRunsPerDay,
      updatedAt: state.updatedAt,
      ...extra,
    },
    after: state as unknown as JsonValue,
  }
}

// ---------------------------------------------------------------------------
// create (always disabled)
// ---------------------------------------------------------------------------

const createInput = OPERATOR_MCP_INPUTS['routines.propose_create']
type CreateArgs = ReturnType<typeof createInput.parse>

export const routinesCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'routines.create',
  tool: 'routines.propose_create',
  capability: 'routines:propose',
  parse: (raw) => createInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context: OperatorKindContext) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    const identity = await context.database.agentIdentity.findFirst({
      where: {
        id: args.agentIdentityId,
        tenantId: args.tenantId,
        OR: [{ venueId: args.venueId }, { venueId: null, accessScope: 'CLIENT' }],
      },
      select: { id: true },
    })
    if (!identity) throw new OperatorNotFoundError()
    await assertStopSubject(context.database, args.tenantId, args.venueId, args.stopRules)
  },
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: 'Save a routine definition (disabled; it will not run)',
    lines: [
      `key: ${args.routineKey}`,
      `every ${args.intervalSeconds} seconds, at most ${args.maxRunsPerDay} runs a day`,
      `agent identity: ${args.agentIdentityId}`,
      ...describeStopRules(args.stopRules),
      ...describeBudget(args.budget),
      'It is created disabled. Enabling it is a separate decision that always needs a person.',
    ],
  }),
  snapshot: async (args) =>
    ({ venueId: args.venueId, routineKey: args.routineKey, enabled: false }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    let created
    try {
      created = await createAgentRoutineAction(
        {
          operationId: args.operationId,
          tenantId: args.tenantId,
          venueId: args.venueId,
          routineKey: args.routineKey,
          agentIdentityId: args.agentIdentityId,
          prompt: args.prompt,
          requestedOperation: args.requestedOperation,
          intervalSeconds: args.intervalSeconds,
          maxRunsPerDay: args.maxRunsPerDay,
          requiredWorkerRoles: args.requiredWorkerRoles,
          requiredWorkerCapabilities: args.requiredWorkerCapabilities,
          stopRules: args.stopRules,
          budget: args.budget,
        },
        context.actor.id,
        context.database,
      )
    } catch (error) {
      mapRoutineError(error)
    }
    const state = await readRoutine(context.database, {
      tenantId: args.tenantId,
      venueId: args.venueId,
      id: created.routine.id,
    })
    return outcomeOf(state!, { replayed: created.replayed })
  },
  /** The audit row shares the create's transaction, so it proves the definition committed. */
  reconcile: async (args, context) => {
    const committed = await receipt(
      context.database,
      args.tenantId,
      args.operationId,
      'agent-routine.created',
    )
    if (!committed) return { state: 'not_applied' }
    const state = await readRoutine(context.database, {
      tenantId: args.tenantId,
      venueId: args.venueId,
      routineKey: args.routineKey,
    })
    return state
      ? { state: 'applied', outcome: outcomeOf(state, { replayed: true }) }
      : { state: 'unknown' }
  },
}

// ---------------------------------------------------------------------------
// update (disabled routines only)
// ---------------------------------------------------------------------------

type ExistingArgs = Readonly<{
  tenantId: string
  venueId: string
  routineId: string
  operationId: string
  expectedUpdatedAt: string
}>

const updateInput = OPERATOR_MCP_INPUTS['routines.propose_update']
type UpdateArgs = ReturnType<typeof updateInput.parse>

function existing<Args extends ExistingArgs>(
  spec: Pick<OperatorProposalKind<Args>, 'kind' | 'tool' | 'parse' | 'describe' | 'revert'> & {
    receiptAction: string
    run: (args: Args, context: OperatorApplyContext) => Promise<void>
    /** Throws a stale error when the routine is not in a state this change may start from. */
    precondition?: (state: RoutineState) => void
    /** Extra scope checks that need the arguments (for example that a stop subject exists). */
    validate?: (args: Args, context: OperatorKindContext) => Promise<void>
  },
): OperatorProposalKind<Args> {
  return {
    kind: spec.kind,
    tool: spec.tool,
    capability: 'routines:propose',
    parse: spec.parse,
    describe: spec.describe,
    ...(spec.revert ? { revert: spec.revert } : {}),
    target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
    authorize: async (args, context: OperatorKindContext) => {
      await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
      const state = await readRoutine(
        context.database,
        byId(args.tenantId, args.venueId, args.routineId),
      )
      if (!state) throw new OperatorNotFoundError()
      await spec.validate?.(args, context)
    },
    targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
    currentVersion: async (args, context) =>
      (await readRoutine(context.database, byId(args.tenantId, args.venueId, args.routineId)))
        ?.updatedAt ?? null,
    snapshot: async (args, context) =>
      (await readRoutine(
        context.database,
        byId(args.tenantId, args.venueId, args.routineId),
      )) as unknown as JsonValue,
    apply: async (args, context: OperatorApplyContext) => {
      const before = await readRoutine(
        context.database,
        byId(args.tenantId, args.venueId, args.routineId),
      )
      if (!before) throw new OperatorNotFoundError()
      spec.precondition?.(before)
      try {
        await spec.run(args, context)
      } catch (error) {
        mapRoutineError(error)
      }
      const after = await readRoutine(
        context.database,
        byId(args.tenantId, args.venueId, args.routineId),
      )
      return outcomeOf(after!)
    },
    /**
     * The routine audit row is written in the same transaction as the change and keyed by the
     * operation, so it is a real receipt. Untouched at the observed version means not applied.
     */
    reconcile: async (args, context) => {
      const state = await readRoutine(
        context.database,
        byId(args.tenantId, args.venueId, args.routineId),
      )
      if (!state) return { state: 'unknown' }
      if (await receipt(context.database, args.tenantId, args.operationId, spec.receiptAction)) {
        return { state: 'applied', outcome: outcomeOf(state, { replayed: true }) }
      }
      return state.updatedAt === new Date(args.expectedUpdatedAt).toISOString()
        ? { state: 'not_applied' }
        : { state: 'unknown' }
    },
  }
}

export const routinesUpdateKind = existing<UpdateArgs>({
  kind: 'routines.update',
  tool: 'routines.propose_update',
  parse: (raw) => updateInput.parse(raw),
  receiptAction: 'agent-routine.updated',
  describe: (args) => ({
    title: 'Edit a disabled routine (it stays disabled)',
    lines: [
      `routine ${args.routineId}`,
      ...(args.intervalSeconds !== undefined ? [`interval → ${args.intervalSeconds} seconds`] : []),
      ...(args.maxRunsPerDay !== undefined ? [`max runs a day → ${args.maxRunsPerDay}`] : []),
      ...(args.prompt !== undefined ? [`prompt → ${args.prompt.slice(0, 400)}`] : []),
      ...describeStopRules(args.stopRules),
      ...describeBudget(args.budget),
    ],
  }),
  validate: (args, context) =>
    assertStopSubject(context.database, args.tenantId, args.venueId, args.stopRules),
  precondition: (state) => {
    if (state.enabled) throw new OperatorStaleError('Disable the routine before editing it.')
  },
  run: async (args, context) => {
    await updateAgentRoutineDefinitionAction(
      {
        operationId: args.operationId,
        tenantId: args.tenantId,
        venueId: args.venueId,
        routineId: args.routineId,
        expectedUpdatedAt: new Date(args.expectedUpdatedAt),
        ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
        ...(args.intervalSeconds !== undefined ? { intervalSeconds: args.intervalSeconds } : {}),
        ...(args.maxRunsPerDay !== undefined ? { maxRunsPerDay: args.maxRunsPerDay } : {}),
        ...(args.stopRules !== undefined ? { stopRules: args.stopRules } : {}),
        ...(args.budget !== undefined ? { budget: args.budget } : {}),
      },
      context.actor.id,
      context.database,
    )
  },
})

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

const enableInput = OPERATOR_MCP_INPUTS['routines.propose_enable']
type EnableArgs = ReturnType<typeof enableInput.parse>
const disableInput = OPERATOR_MCP_INPUTS['routines.propose_disable']
type DisableArgs = ReturnType<typeof disableInput.parse>

async function setEnabled(
  args: ExistingArgs,
  enabled: boolean,
  context: OperatorApplyContext,
  operationId: string,
) {
  await setAgentRoutineEnabledAction(
    {
      operationId,
      tenantId: args.tenantId,
      venueId: args.venueId,
      routineId: args.routineId,
      enabled,
    },
    context.actor.id,
    { now: context.now, client: context.database },
  )
}

export const routinesEnableKind = existing<EnableArgs>({
  kind: 'routines.enable',
  tool: 'routines.propose_enable',
  parse: (raw) => enableInput.parse(raw),
  receiptAction: 'agent-routine.enabled',
  describe: (args) => ({
    title: 'Enable this routine (the scheduler may start running it)',
    lines: [
      `routine ${args.routineId} at version ${args.expectedUpdatedAt}`,
      'It becomes due now and then runs on its interval, up to its daily limit.',
      'A routine can message people or spend money through its agent identity. A person decides.',
    ],
  }),
  precondition: (state) => {
    if (state.enabled) throw new OperatorStaleError('The routine is already enabled.')
    if (!state.agentEnabled)
      throw new OperatorStaleError('The routine’s agent identity is disabled.')
  },
  run: (args, context) => setEnabled(args, true, context, args.operationId),
  /** Reverting an enable disables the routine, which only ever stops work. */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const after = original.afterSnapshot as RoutineState | null
    if (!after?.routineId || !original.targetTenantId) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    try {
      await setAgentRoutineEnabledAction(
        {
          operationId: context.operationId,
          tenantId: original.targetTenantId,
          venueId: after.venueId,
          routineId: after.routineId,
          enabled: false,
        },
        context.actor.id,
        { now: context.now, client: context.database },
      )
    } catch (error) {
      mapRoutineError(error)
    }
    const now = await readRoutine(
      context.database,
      byId(original.targetTenantId, after.venueId, after.routineId),
    )
    if (!now) throw new OperatorNotFoundError()
    return outcomeOf(now)
  },
})

export const routinesDisableKind = existing<DisableArgs>({
  kind: 'routines.disable',
  tool: 'routines.propose_disable',
  parse: (raw) => disableInput.parse(raw),
  receiptAction: 'agent-routine.disabled',
  describe: (args) => ({
    title: 'Disable this routine (it stops and its next run is cleared)',
    lines: [`routine ${args.routineId} at version ${args.expectedUpdatedAt}`],
  }),
  precondition: (state) => {
    if (!state.enabled) throw new OperatorStaleError('The routine is already disabled.')
  },
  run: (args, context) => setEnabled(args, false, context, args.operationId),
})

export const ROUTINE_KINDS = [
  routinesCreateKind,
  routinesUpdateKind,
  routinesEnableKind,
  routinesDisableKind,
]
