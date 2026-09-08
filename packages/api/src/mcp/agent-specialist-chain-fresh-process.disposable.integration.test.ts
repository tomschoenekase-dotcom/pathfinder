import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  handleAgentBridgeHttpRequestCore,
  type AgentBridgeHttpRegistry,
} from '../agent-bridge/http-core'
import { handleMcpHttpRequest } from './http'
import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import {
  activateAgentBridgeCredentialAction,
  claimAgentBridgeTask,
  completeAgentBridgeTask,
  db,
  delegateAgentTaskAction,
  issueApprovalGrantAction,
  issueExternalCredentialAction,
  registerAgentBridgeSession,
  registerAgentWorkerAction,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const enabled =
  process.env.RUN_AGENT_SPECIALIST_CHAIN_FRESH_PROCESS_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_agent_bridge_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')
const helper = resolve(
  process.cwd(),
  '../../apps/workers/src/lib/agent-specialist-chain-fresh-process.fixture.ts',
)
const tsx = createRequire(resolve(process.cwd(), '../db/package.json')).resolve('tsx/cli')

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP'] as const
  return {
    NODE_ENV: 'test' as const,
    ...Object.fromEntries(
      allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
    ),
  }
}

function fresh(input: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolveResult, reject) => {
    const child = spawn(process.execPath, [tsx, helper], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      env: safeChildEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => child.kill(), 15_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > 16_384) child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stderr) > 16_384) child.kill()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) return reject(new Error(`Fresh specialist failed: ${stderr.slice(0, 500)}`))
      try {
        resolveResult(JSON.parse(stdout) as Record<string, unknown>)
      } catch {
        reject(new Error('Fresh specialist returned invalid proof'))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

describe.skipIf(!enabled)('fresh-process specialist result chain', () => {
  afterAll(async () => db.$disconnect())

  it('continues research through proposal and notification draft across three exited processes', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `tenant-${suffix}`
      const venueId = `venue-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: `admin-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({ data: { id: tenantId, name: 'Fresh chain tenant', slug: tenantId } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Fresh chain venue', slug: venueId },
      })
      const identities = {
        parent: `parent-${suffix}`,
        research: `research-${suffix}`,
        builder: `builder-${suffix}`,
        notification: `notification-${suffix}`,
      }
      for (const [role, id, capability] of [
        ['analyst', identities.parent, 'agent-runs:read'],
        ['researcher', identities.research, 'agent-runs:read'],
        ['venue-builder', identities.builder, 'locations:propose'],
        ['venue-updater', identities.notification, 'updates:draft'],
      ] as const)
        await db.agentIdentity.create({
          data: {
            id,
            tenantId,
            venueId,
            identityKey: `fixture.${role}-${suffix}`,
            name: `Fixture ${role}`,
            agentType: role.toUpperCase(),
            accessScope: 'VENUE',
            accessCapabilities: ['agent-runs:read', capability],
            autonomyLevel: 'DRAFT',
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
        label: 'Synthetic fresh specialist credential',
        capabilities: [
          'agent-runs:execute',
          'agent-runs:read',
          'resources:read',
          'locations:propose',
          'updates:draft',
        ],
        expiresAt: new Date(Date.now() + 3_600_000),
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
      const credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      for (const [phase, role, capability] of [
        ['research', 'researcher', 'agent-runs:read'],
        ['builder', 'venue-builder', 'locations:propose'],
        ['notification', 'venue-updater', 'updates:draft'],
        ['parent', 'analyst', 'agent-runs:read'],
      ] as const)
        await registerAgentWorkerAction(
          {
            workerKey: `${phase}-${venueId}`,
            runtimeType: 'CODEX',
            label: phase,
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

      const bridgeRegistry = {
        register: (raw, context) =>
          registerAgentBridgeSession({
            ...(raw as Parameters<typeof registerAgentBridgeSession>[0]),
            credential: context.credential as VerifiedMcpCredentialScope,
          }),
        claimTask: (raw, context) =>
          claimAgentBridgeTask({
            ...(raw as Omit<Parameters<typeof claimAgentBridgeTask>[0], 'credential'>),
            credential: context.credential as VerifiedMcpCredentialScope,
          }),
        completeTask: (raw, context) => {
          const value = raw as Omit<
            Parameters<typeof completeAgentBridgeTask>[0],
            'credential' | 'costE8Usd'
          > & { costE8Usd: string }
          return completeAgentBridgeTask({
            ...value,
            costE8Usd: BigInt(value.costE8Usd),
            credential: context.credential as VerifiedMcpCredentialScope,
          })
        },
      } as AgentBridgeHttpRegistry
      const server = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = []
          let bytes = 0
          for await (const chunk of request) {
            const buffer = Buffer.from(chunk)
            bytes += buffer.length
            if (bytes > 128 * 1024) {
              response.writeHead(413).end()
              return
            }
            chunks.push(buffer)
          }
          const webRequest = new Request(`http://127.0.0.1${request.url}`, {
            method: request.method ?? 'POST',
            headers: new Headers(
              Object.entries(request.headers).flatMap(([key, value]) =>
                value === undefined
                  ? []
                  : [[key, Array.isArray(value) ? value.join(', ') : value] as [string, string]],
              ),
            ),
            body: Buffer.concat(chunks),
          })
          const result = request.url?.startsWith('/mcp')
            ? await handleMcpHttpRequest(
                webRequest,
                { tenantId, venueId },
                { allowAttempt: () => true },
              )
            : await handleAgentBridgeHttpRequestCore(
                webRequest,
                { tenantId, venueId },
                {
                  verify: verifyAgentBridgeCredential,
                  registry: bridgeRegistry,
                  allowAttempt: () => true,
                },
              )
          response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
          response.end(Buffer.from(await result.arrayBuffer()))
        } catch {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        }
      })
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
        const base = `http://127.0.0.1:${address.port}`
        const childInput = {
          bridgeEndpoint: `${base}/bridge`,
          mcpEndpoint: `${base}/mcp`,
          secret: issued.plaintextSecret!,
          venueId,
        }
        const parent = await db.agentRun.create({
          data: {
            operationId: randomUUID(),
            tenantId,
            venueId,
            agentIdentityId: identities.parent,
            runType: 'ANALYST',
            requestedOperation: 'coordinate_specialist_chain',
            requestPrompt: `Coordinate deterministic specialists identity:${identities.parent}`,
            scopeSnapshot: {
              requiredWorkerRoles: ['analyst'],
              requiredWorkerCapabilities: ['agent-runs:read'],
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
        const parentSession = randomUUID()
        await registerAgentBridgeSession({
          sessionId: parentSession,
          venueId,
          provider: 'CODEX_SUBSCRIPTION',
          label: 'Parent',
          runnerVersion: 'fixture/1',
          supportedModels: ['subscription-default'],
          credential,
        })
        const parentClaim = await claimAgentBridgeTask({
          sessionId: parentSession,
          venueId,
          workerKey: `parent-${venueId}`,
          credential,
        })
        expect(parentClaim.task?.id).toBe(parent.id)
        const parentBefore = await db.agentRun.findUniqueOrThrow({
          where: { id: parent.id },
          select: {
            status: true,
            executionLeaseToken: true,
            executionWorkerId: true,
            executionBridgeSessionId: true,
          },
        })

        const research = await delegateAgentTaskAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          parentAgentRunId: parent.id,
          requestingAgentIdentityId: identities.parent,
          specialistAgentIdentityId: identities.research,
          instructions: `Research synthetic entrance evidence identity:${identities.research} parent-run:${parent.id}`,
          reason: 'Retain bounded research.',
        })
        const researchProcess = await fresh({ ...childInput, phase: 'RESEARCH' })
        expect(researchProcess).toMatchObject({
          runId: research.run.id,
          staleCompletionRejected: true,
        })
        const wrongScopeRead = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${issued.plaintextSecret!}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'wrong-scope',
            method: 'tools/call',
            params: {
              name: 'pathfinder.read',
              arguments: {
                resource: 'agent-run-result',
                clientId: tenantId,
                venueId: `wrong-${venueId}`,
                agentRunId: research.run.id,
                artifactIndex: 0,
                limit: 25,
              },
            },
          }),
        })
        const wrongScopeBody = await wrongScopeRead.text()
        expect(JSON.parse(wrongScopeBody)).toMatchObject({
          error: { code: -32001, data: { code: 'MCP_SCOPE_DENIED' } },
        })
        expect(wrongScopeBody).not.toContain('step-free east entrance')

        const builder = await delegateAgentTaskAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          parentAgentRunId: parent.id,
          requestingAgentIdentityId: identities.parent,
          specialistAgentIdentityId: identities.builder,
          instructions: `Read agent-run:${research.run.id} identity:${identities.builder} parent-run:${parent.id}`,
          reason: 'Build only from retained research.',
        })
        const builderProcess = await fresh({ ...childInput, phase: 'BUILDER' })
        expect(builderProcess).toMatchObject({
          runId: builder.run.id,
          sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          awaitingApproval: true,
          approvalRequestId: expect.any(String),
        })

        const operationId = randomUUID()
        const startsAt = new Date(Date.now() + 60_000).toISOString()
        const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
        const retainedBuilder = await db.agentRun.findUniqueOrThrow({
          where: { id: builder.run.id },
          select: { status: true, artifacts: true, parentAgentRunId: true },
        })
        expect(retainedBuilder).toEqual({
          status: 'AWAITING_APPROVAL',
          artifacts: [],
          parentAgentRunId: parent.id,
        })
        const retainedBuilderApprovals = await db.approvalRequest.findMany({
          where: {
            tenantId,
            venueId,
            agentRunId: builder.run.id,
            proposedAction: 'torchiko.locations.create_draft',
          },
          select: {
            id: true,
            scopeSnapshot: true,
            decision: { select: { decision: true } },
          },
        })
        expect(retainedBuilderApprovals).toHaveLength(1)
        expect(retainedBuilderApprovals[0]).toMatchObject({
          id: builderProcess.approvalRequestId,
          scopeSnapshot: {
            draft: { description: 'Deterministic draft from step-free east entrance.' },
          },
          decision: null,
        })
        const retainedProposalId = retainedBuilderApprovals[0]!.id
        const body = `A deterministic visitor draft references retained proposal ${retainedProposalId}.`
        const parameters = {
          clientId: tenantId,
          venueId,
          updateType: 'GENERAL_NOTICE',
          severity: 'INFO',
          priority: 'NORMAL',
          title: 'Accessible entrance information under review',
          body,
          startsAt,
          expiresAt,
        }
        const request = await db.approvalRequest.create({
          data: {
            tenantId,
            venueId,
            agentIdentityId: identities.notification,
            agentRunId: null,
            requestedByType: 'HUMAN',
            requestedById: actor.id,
            proposedAction: 'pathfinder.create_update_draft',
            scopeSnapshot: {},
            reason: 'Authorize one synthetic draft.',
            riskCategory: 'LOW',
            artifacts: [],
          },
        })
        const decision = await db.approvalDecision.create({
          data: {
            tenantId,
            venueId,
            approvalRequestId: request.id,
            decision: 'APPROVED',
            decidedByType: 'HUMAN',
            decidedById: actor.id,
            reason: 'Fixture-only draft approval.',
          },
        })
        const grant = await issueApprovalGrantAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identities.notification,
          actionName: 'pathfinder.create_update_draft',
          capability: 'updates:draft',
          mode: 'ONE_SHOT',
          scope: { tenantId, venueId },
          approvalDecisionId: decision.id,
          parameters,
          issueReason: 'One deterministic notification draft.',
          actor,
        })
        const notification = await delegateAgentTaskAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          parentAgentRunId: parent.id,
          requestingAgentIdentityId: identities.parent,
          specialistAgentIdentityId: identities.notification,
          instructions: `Read agent-run:${builder.run.id} identity:${identities.notification} parent-run:${parent.id} approval-grant:${grant.id} update-operation:${operationId} starts-at:${startsAt} expires-at:${expiresAt}`,
          reason: 'Draft visitor notice from retained proposal.',
        })
        const notificationProcess = await fresh({ ...childInput, phase: 'NOTIFICATION' })
        expect(notificationProcess).toMatchObject({
          runId: notification.run.id,
          sourceHash: null,
          sourceReadResource: 'agent-run-trace',
          proposalApprovalRequestId: retainedProposalId,
        })

        expect(
          new Set([
            researchProcess.processId,
            builderProcess.processId,
            notificationProcess.processId,
          ]).size,
        ).toBe(3)
        await expect(
          db.agentRun.findUniqueOrThrow({
            where: { id: parent.id },
            select: {
              status: true,
              executionLeaseToken: true,
              executionWorkerId: true,
              executionBridgeSessionId: true,
            },
          }),
        ).resolves.toEqual(parentBefore)
        for (const child of [research.run, notification.run]) {
          expect(
            await db.agentMessage.count({
              where: {
                agentRunId: parent.id,
                messageType: 'RESULT',
                content: { startsWith: `agent-run:${child.id} completed.` },
              },
            }),
          ).toBe(1)
          expect(
            await db.agentTimelineEvent.count({
              where: {
                agentRunId: parent.id,
                eventType: 'DELEGATED_TASK_COMPLETED',
                data: { path: ['childAgentRunId'], equals: child.id },
              },
            }),
          ).toBe(1)
        }
        expect(
          await db.agentMessage.count({
            where: {
              agentRunId: parent.id,
              messageType: 'RESULT',
              content: { startsWith: `agent-run:${builder.run.id} completed.` },
            },
          }),
        ).toBe(0)
        expect(
          await db.agentTimelineEvent.count({
            where: {
              agentRunId: parent.id,
              eventType: 'DELEGATED_TASK_COMPLETED',
              data: { path: ['childAgentRunId'], equals: builder.run.id },
            },
          }),
        ).toBe(0)
        await expect(
          db.agentRun.findUniqueOrThrow({
            where: { id: builder.run.id },
            select: { status: true, completedAt: true, artifacts: true },
          }),
        ).resolves.toEqual({
          status: 'AWAITING_APPROVAL',
          completedAt: null,
          artifacts: [],
        })
        await expect(
          db.approvalRequest.count({
            where: {
              tenantId,
              venueId,
              agentRunId: builder.run.id,
              proposedAction: 'torchiko.locations.create_draft',
              decision: null,
            },
          }),
        ).resolves.toBe(1)
        expect(await db.venueLocation.count({ where: { tenantId, venueId } })).toBe(0)
        const updates = await db.operationalUpdate.findMany({
          where: { tenantId, venueId },
          select: { status: true, isActive: true, publishedAt: true, body: true },
        })
        expect(updates).toEqual([{ status: 'DRAFT', isActive: false, publishedAt: null, body }])
        await expect(
          db.approvalGrant.findUniqueOrThrow({
            where: { id: grant.id },
            select: { useCount: true, maxUses: true },
          }),
        ).resolves.toEqual({ useCount: 1, maxUses: 1 })
        await expect(
          db.approvalGrantConsumption.findMany({
            where: { tenantId, approvalGrantId: grant.id },
            select: {
              operationId: true,
              agentRunId: true,
              actionName: true,
              consumedAt: true,
            },
          }),
        ).resolves.toEqual([
          {
            operationId,
            agentRunId: notification.run.id,
            actionName: 'pathfinder.create_update_draft',
            consumedAt: expect.any(Date),
          },
        ])
        expect(await db.operationalEventDelivery.count({ where: { tenantId } })).toBe(0)
        expect(await db.operationalEventDeliveryAttempt.count({ where: { tenantId } })).toBe(0)
        process.stdout.write(
          `${JSON.stringify({ specialistFreshProcessProof: { processRestartObserved: true, distinctProcessCount: 3, processes: [researchProcess.processId, builderProcess.processId, notificationProcess.processId], runs: [research.run.id, builder.run.id, notification.run.id], researchArtifactHash: builderProcess.sourceHash, proposalApprovalRequestId: retainedProposalId, notificationSourceReadResource: notificationProcess.sourceReadResource, providerInferenceCalled: false, deterministicProtocolAdapter: true, parentStateUnchanged: true, terminalCallbackCount: 2, pendingBuilderApprovalCount: 1, draftCount: 1, publicMutationCount: 0, deliveryCount: 0 } })}\n`,
        )
      } finally {
        await new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        )
      }
    })
  }, 60_000)
})
