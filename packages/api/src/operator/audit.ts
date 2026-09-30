import { logger } from '@pathfinder/config/logger'
import { db } from '@pathfinder/db'

export type OperatorDatabase = typeof db

export type OperatorAuditEventType =
  | 'mcp.call'
  | 'mcp.denied'
  | 'oauth.register'
  | 'oauth.arm'
  | 'oauth.authorize'
  | 'oauth.token'
  | 'oauth.refresh'
  | 'oauth.reuse_detected'
  | 'oauth.revoke'
  | 'proposal.transition'
  | 'plan.transition'
  | 'autonomy.change'

export type OperatorAuditInput = Readonly<{
  requestId: string
  eventType: OperatorAuditEventType
  outcome: string
  grantId?: string | null
  clientId?: string | null
  tool?: string | null
  argsHash?: string | null
  args?: unknown
  targetTenantId?: string | null
  targetVenueId?: string | null
  proposalId?: string | null
  planId?: string | null
  actorUserId?: string | null
  latencyMs?: number | null
}>

const SENSITIVE_KEY =
  /token|secret|password|authorization|verifier|challenge|cookie|pepper|^code$|refresh|credential/iu
const BODY_KEY = /^(textBody|body|note|text)$/u
const EMAIL = /^([^@\s]{1,64})@([^@\s]{1,255})$/u

/**
 * Redacts audit arguments: secrets never persist, free text is reduced to its length, email local
 * parts are masked, and depth and size are bounded. The full arguments stay only in the proposal
 * row that Tom reviews; the audit row is for reconstruction, not replay.
 */
export function redactOperatorArgs(value: unknown, depth = 0, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (BODY_KEY.test(key)) return `[text:${value.length}]`
    const email = EMAIL.exec(value.trim())
    if (email) return `${email[1]!.slice(0, 1)}***@${email[2]}`
    if (/^pf_(oac|oat|ort|mcp)_/u.test(value)) return '[redacted]'
    return value.length > 200 ? `${value.slice(0, 200)}…[${value.length}]` : value
  }
  if (depth >= 4) return '[depth]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => redactOperatorArgs(item, depth + 1, key))
    return value.length > 20 ? [...items, `[+${value.length - 20}]`] : items
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([entryKey, entry]) => [entryKey, redactOperatorArgs(entry, depth + 1, entryKey)]),
    )
  }
  return '[unsupported]'
}

/** Appends one audit row. The table rejects UPDATE, DELETE and TRUNCATE at the database. */
export async function writeOperatorAudit(
  input: OperatorAuditInput,
  database: OperatorDatabase = db,
): Promise<void> {
  await database.operatorAuditEvent.create({
    data: {
      requestId: input.requestId.slice(0, 64),
      eventType: input.eventType,
      outcome: input.outcome.slice(0, 64),
      grantId: input.grantId ?? null,
      clientId: input.clientId ?? null,
      tool: input.tool ?? null,
      argsHash: input.argsHash ?? null,
      ...(input.args === undefined
        ? {}
        : { redactedArgs: redactOperatorArgs(input.args) as object }),
      targetTenantId: input.targetTenantId ?? null,
      targetVenueId: input.targetVenueId ?? null,
      proposalId: input.proposalId ?? null,
      planId: input.planId ?? null,
      actorUserId: input.actorUserId ?? null,
      latencyMs: input.latencyMs ?? null,
    },
  })
}

/**
 * Audit on a path that must still answer (for example a denial). Failure is logged with codes
 * only; the caller's decision is never weakened by an audit outage.
 */
export async function writeOperatorAuditBestEffort(
  input: OperatorAuditInput,
  database: OperatorDatabase = db,
): Promise<void> {
  try {
    await writeOperatorAudit(input, database)
  } catch {
    logger.error({
      action: 'operator.audit.write_failed',
      error: `${input.eventType}:${input.outcome}`,
    })
  }
}
