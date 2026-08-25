import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  listFounderOperatingExchanges,
  recordFounderOperatingExchange,
} from './founder-operating-exchanges'

const enabled =
  process.env.RUN_FOUNDER_CONVERSATION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_founder_conversation_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

function snapshot() {
  return {
    schemaVersion: 1 as const,
    generatedAt: '2026-08-25T12:00:00.000Z',
    boundedSnapshot: { limit: 10, hasMore: false },
    metrics: {
      decisions: 0,
      criticalRisks: 0,
      workingAgents: 0,
      blockedAgents: 0,
      customerItems: 0,
    },
    changesSinceLastReview: {
      criticalRisks: 0,
      decisions: 0,
      completedAgents: 0,
      outcomes: 0,
      customerItems: 0,
    },
    operatingCosts: {
      windowDays: 30,
      knownOperatingCostUsd: '0.00000000',
      priorKnownOperatingCostUsd: '0.00000000',
      changeUsd: '0.00000000',
      coverageComplete: false,
      anomalyThreshold: 'UNRESOLVED' as const,
    },
    authority: {
      canExecute: false as const,
      canApprove: false as const,
      canContactCustomers: false as const,
      canChangePricing: false as const,
      canSpendMoney: false as const,
      canMutatePolicy: false as const,
    },
  }
}

describe.skipIf(!enabled)('founder operating conversation disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('retains append-only questions and directives without consequential effects', async () => {
    const baseline = await withTenantIsolationBypass(async () => ({
      tenants: await db.tenant.count(),
      venues: await db.venue.count(),
      agentRuns: await db.agentRun.count(),
      approvals: await db.approvalDecision.count(),
      events: await db.operationalEvent.count(),
      platformEvents: await db.platformOperationalEvent.count(),
      deliveries: await db.operationalEventDelivery.count(),
      billing: await db.billingAccount.count(),
      outbox: await db.prospectSendOutbox.count(),
    }))
    const operationId = randomUUID()
    const answer = {
      operationId,
      operatorUserId: 'founder-disposable',
      prompt: 'What needs my decision?',
      intent: 'DECISIONS' as const,
      disposition: 'ANSWERED' as const,
      responseTitle: 'No visible founder decisions',
      responseBody: 'No pending questions or approvals are visible in this bounded snapshot.',
      evidence: [],
      snapshot: snapshot(),
    }
    const created = await recordFounderOperatingExchange(answer)
    expect(created).toMatchObject({ replayed: false })
    await expect(recordFounderOperatingExchange(answer)).resolves.toMatchObject({
      replayed: true,
      exchange: { id: created.exchange.id },
    })
    await expect(
      recordFounderOperatingExchange({ ...answer, prompt: 'Different operation parameters' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const directive = await recordFounderOperatingExchange({
      ...answer,
      operationId: randomUUID(),
      prompt: 'Outreach to another group of venues.',
      intent: 'DIRECTIVE',
      disposition: 'RECORDED_FOR_TRIAGE',
      responseTitle: 'Direction recorded for triage',
      responseBody:
        'Nothing was executed, approved, sent to a customer, priced, billed, deployed, purchased, or adopted as policy.',
    })
    expect(directive.exchange.snapshot).toMatchObject({
      authority: {
        canExecute: false,
        canApprove: false,
        canContactCustomers: false,
        canChangePricing: false,
        canSpendMoney: false,
        canMutatePolicy: false,
      },
    })

    const history = await listFounderOperatingExchanges(1)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      id: directive.exchange.id,
      disposition: 'RECORDED_FOR_TRIAGE',
    })

    await expect(
      db.founderOperatingExchange.update({
        where: { id: created.exchange.id },
        data: { responseTitle: 'Mutated' },
      }),
    ).rejects.toThrow(/append-only/iu)
    await expect(
      db.founderOperatingExchange.delete({ where: { id: created.exchange.id } }),
    ).rejects.toThrow(/append-only/iu)
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "founder_operating_exchanges"'),
    ).rejects.toThrow(/append-only/iu)

    const audits = await db.auditLog.findMany({
      where: { action: 'founder-operating-exchange.recorded' },
      orderBy: { createdAt: 'asc' },
    })
    expect(audits).toHaveLength(2)
    expect(audits[0]?.afterState).toMatchObject({
      disposition: 'ANSWERED',
      authority: { canExecute: false, canApprove: false },
    })
    expect(JSON.stringify(audits)).not.toContain(answer.prompt)
    expect(JSON.stringify(audits)).not.toContain('Outreach to another group')

    const after = await withTenantIsolationBypass(async () => ({
      tenants: await db.tenant.count(),
      venues: await db.venue.count(),
      agentRuns: await db.agentRun.count(),
      approvals: await db.approvalDecision.count(),
      events: await db.operationalEvent.count(),
      platformEvents: await db.platformOperationalEvent.count(),
      deliveries: await db.operationalEventDelivery.count(),
      billing: await db.billingAccount.count(),
      outbox: await db.prospectSendOutbox.count(),
    }))
    expect(after).toEqual(baseline)
  })
})
