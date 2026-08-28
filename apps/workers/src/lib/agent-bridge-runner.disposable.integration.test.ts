import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import {
  handleAgentBridgeHttpRequestCore,
  type AgentBridgeHttpRegistry,
} from '@pathfinder/api/agent-bridge/http-core'
import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import {
  activateAgentBridgeCredentialAction,
  claimAgentBridgeTask,
  completeAgentBridgeTask,
  db,
  failAgentBridgeTask,
  heartbeatAgentBridgeSession,
  heartbeatAgentBridgeTask,
  issueExternalCredentialAction,
  registerAgentBridgeSession,
  registerAgentWorkerAction,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import {
  buildAgentBridgeExecutionPrompt,
  createAgentBridgeHttpClient,
  parseAgentBridgeRunnerConfig,
  runAgentBridge,
} from './agent-bridge-runner'

const enabled =
  process.env.RUN_AGENT_BRIDGE_RUNNER_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_agent_bridge_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('agent bridge runner disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('proves authenticated HTTP claim, bounded context, retry, completion, and readback', async () => {
    await withTenantIsolationBypass(async () => {
      const tenantId = 'tenant-agent-bridge-runner'
      const venueId = 'venue-agent-bridge-runner'
      const identityId = 'identity-agent-bridge-runner'
      const operationId = randomUUID()
      const actor = {
        type: 'HUMAN' as const,
        id: 'integration-founder',
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable bridge tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Disposable bridge venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: 'bridge.context-reviewer',
          name: 'Bridge Context Reviewer',
          description: 'Reads one bounded venue-scoped task.',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
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
        label: 'Disposable runner credential',
        capabilities: ['agent-runs:execute', 'resources:read'],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor,
      })
      const run = await db.agentRun.create({
        data: {
          operationId,
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'review_venue_health',
          requestPrompt: null,
          scopeSnapshot: {
            venueId,
            accessCapabilities: ['operations.read'],
            destructiveActionsAllowed: false,
          },
          status: 'QUEUED',
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: actor.id,
          maxAttempts: 2,
        },
      })

      const controller = new AbortController()
      const config = parseAgentBridgeRunnerConfig({
        endpoint: `http://127.0.0.1/agent-bridge/${tenantId}/${venueId}`,
        secret: issued.plaintextSecret!,
        venueId,
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Disposable in-process runner',
        workdir: process.cwd(),
        sessionId: randomUUID(),
        modelName: 'subscription-default',
        pollMs: 1_000,
        taskTimeoutMs: 10_000,
      })
      const unsupported = async () => {
        throw new Error('UNSUPPORTED_IN_DISPOSABLE_BRIDGE')
      }
      const registry: AgentBridgeHttpRegistry = {
        registerWorker: unsupported,
        heartbeatWorker: unsupported,
        listWorkers: unsupported,
        listOperationalTools: unsupported,
        callOperationalTool: unsupported,
        callProspectTool: unsupported,
        register: async (raw, context) => {
          const input = raw as {
            sessionId: string
            venueId: string
            provider: string
            label: string
            runnerVersion: string
            supportedModels: string[]
          }
          return registerAgentBridgeSession({
            ...input,
            credential: context.credential as VerifiedMcpCredentialScope,
          })
        },
        heartbeatSession: async (raw, context) =>
          heartbeatAgentBridgeSession({
            ...(raw as { sessionId: string; venueId: string }),
            credential: context.credential as VerifiedMcpCredentialScope,
          }),
        claimTask: async (raw, context) =>
          claimAgentBridgeTask({
            ...(raw as { sessionId: string; venueId: string }),
            credential: context.credential as VerifiedMcpCredentialScope,
          }),
        heartbeatTask: async (raw, context) =>
          heartbeatAgentBridgeTask({
            ...(raw as {
              sessionId: string
              venueId: string
              runId: string
              leaseToken: string
            }),
            credential: context.credential as VerifiedMcpCredentialScope,
          }),
        completeTask: async (raw, context) => {
          const input = raw as {
            sessionId: string
            venueId: string
            runId: string
            leaseToken: string
            summary: string
            artifacts: unknown[]
            modelName: string
            costE8Usd: string
            costStatus: 'UNREPORTED' | 'ESTIMATED' | 'EXACT'
          }
          return completeAgentBridgeTask({
            ...input,
            costE8Usd: BigInt(input.costE8Usd),
            credential: context.credential as VerifiedMcpCredentialScope,
          })
        },
        failTask: async (raw, context) =>
          failAgentBridgeTask({
            ...(raw as {
              sessionId: string
              venueId: string
              runId: string
              leaseToken: string
              errorCode: string
              errorMessage: string
              retryable: boolean
            }),
            credential: context.credential as VerifiedMcpCredentialScope,
          }),
      }
      const fetcher: typeof fetch = async (input, init) =>
        handleAgentBridgeHttpRequestCore(
          new Request(input, init),
          { tenantId, venueId },
          {
            verify: verifyAgentBridgeCredential,
            registry,
            allowAttempt: () => true,
          },
        )
      const httpCall = createAgentBridgeHttpClient(config, fetcher)
      const call = async (method: string, params: unknown, signal?: AbortSignal) => {
        const result = await httpCall(method, params, signal)
        if (method === 'completeTask') controller.abort()
        return result
      }
      let executions = 0
      const execute = async (rawTask: unknown) => {
        executions += 1
        const task = rawTask as Parameters<typeof buildAgentBridgeExecutionPrompt>[0]
        expect(task).toMatchObject({
          id: run.id,
          operationId,
          venueId,
          requestedOperation: 'review_venue_health',
          prompt: null,
          modelProvider: 'codex-bridge',
          attemptNumber: executions,
          initiator: { type: 'HUMAN', id: actor.id },
          agent: {
            identityKey: 'bridge.context-reviewer',
            autonomyLevel: 'READ_ONLY',
            accessCapabilities: ['operations.read'],
          },
        })
        const prompt = buildAgentBridgeExecutionPrompt(task)
        expect(prompt).toContain('Task: review_venue_health')
        expect(prompt).toContain('"destructiveActionsAllowed": false')
        if (executions === 1) throw new Error('TASK_EXECUTOR_FAILED')
        return {
          content: 'BRIDGE_RUNNER_E2E_OK',
          modelName: 'subscription-default',
          costE8Usd: '0',
          costStatus: 'UNREPORTED' as const,
        }
      }

      await runAgentBridge(config, controller.signal, { call, execute })

      const evidence = await db.agentRun.findUniqueOrThrow({
        where: { id: run.id },
        select: {
          status: true,
          attemptNumber: true,
          operationId: true,
          artifacts: true,
          modelProvider: true,
          modelName: true,
          costE8Usd: true,
          costStatus: true,
          executionBridgeSessionId: true,
          timelineEvents: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { eventType: true, data: true },
          },
        },
      })
      expect(executions).toBe(2)
      expect(evidence).toMatchObject({
        status: 'COMPLETED',
        attemptNumber: 2,
        operationId,
        modelProvider: 'codex-bridge',
        modelName: 'subscription-default',
        costE8Usd: 0n,
        costStatus: 'UNREPORTED',
        executionBridgeSessionId: config.sessionId,
        artifacts: [
          {
            type: 'markdown',
            title: 'Agent result',
            content: 'BRIDGE_RUNNER_E2E_OK',
          },
        ],
      })
      expect(evidence.timelineEvents.map((event) => event.eventType)).toEqual([
        'EXECUTION_CLAIMED',
        'EXECUTION_RETRY_SCHEDULED',
        'EXECUTION_CLAIMED',
        'EXECUTION_COMPLETED',
      ])
      expect(evidence.timelineEvents.at(-1)?.data).toMatchObject({
        artifactCount: 1,
        modelProvider: 'codex-bridge',
        modelName: 'subscription-default',
        costE8Usd: '0',
        costStatus: 'UNREPORTED',
      })
    })
  }, 30_000)

  it('runs heterogeneous workers concurrently and fences expired-worker takeover', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-workforce-${suffix}`
      const venueId = `venue-workforce-${suffix}`
      const operator = {
        type: 'HUMAN' as const,
        id: `integration-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable workforce tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Disposable workforce venue', slug: venueId },
      })
      const identities = {
        researcher: `identity-researcher-${suffix}`,
        builder: `identity-builder-${suffix}`,
        analyst: `identity-analyst-${suffix}`,
      }
      await db.agentIdentity.createMany({
        data: [
          {
            id: identities.researcher,
            tenantId,
            venueId,
            identityKey: `researcher-${suffix}`,
            name: 'Researcher',
            agentType: 'RESEARCH',
            accessScope: 'VENUE',
            accessCapabilities: ['knowledge:read'],
            autonomyLevel: 'READ_ONLY',
            enabled: true,
            createdBy: operator.id,
          },
          {
            id: identities.builder,
            tenantId,
            venueId,
            identityKey: `builder-${suffix}`,
            name: 'Venue Builder',
            agentType: 'BUILDER',
            accessScope: 'VENUE',
            accessCapabilities: ['intake:draft'],
            autonomyLevel: 'DRAFT',
            enabled: true,
            createdBy: operator.id,
          },
          {
            id: identities.analyst,
            tenantId,
            venueId,
            identityKey: `analyst-${suffix}`,
            name: 'Analyst',
            agentType: 'ANALYTICS',
            accessScope: 'VENUE',
            accessCapabilities: ['reports:draft'],
            autonomyLevel: 'READ_ONLY',
            enabled: true,
            createdBy: operator.id,
          },
        ],
      })
      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor: operator,
        kind: 'MCP',
        label: 'Disposable workforce credential',
        capabilities: [
          'agent-runs:execute',
          'resources:read',
          'knowledge:read',
          'intake:draft',
          'reports:draft',
        ],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor: operator,
      })
      const credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      const workerSpecs = [
        ['researcher-a', 'researcher', 'knowledge:read', 'CODEX'],
        ['researcher-b', 'researcher', 'knowledge:read', 'OPENAI_COMPATIBLE'],
        ['builder', 'venue-builder', 'intake:draft', 'HERMES'],
        ['analyst', 'analyst', 'reports:draft', 'CLAUDE'],
      ] as const
      const workers = await Promise.all(
        workerSpecs.map(async ([key, role, capability, runtimeType]) => {
          const workerKey = `${key}-${suffix}`
          const sessionId = randomUUID()
          await registerAgentWorkerAction(
            {
              workerKey,
              runtimeType,
              label: workerKey,
              protocolVersion: 'mcp-2026-07-28',
              softwareVersion: 'fixture/1',
              capabilities: ['agent-runs:execute', capability],
              agentRoles: [role],
              modelProvider: 'codex-bridge',
              modelName: 'subscription-default',
              safeHealth: { state: 'ready' },
            },
            credential,
            { leaseSeconds: 300 },
          )
          await registerAgentBridgeSession({
            sessionId,
            venueId,
            provider: 'CODEX_SUBSCRIPTION',
            label: workerKey,
            runnerVersion: 'fixture/1',
            supportedModels: ['subscription-default'],
            credential,
          })
          return { workerKey, sessionId, role, capability }
        }),
      )
      const runSpecs = [
        [identities.researcher, 'researcher', 'knowledge:read'],
        [identities.researcher, 'researcher', 'knowledge:read'],
        [identities.builder, 'venue-builder', 'intake:draft'],
        [identities.analyst, 'analyst', 'reports:draft'],
      ] as const
      const runs = await Promise.all(
        runSpecs.map(([identityId, role, capability], index) =>
          db.agentRun.create({
            data: {
              operationId: randomUUID(),
              tenantId,
              venueId,
              agentIdentityId: identityId,
              runType: role.toUpperCase(),
              requestedOperation: `routine_${role.replace('-', '_')}_${index + 1}`,
              requestPrompt: null,
              scopeSnapshot: {
                requiredWorkerRoles: [role],
                requiredWorkerCapabilities: [capability],
                destructiveActionsAllowed: false,
              },
              status: 'QUEUED',
              modelProvider: 'codex-bridge',
              modelName: 'subscription-default',
              initiatedByType: 'SYSTEM',
              initiatedById: 'workforce-scheduler',
              maxAttempts: 3,
            },
          }),
        ),
      )
      const claims = await Promise.all(
        workers.map((worker) =>
          claimAgentBridgeTask({
            sessionId: worker.sessionId,
            venueId,
            workerKey: worker.workerKey,
            credential,
          }),
        ),
      )
      expect(new Set(claims.map((claim) => claim.task?.id)).size).toBe(4)
      for (const [index, claim] of claims.entries()) {
        expect(claim.task?.scope).toMatchObject({
          requiredWorkerRoles: [workers[index]!.role],
          requiredWorkerCapabilities: [workers[index]!.capability],
          destructiveActionsAllowed: false,
        })
      }
      await Promise.all(
        claims.map((claim, index) =>
          completeAgentBridgeTask({
            sessionId: workers[index]!.sessionId,
            venueId,
            runId: claim.task!.id,
            leaseToken: claim.task!.leaseToken,
            summary: `Routine ${workers[index]!.role} work completed without founder routing.`,
            artifacts: [{ type: 'json', title: 'Bounded evidence', role: workers[index]!.role }],
            modelName: 'subscription-default',
            costE8Usd: BigInt((index + 1) * 1_000),
            costStatus: 'EXACT',
            credential,
          }),
        ),
      )
      const completed = await db.agentRun.findMany({
        where: { id: { in: runs.map((run) => run.id) } },
        select: {
          status: true,
          costE8Usd: true,
          costStatus: true,
          initiatedByType: true,
          initiatedById: true,
          executionWorkerId: true,
          _count: { select: { approvalRequests: true, questions: true } },
        },
      })
      expect(completed).toHaveLength(4)
      expect(completed.every((run) => run.status === 'COMPLETED')).toBe(true)
      expect(completed.every((run) => run.costStatus === 'EXACT' && run.costE8Usd > 0n)).toBe(true)
      expect(
        completed.every(
          (run) =>
            run.initiatedByType === 'SYSTEM' &&
            run.initiatedById === 'workforce-scheduler' &&
            Boolean(run.executionWorkerId) &&
            run._count.approvalRequests === 0 &&
            run._count.questions === 0,
        ),
      ).toBe(true)

      const takeoverRun = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identities.researcher,
          runType: 'RESEARCH',
          requestedOperation: 'recover_expired_research_lease',
          requestPrompt: null,
          scopeSnapshot: {
            requiredWorkerRoles: ['researcher'],
            requiredWorkerCapabilities: ['knowledge:read'],
            destructiveActionsAllowed: false,
          },
          status: 'QUEUED',
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'SYSTEM',
          initiatedById: 'workforce-scheduler',
          maxAttempts: 3,
        },
      })
      const firstClaim = await claimAgentBridgeTask({
        sessionId: workers[0]!.sessionId,
        venueId,
        workerKey: workers[0]!.workerKey,
        credential,
      })
      expect(firstClaim.task?.id).toBe(takeoverRun.id)
      await db.agentRun.update({
        where: { id: takeoverRun.id },
        data: { executionLeaseExpiresAt: new Date(Date.now() - 1_000) },
      })
      const takeoverClaim = await claimAgentBridgeTask({
        sessionId: workers[1]!.sessionId,
        venueId,
        workerKey: workers[1]!.workerKey,
        credential,
      })
      expect(takeoverClaim.task).toMatchObject({ id: takeoverRun.id, attemptNumber: 2 })
      await expect(
        completeAgentBridgeTask({
          sessionId: workers[0]!.sessionId,
          venueId,
          runId: takeoverRun.id,
          leaseToken: firstClaim.task!.leaseToken,
          summary: 'Stale worker must not settle.',
          artifacts: [],
          modelName: 'subscription-default',
          costE8Usd: 0n,
          costStatus: 'UNREPORTED',
          credential,
        }),
      ).rejects.toThrow()
      await completeAgentBridgeTask({
        sessionId: workers[1]!.sessionId,
        venueId,
        runId: takeoverRun.id,
        leaseToken: takeoverClaim.task!.leaseToken,
        summary: 'Replacement researcher completed the recovered work.',
        artifacts: [{ type: 'markdown', title: 'Recovery', content: 'TAKEOVER_OK' }],
        modelName: 'subscription-default',
        costE8Usd: 5_000n,
        costStatus: 'EXACT',
        credential,
      })
      await expect(
        completeAgentBridgeTask({
          sessionId: workers[1]!.sessionId,
          venueId,
          runId: takeoverRun.id,
          leaseToken: takeoverClaim.task!.leaseToken,
          summary: 'Duplicate completion must fail.',
          artifacts: [],
          modelName: 'subscription-default',
          costE8Usd: 5_000n,
          costStatus: 'EXACT',
          credential,
        }),
      ).rejects.toThrow()
      const takeoverEvidence = await db.agentRun.findUniqueOrThrow({
        where: { id: takeoverRun.id },
        select: {
          status: true,
          attemptNumber: true,
          costE8Usd: true,
          executionWorker: { select: { workerKey: true } },
          timelineEvents: { select: { eventType: true } },
        },
      })
      expect(takeoverEvidence).toMatchObject({
        status: 'COMPLETED',
        attemptNumber: 2,
        costE8Usd: 5_000n,
        executionWorker: { workerKey: workers[1]!.workerKey },
      })
      expect(
        takeoverEvidence.timelineEvents.filter(
          (event) => event.eventType === 'EXECUTION_COMPLETED',
        ),
      ).toHaveLength(1)
    })
  }, 45_000)
})
