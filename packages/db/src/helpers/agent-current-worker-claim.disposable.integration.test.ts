import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { claimAgentBridgeTask, registerAgentBridgeSession } from './agent-bridge-actions'
import { assertCurrentAgentWorkerClaim } from './agent-current-worker-claim'
import { requestAgentRunCancellationAction } from './agent-run-cancellation-actions'
import { registerAgentWorkerAction } from './agent-worker-actions'
import {
  activateAgentBridgeCredentialAction,
  issueExternalCredentialAction,
  revokeExternalCredentialAction,
} from './external-credential-actions'
import { verifyAgentBridgeCredential } from './external-credential-verification'

const enabled =
  process.env.RUN_AGENT_CURRENT_WORKER_CLAIM_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_worker_claim_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

describe.skipIf(!enabled)('current worker claim on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('fences current worker admission against cancellation and revocation', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `worker-claim-${suffix}`
      const venueId = `venue-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: `operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({
        data: { id: tenantId, slug: tenantId, name: 'Disposable worker claim tenant' },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, slug: venueId, name: 'Disposable worker claim venue' },
      })

      async function fixture(label: string) {
        const identityId = `content-${label}-${suffix}`
        await db.agentIdentity.create({
          data: {
            id: identityId,
            tenantId,
            venueId,
            identityKey: `content.claim.${label}.${suffix}`,
            name: 'Disposable content worker',
            agentType: 'CONTENT',
            accessScope: 'VENUE',
            accessCapabilities: ['intake.read'],
            autonomyLevel: 'READ_ONLY',
            autonomousActions: [],
            defaultProvider: 'codex-bridge',
            defaultModel: 'subscription-default',
            enabled: true,
            createdBy: actor.id,
          },
        })
        const issued = await issueExternalCredentialAction({
          operationId: randomUUID(),
          tenantId,
          clientId: tenantId,
          venueId,
          actor,
          kind: 'MCP',
          label: `Disposable worker claim ${label}`,
          capabilities: ['agent-runs:execute', 'resources:read'],
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        const activated = await activateAgentBridgeCredentialAction({
          operationId: randomUUID(),
          tenantId,
          clientId: tenantId,
          venueId,
          credentialId: issued.credential.id,
          expectedUpdatedAt: issued.credential.updatedAt,
          actor,
        })
        const credential = await verifyAgentBridgeCredential({
          tenantId,
          venueId,
          plaintext: issued.plaintextSecret!,
        })
        const worker = await registerAgentWorkerAction(
          {
            workerKey: `worker-${label}-${suffix}`,
            runtimeType: 'CODEX',
            label: 'Disposable content worker',
            protocolVersion: 'mcp-2026-07-28',
            softwareVersion: 'integration/1',
            capabilities: ['agent-runs:execute', 'resources:read'],
            agentRoles: ['CONTENT'],
            safeHealth: {},
          },
          credential,
        )
        const sessionId = randomUUID()
        await registerAgentBridgeSession({
          sessionId,
          venueId,
          provider: 'CODEX_SUBSCRIPTION',
          label: 'Disposable claim runner',
          runnerVersion: 'integration/1',
          supportedModels: ['subscription-default'],
          credential,
        })
        const run = await db.agentRun.create({
          data: {
            operationId: randomUUID(),
            tenantId,
            venueId,
            agentIdentityId: identityId,
            runType: 'CONTENT',
            requestedOperation: `current-worker-claim.${label}`,
            scopeSnapshot: {},
            status: 'QUEUED',
            modelProvider: 'codex-bridge',
            modelName: 'subscription-default',
            initiatedByType: 'HUMAN',
            initiatedById: actor.id,
            maxAttempts: 2,
          },
        })
        const claimed = await claimAgentBridgeTask({
          sessionId,
          venueId,
          workerKey: worker.workerKey,
          credential,
        })
        expect(claimed.task).toMatchObject({ id: run.id })
        const persisted = await db.agentRun.findFirstOrThrow({
          where: { id: run.id, tenantId, venueId },
          select: {
            executionLeaseToken: true,
            executionBridgeSessionId: true,
            executionWorkerId: true,
          },
        })
        expect(persisted).toEqual({
          executionLeaseToken: claimed.task!.leaseToken,
          executionBridgeSessionId: sessionId,
          executionWorkerId: worker.id,
        })
        return {
          activated,
          credential,
          identityId,
          issued,
          run,
          sessionId,
          worker,
          leaseToken: claimed.task!.leaseToken,
        }
      }

      const admit = async (
        current: Awaited<ReturnType<typeof fixture>>,
        overrides: Record<string, unknown> = {},
      ) =>
        db.$transaction(async (tx) => {
          const claim = await assertCurrentAgentWorkerClaim(tx, {
            tenantId,
            clientId: tenantId,
            venueId,
            agentRunId: current.run.id,
            executionLeaseToken: current.leaseToken,
            bridgeSessionId: current.sessionId,
            workerId: current.worker.id,
            credentialScope: current.credential,
            requiredAgentType: 'CONTENT',
            requiredIdentityCapability: 'intake.read',
            requiredTransportCapabilities: ['resources:read'],
            ...overrides,
          })
          const effect = await tx.agentRun.findFirstOrThrow({
            where: { id: current.run.id, tenantId, venueId },
            select: { id: true, requestedOperation: true },
          })
          return { claim, effect }
        })

      const current = await fixture('baseline')
      await expect(admit(current)).resolves.toMatchObject({
        claim: {
          agentIdentityId: current.identityId,
          workerId: current.worker.id,
          credentialId: current.credential.credentialId,
          bridgeSessionId: current.sessionId,
        },
        effect: { id: current.run.id, requestedOperation: 'current-worker-claim.baseline' },
      })
      await expect(admit(current, { agentRunId: `missing-run-${suffix}` })).rejects.toThrow()
      await expect(admit(current, { executionLeaseToken: randomUUID() })).rejects.toThrow()
      await expect(admit(current, { bridgeSessionId: randomUUID() })).rejects.toThrow()
      await expect(admit(current, { workerId: `wrong-worker-${suffix}` })).rejects.toThrow()
      await expect(admit(current, { venueId: `wrong-venue-${suffix}` })).rejects.toThrow()

      const wrongCredential = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor,
        kind: 'MCP',
        label: 'Disposable wrong credential',
        capabilities: ['agent-runs:execute', 'resources:read'],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: wrongCredential.credential.id,
        expectedUpdatedAt: wrongCredential.credential.updatedAt,
        actor,
      })
      const wrongScope = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: wrongCredential.plaintextSecret!,
      })
      await expect(admit(current, { credentialScope: wrongScope })).rejects.toThrow()

      await requestAgentRunCancellationAction({
        tenantId,
        venueId,
        agentRunId: current.run.id,
        reason: 'Disposable cancellation fence',
        actor,
      })
      await expect(admit(current)).rejects.toThrow()

      const revoked = await fixture('revoke-first')
      await revokeExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: revoked.credential.credentialId,
        expectedUpdatedAt: revoked.activated.credential.updatedAt,
        reasonCode: 'DISPOSABLE_TEST',
        actor,
      })
      await expect(admit(revoked)).rejects.toThrow()

      const raced = await fixture('read-wins')
      let releaseRead: (() => void) | undefined
      let admittedRead: (() => void) | undefined
      let admissionFailed: ((error: unknown) => void) | undefined
      const readAdmitted = new Promise<void>((resolve, reject) => {
        admittedRead = resolve
        admissionFailed = reject
      })
      const release = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      const reading = db.$transaction(
        async (tx) => {
          await assertCurrentAgentWorkerClaim(tx, {
            tenantId,
            clientId: tenantId,
            venueId,
            agentRunId: raced.run.id,
            executionLeaseToken: raced.leaseToken,
            bridgeSessionId: raced.sessionId,
            workerId: raced.worker.id,
            credentialScope: raced.credential,
            requiredAgentType: 'CONTENT',
            requiredIdentityCapability: 'intake.read',
            requiredTransportCapabilities: ['resources:read'],
          })
          const effect = await tx.agentRun.findFirstOrThrow({
            where: { id: raced.run.id, tenantId, venueId },
            select: { id: true, requestedOperation: true },
          })
          admittedRead?.()
          await release
          return effect
        },
        { timeout: 15_000 },
      )
      const readingSettled = reading.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          admissionFailed?.(error)
          return { ok: false as const, error }
        },
      )
      let revokeSettled = false
      let revokeSettledResult:
        | { ok: true; value: Awaited<ReturnType<typeof revokeExternalCredentialAction>> }
        | { ok: false; error: unknown }
        | undefined
      let awaitRevoke:
        | Promise<
            | { ok: true; value: Awaited<ReturnType<typeof revokeExternalCredentialAction>> }
            | { ok: false; error: unknown }
          >
        | undefined
      let readingResult: Awaited<typeof readingSettled> | undefined
      try {
        await readAdmitted
        awaitRevoke = revokeExternalCredentialAction({
          operationId: randomUUID(),
          tenantId,
          clientId: tenantId,
          venueId,
          credentialId: raced.credential.credentialId,
          expectedUpdatedAt: raced.activated.credential.updatedAt,
          reasonCode: 'DISPOSABLE_RACE',
          actor,
        })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          .finally(() => {
            revokeSettled = true
          })
        let observedWait = false
        for (let attempt = 0; attempt < 120 && !observedWait; attempt += 1) {
          const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query ILIKE ${'%external_access_credentials%'}
            ) AS waiting
          `
          observedWait = rows[0]?.waiting === true
          if (!observedWait) await pause(25)
        }
        expect(observedWait).toBe(true)
        expect(revokeSettled).toBe(false)
      } finally {
        releaseRead?.()
        readingResult = await readingSettled
        if (awaitRevoke) revokeSettledResult = await awaitRevoke
      }
      expect(readingResult).toEqual({
        ok: true,
        value: { id: raced.run.id, requestedOperation: 'current-worker-claim.read-wins' },
      })
      expect(revokeSettledResult).toMatchObject({
        ok: true,
        value: { credential: { id: raced.credential.credentialId } },
      })
      await expect(admit(raced)).rejects.toThrow()
    })
  }, 30_000)
})
