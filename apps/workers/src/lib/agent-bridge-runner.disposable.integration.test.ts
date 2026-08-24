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
})
