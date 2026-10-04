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
  'customers.create',
  // Switches off a whole customer's access and schedules; a person decides each time.
  'offboarding.execution',
  'operator.revert',
  // Hides an account from every list and view; a person decides each time.
  'crm.account-archive',
  // Changes how history is read across two accounts; an exact reviewed decision each time.
  'crm.duplicate-resolution',
  'crm.organization-merge',
  // Changes who is emailed for a person.
  'crm.contact-address-change',
  // Every human gate on outbound mail: policy never stands in for the person.
  'crm.draft-review',
  'crm.batch-stage',
  'crm.batch-approve',
  'crm.batch-release',
  // Both speak to the customer in their portal.
  'support.information-request',
  'support.completion',
  'customers.onboarding-questions',
  // Generation spends model budget, publishing shows a report to the customer, and an enabled
  // routine runs on its own and may message people or spend money.
  'reports.generate',
  'reports.publish',
  'routines.enable',
  // A new customer conversation and a customer-visible reply: a person decides each time.
  'support.create-request',
  'support.client-reply',
  // Starts outbound requests to an outside website, and edits what guests may be told.
  'venues.source',
  'venues.source-connection',
  'venues.content-changeset',
])

/** Capabilities whose policy switch is locked to `ask` (they only carry always-ask kinds). */
export const OPERATOR_LOCKED_CAPABILITIES: ReadonlySet<OperatorCapability> = new Set([
  'customers:propose',
  // Both report kinds are always-ask, so the capability has no ask-optional kind to switch.
  'reports:propose',
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
 * The kinds that existed when AUTO switches were capability-wide. A stored AUTO row that names no
 * kinds keeps covering exactly these and nothing newer, so shipping a new action never inherits an
 * old broad switch: it asks until an owner turns it on by name.
 */
export const OPERATOR_LEGACY_AUTO_KINDS: ReadonlySet<string> = new Set([
  'appearance.update',
  'crm.outreach-draft',
  'crm.stage-change',
  'crm.outreach-log',
  'venues.create',
  'venues.knowledge',
  'venues.publish',
])

/**
 * Ordinary, locally validated writes a newly connected operator may apply without another
 * dashboard decision. This list is deliberately exact: new kinds and external effects still ask.
 * A stored policy row, including ASK, always takes precedence over this default.
 */
export const OPERATOR_ROUTINE_AUTO_KINDS: ReadonlySet<string> = new Set([
  'appearance.update',
  'crm.prospect-create',
  'crm.account-update',
  'crm.contact-create',
  'crm.contact-update',
  'crm.followup-update',
  'crm.note',
  'crm.stage-change',
  'crm.outreach-draft',
  'crm.outreach-log',
  'crm.import-commit',
  'crm.campaign-create',
  'crm.campaign-membership',
  'venues.create',
  'support.internal-note',
])

function routineKindsForCapability(capability: OperatorCapability): string[] {
  if (capability === 'appearance:propose') return ['appearance.update']
  if (capability === 'crm:propose') {
    return [...OPERATOR_ROUTINE_AUTO_KINDS].filter(
      (kind) => kind.startsWith('crm.') && kind !== 'crm.outreach-log',
    )
  }
  if (capability === 'crm:log') return ['crm.outreach-log']
  if (capability === 'venues:propose') return ['venues.create']
  if (capability === 'support:propose') return ['support.internal-note']
  return []
}

/** The kinds an AUTO row covers: the ones it names, or the legacy set when it names none. */
export function effectiveAutoKinds(row: Readonly<{ allowedKinds: readonly string[] }>): string[] {
  return row.allowedKinds.length > 0 ? [...row.allowedKinds] : [...OPERATOR_LEGACY_AUTO_KINDS]
}

/** Increments and returns the policy revision. Call inside the transaction that changes policy. */
async function bumpPolicyRevision(database: OperatorDatabase): Promise<number> {
  const state = await database.operatorPolicyState.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', revision: 1 },
    update: { revision: { increment: 1 } },
    select: { revision: true },
  })
  return state.revision
}

export async function readPolicyRevision(database: OperatorDatabase = db): Promise<number> {
  const state = await database.operatorPolicyState.findUnique({
    where: { id: 'singleton' },
    select: { revision: true },
  })
  return state?.revision ?? 0
}

/**
 * Decides who approves a proposal. Missing rows auto-apply only the exact routine list. An always-ask kind or locked
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
    select: { mode: true, allowedKinds: true },
  })
  if (!row)
    return routineKindsForCapability(proposal.capability).includes(proposal.kind) ? 'auto' : 'ask'
  // AUTO covers this kind only if the switch is on and names it (or is a legacy switch and the
  // kind is a legacy kind). A kind added later is never covered by an older switch.
  return row?.mode === 'AUTO' && effectiveAutoKinds(row).includes(proposal.kind) ? 'auto' : 'ask'
}

/** Read-only view for `operator.get_autonomy`. */
export async function readAutonomyPolicies(database: OperatorDatabase = db) {
  const rows = await database.operatorAutonomyPolicy.findMany({
    select: { capability: true, mode: true, allowedKinds: true },
  })
  const stored = new Map(rows.map((row) => [row.capability, row]))
  return OPERATOR_POLICY_CAPABILITIES.map((capability) => {
    const locked = OPERATOR_LOCKED_CAPABILITIES.has(capability)
    const row = stored.get(capability)
    const autoKinds = locked
      ? []
      : row
        ? row.mode === 'AUTO'
          ? effectiveAutoKinds(row).filter((kind) => !isAlwaysAskKind(kind))
          : []
        : routineKindsForCapability(capability)
    const auto = autoKinds.length > 0
    return {
      capability,
      mode: (auto ? 'auto' : 'ask') as OperatorAutonomyMode,
      locked,
      // Which actions the switch actually covers; empty whenever the capability asks.
      autoKinds: autoKinds.sort(),
    }
  })
}

export class OperatorAutonomyLockedError extends Error {
  readonly code = 'AUTONOMY_LOCKED'
}

export type AutonomyChange = Readonly<{
  capability: OperatorCapability
  mode: OperatorAutonomyMode
  /** Kinds an AUTO switch covers. Omitted means every kind the server implements for it today. */
  kinds?: readonly string[]
}>

/**
 * Dashboard-only. There is deliberately no MCP tool that reaches this function; callers must have
 * verified a platform-admin session, the operator allowlist and a strict reverification.
 *
 * The whole batch is validated before anything is written and applied in one transaction with one
 * revision bump, so a policy is never half-changed and every change has a revision to cite.
 */
export async function setAutonomyPolicies(
  input: Readonly<{ changes: readonly AutonomyChange[]; userId: string; requestId: string }>,
  database: OperatorDatabase = db,
): Promise<{ revision: number }> {
  // Loaded here, not at module top: the kinds import proposals, which imports this module.
  const { OPERATOR_PROPOSAL_KINDS } = await import('./kinds')
  const implementedByCapability = new Map<string, string[]>()
  for (const kind of OPERATOR_PROPOSAL_KINDS) {
    implementedByCapability.set(kind.capability, [
      ...(implementedByCapability.get(kind.capability) ?? []),
      kind.kind,
    ])
  }
  const prepared = input.changes.map((change) => {
    if (!OPERATOR_POLICY_CAPABILITIES.includes(change.capability)) {
      throw new OperatorAutonomyLockedError('Read capabilities have no autonomy switch')
    }
    if (change.mode === 'auto' && OPERATOR_LOCKED_CAPABILITIES.has(change.capability)) {
      throw new OperatorAutonomyLockedError('This capability always asks')
    }
    const implemented = implementedByCapability.get(change.capability) ?? []
    // Left unnamed, an AUTO switch covers every implemented kind that is allowed to be automatic.
    // An always-ask kind is only ever refused when someone names it explicitly.
    const requested = change.kinds ?? implemented.filter((kind) => !isAlwaysAskKind(kind))
    const unknown = requested.filter((kind) => !implemented.includes(kind))
    const alwaysAsk = requested.filter(isAlwaysAskKind)
    if (change.mode === 'auto' && (unknown.length > 0 || alwaysAsk.length > 0)) {
      throw new OperatorAutonomyLockedError('Only implemented, ask-optional kinds can be automatic')
    }
    const allowedKinds =
      change.mode === 'auto' ? [...new Set(requested.filter((kind) => !isAlwaysAskKind(kind)))] : []
    return {
      capability: change.capability,
      mode: change.mode === 'auto' ? ('AUTO' as const) : ('ASK' as const),
      allowedKinds,
    }
  })
  return database.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as OperatorDatabase
    for (const change of prepared) {
      await tx.operatorAutonomyPolicy.upsert({
        where: { capability: change.capability },
        create: {
          capability: change.capability,
          mode: change.mode,
          allowedKinds: change.allowedKinds,
          updatedByUserId: input.userId,
        },
        update: {
          mode: change.mode,
          allowedKinds: change.allowedKinds,
          updatedByUserId: input.userId,
        },
      })
    }
    const revision = await bumpPolicyRevision(tx)
    for (const change of prepared) {
      await writeOperatorAudit(
        {
          requestId: input.requestId,
          eventType: 'autonomy.change',
          outcome: change.mode,
          actorUserId: input.userId,
          args: {
            capability: change.capability,
            kinds: change.allowedKinds,
            policyRevision: revision,
          },
        },
        tx,
      )
    }
    return { revision }
  })
}

/** One switch. Kept for callers that change a single capability; it is a batch of one. */
export async function setAutonomyPolicy(
  input: Readonly<{
    capability: OperatorCapability
    mode: OperatorAutonomyMode
    userId: string
    requestId: string
    kinds?: readonly string[]
  }>,
  database: OperatorDatabase = db,
): Promise<void> {
  await setAutonomyPolicies(
    {
      changes: [
        {
          capability: input.capability,
          mode: input.mode,
          ...(input.kinds ? { kinds: input.kinds } : {}),
        },
      ],
      userId: input.userId,
      requestId: input.requestId,
    },
    database,
  )
}
