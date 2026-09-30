import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db } from '@pathfinder/db'

import { writeOperatorAudit, type OperatorDatabase } from './audit'

export type OperatorAutonomyMode = 'ask' | 'auto'

/**
 * Hard-coded, never configurable: these kinds wait for a human even in "go ham" mode. They grant a
 * person access, undo live changes, or bundle other kinds. Billing, deletion and policy changes
 * have no operator tool at all.
 */
export const OPERATOR_ALWAYS_ASK_KINDS: ReadonlySet<string> = new Set([
  'customers.invite',
  'operator.revert',
])

/** Capabilities whose policy switch is locked to `ask` (they only carry always-ask kinds). */
export const OPERATOR_LOCKED_CAPABILITIES: ReadonlySet<OperatorCapability> = new Set([
  'customers:propose',
  'operator:revert',
  // A plan's autonomy is derived from its steps; it has no switch of its own.
  'operator:plan',
])

/** Capabilities that carry write proposals and therefore have a policy switch. */
export const OPERATOR_POLICY_CAPABILITIES: readonly OperatorCapability[] =
  OperatorCapability.options.filter(
    (capability) => !capability.endsWith(':read'),
  ) as OperatorCapability[]

export function isAlwaysAskKind(kind: string): boolean {
  return OPERATOR_ALWAYS_ASK_KINDS.has(kind)
}

/**
 * Decides who approves a proposal. Missing rows mean `ask`. An always-ask kind or locked
 * capability is `ask` whatever the stored row says, so a bad row cannot widen autonomy.
 */
export async function resolveAutonomy(
  proposal: Readonly<{ kind: string; capability: OperatorCapability }>,
  database: OperatorDatabase = db,
): Promise<OperatorAutonomyMode> {
  if (isAlwaysAskKind(proposal.kind) || OPERATOR_LOCKED_CAPABILITIES.has(proposal.capability)) {
    return 'ask'
  }
  const row = await database.operatorAutonomyPolicy.findUnique({
    where: { capability: proposal.capability },
    select: { mode: true },
  })
  return row?.mode === 'AUTO' ? 'auto' : 'ask'
}

/** Read-only view for `operator.get_autonomy`. */
export async function readAutonomyPolicies(database: OperatorDatabase = db) {
  const rows = await database.operatorAutonomyPolicy.findMany({
    select: { capability: true, mode: true },
  })
  const stored = new Map(rows.map((row) => [row.capability, row.mode]))
  return OPERATOR_POLICY_CAPABILITIES.map((capability) => {
    const locked = OPERATOR_LOCKED_CAPABILITIES.has(capability)
    return {
      capability,
      mode: (!locked && stored.get(capability) === 'AUTO' ? 'auto' : 'ask') as OperatorAutonomyMode,
      locked,
    }
  })
}

export class OperatorAutonomyLockedError extends Error {
  readonly code = 'AUTONOMY_LOCKED'
}

/**
 * Dashboard-only. There is deliberately no MCP tool that reaches this function; callers must have
 * verified a platform-admin session, the operator allowlist and a strict reverification.
 */
export async function setAutonomyPolicy(
  input: Readonly<{
    capability: OperatorCapability
    mode: OperatorAutonomyMode
    userId: string
    requestId: string
  }>,
  database: OperatorDatabase = db,
): Promise<void> {
  if (!OPERATOR_POLICY_CAPABILITIES.includes(input.capability)) {
    throw new OperatorAutonomyLockedError('Read capabilities have no autonomy switch')
  }
  if (input.mode === 'auto' && OPERATOR_LOCKED_CAPABILITIES.has(input.capability)) {
    throw new OperatorAutonomyLockedError('This capability always asks')
  }
  const mode = input.mode === 'auto' ? 'AUTO' : 'ASK'
  await database.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as OperatorDatabase
    await tx.operatorAutonomyPolicy.upsert({
      where: { capability: input.capability },
      create: { capability: input.capability, mode, updatedByUserId: input.userId },
      update: { mode, updatedByUserId: input.userId },
    })
    await writeOperatorAudit(
      {
        requestId: input.requestId,
        eventType: 'autonomy.change',
        outcome: mode,
        actorUserId: input.userId,
        args: { capability: input.capability },
      },
      tx,
    )
  })
}
