import { createHash } from 'node:crypto'

export type ProspectSendRatePolicyInput = {
  now: Date
  operationId: string
  mailboxDailyCap: number
  campaignDailyCap: number
  domainDailyCap: number
  mailboxReservedToday: number
  campaignReservedToday: number
  domainReservedToday: number
  minimumDelaySeconds: number
  jitterSeconds: number
  lastReservedAt: Date | null
}

export type ProspectSendRateDecision =
  | { allowed: true }
  | { allowed: false; retryAt: Date; reason: 'DAILY_CAP' | 'MINIMUM_DELAY' }

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

function deterministicJitter(operationId: string, maximumSeconds: number): number {
  const maximum = Math.max(0, Math.floor(maximumSeconds))
  if (!maximum) return 0
  const value = createHash('sha256').update(operationId).digest().readUInt32BE(0)
  return value % (maximum + 1)
}

/** Pure policy used after the mailbox and campaign reservation lanes are locked. */
export function evaluateProspectSendRatePolicy(
  input: ProspectSendRatePolicyInput,
): ProspectSendRateDecision {
  if (
    input.mailboxReservedToday >= Math.max(0, input.mailboxDailyCap) ||
    input.campaignReservedToday >= Math.max(0, input.campaignDailyCap) ||
    input.domainReservedToday >= Math.max(0, input.domainDailyCap)
  ) {
    return { allowed: false, retryAt: nextUtcDay(input.now), reason: 'DAILY_CAP' }
  }
  if (input.lastReservedAt) {
    const delaySeconds =
      Math.max(0, input.minimumDelaySeconds) +
      deterministicJitter(input.operationId, input.jitterSeconds)
    const retryAt = new Date(input.lastReservedAt.getTime() + delaySeconds * 1_000)
    if (retryAt > input.now) return { allowed: false, retryAt, reason: 'MINIMUM_DELAY' }
  }
  return { allowed: true }
}
