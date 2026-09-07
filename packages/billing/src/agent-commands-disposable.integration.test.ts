import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { executeApprovedBillingAgentCommand, proposeBillingAgentCommand } from './agent-commands'
import { parseBillingEnvironment } from './config'
import { createBillingAccessOverride, createManualBillingArrangement } from './service'

const enabled =
  process.env.RUN_BILLING_COMMAND_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('billing commands on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('serializes grace effects and recovers committed effects without duplication', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `billing-race-${suffix}`
      const venueId = `billing-venue-${suffix}`
      const identityId = `billing-agent-${suffix}`
      await db.tenant.create({
        data: { id: tenantId, slug: tenantId, name: 'Synthetic billing recovery' },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, slug: venueId, name: 'Synthetic museum' },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: identityId,
          name: 'Synthetic billing worker',
          agentType: 'CUSTOMER_OPERATIONS',
          accessScope: 'VENUE',
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: 'fixture',
        },
      })
      const agreement = await createManualBillingArrangement({
        tenantId,
        actorId: 'fixture',
        mode: 'MANUAL_INVOICE',
        planKey: 'synthetic-custom-monthly',
        amountMinor: 5000n,
        venueIds: [venueId],
        reason: 'Disposable provider-dark billing race',
        client: db,
      })
      const environment = parseBillingEnvironment({
        NODE_ENV: 'test',
        RAILWAY_ENVIRONMENT: 'preview',
        DASHBOARD_URL: 'https://example.test',
      })
      const expiresAt = new Date(Date.now() + 86_400_000)
      const payload = {
        action: 'SET_GRACE_PERIOD' as const,
        agreementId: agreement.id,
        expiresAt: expiresAt.toISOString(),
        reference: 'SYNTHETIC',
        reason: 'Disposable approved grace',
      }
      const createCommand = async () => {
        const proposal = await proposeBillingAgentCommand({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          payload,
          client: db,
        })
        await db.approvalDecision.create({
          data: {
            tenantId,
            venueId,
            approvalRequestId: proposal.command.approvalRequestId,
            decision: 'APPROVED',
            decidedByType: 'HUMAN',
            decidedById: 'fixture',
          },
        })
        return proposal.command
      }
      const first = await createCommand()
      const invoke = (commandId: string, client = db) =>
        executeApprovedBillingAgentCommand({
          tenantId,
          commandId,
          actorId: 'fixture',
          provider: {} as never,
          environment,
          client,
        })
      const race = await Promise.allSettled(Array.from({ length: 8 }, () => invoke(first.id)))
      expect(race.some((result) => result.status === 'fulfilled')).toBe(true)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(1)
      expect(
        await db.billingAgentCommand.findFirst({ where: { id: first.id, tenantId } }),
      ).toMatchObject({ status: 'COMPLETED' })

      const second = await createCommand()
      let failOnce = true
      const failingClient = new Proxy(db, {
        get(target, key) {
          if (key !== 'billingAgentCommand') return Reflect.get(target, key)
          return new Proxy(target.billingAgentCommand, {
            get(model, property) {
              if (property !== 'updateMany') return Reflect.get(model, property)
              return async (args: Parameters<typeof db.billingAgentCommand.updateMany>[0]) => {
                if (args?.data.status === 'COMPLETED' && failOnce) {
                  failOnce = false
                  throw new Error('synthetic completion-write failure')
                }
                return model.updateMany(args)
              }
            },
          })
        },
      })
      await expect(invoke(second.id, failingClient)).rejects.toThrow(
        'synthetic completion-write failure',
      )
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(2)
      await invoke(second.id)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(2)

      const third = await createCommand()
      await db.billingAgentCommand.update({
        where: { id: third.id, tenantId },
        data: {
          status: 'EXECUTING',
          failureCode: 'EXECUTION_CLAIM_V2',
          updatedAt: new Date(Date.now() - 600_000),
        },
      })
      await invoke(third.id)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(3)
      const effects = await Promise.all(
        Array.from({ length: 8 }, () =>
          createBillingAccessOverride({
            tenantId,
            venueId,
            agreementId: agreement.id,
            actorId: 'fixture',
            effect: 'GRANT',
            kind: 'GRACE_PERIOD',
            expiresAt,
            reason: payload.reason,
            reference: payload.reference,
            idempotencyKey: 'independent-effect-race',
            client: db,
          }),
        ),
      )
      expect(new Set(effects.map((effect) => effect.id)).size).toBe(1)
      expect(await db.billingAccessOverride.count({ where: { tenantId } })).toBe(4)
      await expect(
        createBillingAccessOverride({
          tenantId,
          venueId,
          agreementId: agreement.id,
          actorId: 'fixture',
          effect: 'DENY',
          kind: 'GRACE_PERIOD',
          expiresAt,
          reason: payload.reason,
          reference: payload.reference,
          idempotencyKey: 'independent-effect-race',
          client: db,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        executeApprovedBillingAgentCommand({
          tenantId: 'wrong-tenant',
          commandId: first.id,
          actorId: 'fixture',
          provider: {} as never,
          environment,
          client: db,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(
        await db.auditLog.count({ where: { tenantId, action: 'billing.access-override.created' } }),
      ).toBe(4)
    })
  })
})
