import { db } from '@pathfinder/db'

import { redactOperatorArgs, type OperatorDatabase } from './audit'
import { createOperatorRegistry } from './registry'
import type { OperatorKindRegistry } from './proposals'

/**
 * Read-only queries behind the /admin/operator page and the /approve/[id] page. Nothing in this
 * file writes. Every state change goes through a guarded route handler that calls the services in
 * proposals.ts, plans.ts, autonomy.ts and oauth.ts.
 */

const MAX_VALUE_CHARS = 300
const LIST_LIMIT = 50

// ---------------------------------------------------------------------------
// Review model (Inbox and the one-tap page)
// ---------------------------------------------------------------------------

export type OperatorFieldChange = { field: string; before: string; after: string }

export type OperatorReviewStep = {
  index: number
  proposalId: string
  tool: string
  status: string
  title: string
  /** What the request will do, from the proposal kind. */
  lines: string[]
  tenantName: string | null
  venueName: string | null
  /**
   * `applied`: before → after recorded when the change was applied. `restore`: what an undo will
   * put back (now → restored). `pending`: the server-computed difference a still-pending proposal
   * of a kind that can compute one would make (current → proposed). Other pending changes have no
   * snapshot yet; the lines describe them and the target's version is checked again at approval.
   */
  changeMode: 'applied' | 'restore' | 'pending' | null
  changes: OperatorFieldChange[]
  args: string
  failureCode: string | null
}

export type OperatorReviewItem = {
  id: string
  type: 'proposal' | 'plan'
  title: string
  status: string
  /** The hash the approval POST must carry back. */
  argsHash: string
  clientName: string
  createdAt: Date
  expiresAt: Date
  steps: OperatorReviewStep[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return 'none'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
}

const IGNORED_SNAPSHOT_FIELDS = new Set(['updatedAt', 'venueId', 'tenantId'])

/** Field-by-field difference between two flat snapshots; identity and version fields are hidden. */
export function diffSnapshots(before: unknown, after: unknown): OperatorFieldChange[] {
  if (!isRecord(before) || !isRecord(after)) return []
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return fields
    .filter(
      (field) =>
        !IGNORED_SNAPSHOT_FIELDS.has(field) &&
        JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
    )
    .map((field) => ({ field, before: showValue(before[field]), after: showValue(after[field]) }))
}

function describeStep(kinds: OperatorKindRegistry, tool: string, args: unknown) {
  const kind = kinds.get(tool)
  if (!kind) return { title: tool, lines: [] as string[] }
  try {
    const described = kind.describe(kind.parse(args))
    return { title: described.title, lines: [...described.lines] }
  } catch {
    // Steps that reference earlier results cannot be parsed yet; the exact arguments still show.
    return { title: tool, lines: [] as string[] }
  }
}

/**
 * The exact arguments are shown in full, never truncated: the approval binds the stored argsHash,
 * so the human must be able to read everything that will be applied. Inputs are bounded by the
 * contract (at most 50 knowledge entries of 4,000 characters per step).
 */
function boundedArgs(args: unknown) {
  return JSON.stringify(args, null, 2) ?? 'null'
}

type TargetRef = { tenantId: string | null; venueId: string | null }

/** Names by ID. Tenants are platform rows; venues are always looked up under their tenant. */
async function resolveNames(database: OperatorDatabase, targets: readonly TargetRef[]) {
  const tenantIds = [...new Set(targets.flatMap((t) => (t.tenantId ? [t.tenantId] : [])))]
  const tenantNames = new Map<string, string>()
  const venueNames = new Map<string, string>()
  if (tenantIds.length === 0) return { tenantNames, venueNames }
  const tenants = await database.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, name: true },
  })
  for (const tenant of tenants) tenantNames.set(tenant.id, tenant.name)
  for (const tenantId of tenantIds) {
    const venueIds = [
      ...new Set(targets.flatMap((t) => (t.tenantId === tenantId && t.venueId ? [t.venueId] : []))),
    ]
    if (venueIds.length === 0) continue
    const venues = await database.venue.findMany({
      where: { tenantId, id: { in: venueIds } },
      select: { id: true, name: true },
    })
    for (const venue of venues) venueNames.set(`${tenantId}:${venue.id}`, venue.name)
  }
  return { tenantNames, venueNames }
}

type ProposalRow = NonNullable<
  Awaited<ReturnType<OperatorDatabase['operatorProposal']['findUnique']>>
>

async function buildSteps(
  rows: readonly ProposalRow[],
  kinds: OperatorKindRegistry,
  database: OperatorDatabase,
): Promise<OperatorReviewStep[]> {
  const revertIds = rows.flatMap((row) => (row.revertOfId ? [row.revertOfId] : []))
  const originals = revertIds.length
    ? await database.operatorProposal.findMany({ where: { id: { in: revertIds } } })
    : []
  const originalById = new Map(originals.map((row) => [row.id, row]))
  const { tenantNames, venueNames } = await resolveNames(
    database,
    rows.map((row) => ({ tenantId: row.targetTenantId, venueId: row.targetVenueId })),
  )
  return Promise.all(
    rows.map(async (row) => {
      const original = row.revertOfId ? originalById.get(row.revertOfId) : undefined
      let title: string
      let lines: string[]
      let changeMode: OperatorReviewStep['changeMode'] = null
      let changes: OperatorFieldChange[] = []
      if (row.kind === 'operator.revert') {
        const undone = original ? describeStep(kinds, original.tool, original.args) : null
        title = undone ? `Undo: ${undone.title}` : 'Undo an applied change'
        lines = ['Restores the values from before the original change was applied.']
        if (original) {
          // The original's beforeSnapshot is what comes back; its afterSnapshot is what is live now.
          changeMode = 'restore'
          changes = diffSnapshots(original.afterSnapshot, original.beforeSnapshot)
        }
      } else {
        const described = describeStep(kinds, row.tool, row.args)
        title = described.title
        lines = described.lines
        if (row.beforeSnapshot !== null && row.afterSnapshot !== null) {
          changeMode = 'applied'
          changes = diffSnapshots(row.beforeSnapshot, row.afterSnapshot)
        } else if (row.status === 'PENDING') {
          const kind = kinds.get(row.tool)
          if (kind?.pendingChanges) {
            try {
              const computed = await kind.pendingChanges(kind.parse(row.args), database)
              if (computed.length > 0) {
                changeMode = 'pending'
                changes = computed.map((entry) => ({ ...entry }))
              }
            } catch {
              // The exact arguments still show in full; the diff is a convenience, never a gate.
            }
          }
        }
      }
      return {
        index: row.planStepIndex ?? 0,
        proposalId: row.id,
        tool: row.tool,
        status: row.status,
        title,
        lines,
        tenantName: row.targetTenantId ? (tenantNames.get(row.targetTenantId) ?? null) : null,
        venueName:
          row.targetTenantId && row.targetVenueId
            ? (venueNames.get(`${row.targetTenantId}:${row.targetVenueId}`) ?? null)
            : null,
        changeMode,
        changes,
        args: boundedArgs(row.args),
        failureCode: row.failureCode,
      }
    }),
  )
}

async function clientNames(database: OperatorDatabase, clientIds: readonly string[]) {
  const ids = [...new Set(clientIds)]
  const rows = ids.length
    ? await database.operatorOAuthClient.findMany({
        where: { id: { in: ids } },
        select: { id: true, clientName: true },
      })
    : []
  return new Map(rows.map((row) => [row.id, row.clientName]))
}

/** One proposal or plan by ID, or null. A plan step is reviewed through its plan. */
export async function loadOperatorReview(
  id: string,
  database: OperatorDatabase = db,
  kinds: OperatorKindRegistry = createOperatorRegistry().kinds,
): Promise<OperatorReviewItem | null> {
  const plan = await database.operatorPlan.findUnique({ where: { id } })
  if (plan) {
    const rows = await database.operatorProposal.findMany({
      where: { planId: plan.id },
      orderBy: { planStepIndex: 'asc' },
    })
    const names = await clientNames(database, [plan.clientId])
    return {
      id: plan.id,
      type: 'plan',
      title: plan.title,
      status: plan.status,
      argsHash: plan.argsHash,
      clientName: names.get(plan.clientId) ?? 'Unknown app',
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      steps: await buildSteps(rows, kinds, database),
    }
  }
  const row = await database.operatorProposal.findUnique({ where: { id } })
  if (!row || row.planId !== null) return null
  const steps = await buildSteps([row], kinds, database)
  const names = await clientNames(database, [row.clientId])
  return {
    id: row.id,
    type: 'proposal',
    title: steps[0]?.title ?? row.tool,
    status: row.status,
    argsHash: row.argsHash,
    clientName: names.get(row.clientId) ?? 'Unknown app',
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    steps,
  }
}

/** Pending, unexpired proposals and plans, oldest first, with the full change. */
export async function listOperatorInbox(
  now: Date,
  database: OperatorDatabase = db,
  kinds: OperatorKindRegistry = createOperatorRegistry().kinds,
): Promise<OperatorReviewItem[]> {
  const [plans, proposals] = await Promise.all([
    database.operatorPlan.findMany({
      where: { status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
      take: LIST_LIMIT,
      select: { id: true },
    }),
    database.operatorProposal.findMany({
      where: { status: 'PENDING', planId: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
      take: LIST_LIMIT,
      select: { id: true },
    }),
  ])
  const items = await Promise.all(
    [...plans, ...proposals].map((row) => loadOperatorReview(row.id, database, kinds)),
  )
  return items
    .filter((item): item is OperatorReviewItem => item !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export type OperatorConnectionView = {
  grantId: string
  clientName: string
  redirectHosts: string[]
  lastUsedAt: Date | null
  createdAt: Date
  expiresAt: Date
  revokedAt: Date | null
  revokeReason: string | null
  status: 'active' | 'expired' | 'revoked'
  scope: string
}

function hostOf(uri: string) {
  try {
    return new URL(uri).host
  } catch {
    return 'invalid address'
  }
}

export async function listOperatorConnections(
  now: Date,
  database: OperatorDatabase = db,
): Promise<OperatorConnectionView[]> {
  const grants = await database.operatorGrant.findMany({
    orderBy: { createdAt: 'desc' },
    take: LIST_LIMIT,
    select: {
      id: true,
      allTenants: true,
      tenantIds: true,
      capabilities: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      revokeReason: true,
      client: { select: { clientName: true, redirectUris: true, lastUsedAt: true } },
    },
  })
  return grants.map((grant) => {
    const lastUsed = [grant.lastUsedAt, grant.client.lastUsedAt]
      .filter((value): value is Date => value !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0]
    return {
      grantId: grant.id,
      clientName: grant.client.clientName,
      redirectHosts: [...new Set(grant.client.redirectUris.map(hostOf))],
      lastUsedAt: lastUsed ?? null,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      revokeReason: grant.revokeReason,
      status: grant.revokedAt ? 'revoked' : grant.expiresAt <= now ? 'expired' : 'active',
      scope: `${grant.allTenants ? 'All clients' : `${grant.tenantIds.length} client(s)`}, ${grant.capabilities.length} capabilities`,
    }
  })
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type OperatorAuditFilters = {
  eventType?: string | undefined
  outcome?: string | undefined
  tool?: string | undefined
  days?: number | undefined
}

export type OperatorAuditRow = {
  id: string
  occurredAt: Date
  eventType: string
  outcome: string
  tool: string | null
  clientName: string | null
  tenantName: string | null
  venueName: string | null
  proposalId: string | null
  planId: string | null
  latencyMs: number | null
  redactedArgs: string | null
}

/** Audit rows, newest first. Arguments are redacted again on the way out; nothing else is read. */
export async function listOperatorAudit(
  filters: OperatorAuditFilters,
  now: Date,
  database: OperatorDatabase = db,
): Promise<OperatorAuditRow[]> {
  const since = filters.days ? new Date(now.getTime() - filters.days * 86_400_000) : undefined
  const rows = await database.operatorAuditEvent.findMany({
    where: {
      ...(filters.eventType ? { eventType: filters.eventType } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      ...(filters.tool ? { tool: filters.tool } : {}),
      ...(since ? { occurredAt: { gte: since } } : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: 100,
    select: {
      id: true,
      occurredAt: true,
      eventType: true,
      outcome: true,
      tool: true,
      clientId: true,
      targetTenantId: true,
      targetVenueId: true,
      proposalId: true,
      planId: true,
      latencyMs: true,
      redactedArgs: true,
    },
  })
  const [clients, names] = await Promise.all([
    clientNames(
      database,
      rows.flatMap((row) => (row.clientId ? [row.clientId] : [])),
    ),
    resolveNames(
      database,
      rows.map((row) => ({ tenantId: row.targetTenantId, venueId: row.targetVenueId })),
    ),
  ])
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt,
    eventType: row.eventType,
    outcome: row.outcome,
    tool: row.tool,
    clientName: row.clientId ? (clients.get(row.clientId) ?? row.clientId) : null,
    tenantName: row.targetTenantId ? (names.tenantNames.get(row.targetTenantId) ?? null) : null,
    venueName:
      row.targetTenantId && row.targetVenueId
        ? (names.venueNames.get(`${row.targetTenantId}:${row.targetVenueId}`) ?? null)
        : null,
    proposalId: row.proposalId,
    planId: row.planId,
    latencyMs: row.latencyMs,
    redactedArgs:
      row.redactedArgs === null
        ? null
        : boundedArgs(redactOperatorArgs(row.redactedArgs)).slice(0, 2_000),
  }))
}
