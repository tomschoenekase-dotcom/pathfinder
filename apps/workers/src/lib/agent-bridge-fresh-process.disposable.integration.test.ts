import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  handleAgentBridgeHttpRequestCore,
  type AgentBridgeHttpRegistry,
} from '@pathfinder/api/agent-bridge/http-core'
import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import {
  activateAgentBridgeCredentialAction,
  answerAgentQuestionAction,
  askAgentQuestionAction,
  claimAgentBridgeTask,
  completeAgentBridgeTask,
  db,
  issueExternalCredentialAction,
  registerAgentBridgeSession,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const enabled =
  process.env.RUN_AGENT_BRIDGE_FRESH_PROCESS_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_agent_bridge_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const helperPath = resolve(process.cwd(), 'src/lib/agent-bridge-fresh-process.fixture.ts')
const requireFromDb = createRequire(resolve(process.cwd(), '../../packages/db/package.json'))
const tsxCliPath = requireFromDb.resolve('tsx/cli')

function runFreshProcess(input: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, helperPath], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
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
      if (code !== 0) return reject(new Error(`Fresh process failed: ${stderr.slice(0, 500)}`))
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>)
      } catch {
        reject(new Error('Fresh process returned invalid evidence'))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

describe.skipIf(!enabled)('agent bridge fresh-process continuation', () => {
  afterAll(async () => db.$disconnect())

  it('replaces an exited process and completes from persisted answer context over HTTP', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `fresh-process-tenant-${suffix}`
      const venueId = `fresh-process-venue-${suffix}`
      const identityId = `fresh-process-agent-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: `fresh-process-admin-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({
        data: { id: tenantId, name: 'Fresh process tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Fresh process venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `fixture.fresh-process-${suffix}`,
          name: 'Fresh Process Draft Reviewer',
          description: 'Creates one deterministic read-only fixture draft.',
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
        label: 'Synthetic fresh-process credential',
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
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'prepare_capacity_review_draft',
          requestPrompt: 'Prepare a read-only capacity review draft from persisted task context.',
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
      let latestServerDiagnostic: {
        method: 'register' | 'claimTask' | 'completeTask'
        errorName: string
        errorCode: string | null
        issueCodes: string[]
      } | null = null
      const diagnose = async <T>(
        method: 'register' | 'claimTask' | 'completeTask',
        operation: () => Promise<T>,
      ) => {
        try {
          return await operation()
        } catch (error) {
          latestServerDiagnostic = {
            method,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorCode:
              error && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code ?? '') || null
                : null,
            issueCodes:
              error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)
                ? error.issues
                    .slice(0, 8)
                    .map((issue: unknown) =>
                      issue && typeof issue === 'object' && 'code' in issue
                        ? String((issue as { code?: unknown }).code ?? 'unknown')
                        : 'unknown',
                    )
                : [],
          }
          throw error
        }
      }
      const server = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = []
          let requestBytes = 0
          for await (const chunk of request) {
            const buffer = Buffer.from(chunk)
            requestBytes += buffer.byteLength
            if (requestBytes > 128 * 1024) {
              response.writeHead(413).end()
              return
            }
            chunks.push(buffer)
          }
          const registry = {
            register: async (raw: unknown, context: { credential: unknown }) =>
              diagnose('register', () =>
                registerAgentBridgeSession({
                  ...(raw as Parameters<typeof registerAgentBridgeSession>[0]),
                  credential: context.credential as VerifiedMcpCredentialScope,
                }),
              ),
            claimTask: async (raw: unknown, context: { credential: unknown }) =>
              diagnose('claimTask', () =>
                claimAgentBridgeTask({
                  ...(raw as Omit<Parameters<typeof claimAgentBridgeTask>[0], 'credential'>),
                  credential: context.credential as VerifiedMcpCredentialScope,
                }),
              ),
            completeTask: async (raw: unknown, context: { credential: unknown }) => {
              const input = raw as Omit<
                Parameters<typeof completeAgentBridgeTask>[0],
                'credential' | 'costE8Usd'
              > & { costE8Usd: string }
              return diagnose('completeTask', () =>
                completeAgentBridgeTask({
                  ...input,
                  costE8Usd: BigInt(input.costE8Usd),
                  credential: context.credential as VerifiedMcpCredentialScope,
                }),
              )
            },
          } as AgentBridgeHttpRegistry
          const result = await handleAgentBridgeHttpRequestCore(
            new Request(`http://127.0.0.1${request.url ?? '/'}`, {
              method: request.method ?? 'POST',
              headers: new Headers(
                Object.entries(request.headers).flatMap(([key, value]) =>
                  value === undefined
                    ? []
                    : [[key, Array.isArray(value) ? value.join(', ') : value] as [string, string]],
                ),
              ),
              body: Buffer.concat(chunks),
            }),
            { tenantId, venueId },
            { verify: verifyAgentBridgeCredential, registry, allowAttempt: () => true },
          )
          response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
          response.end(Buffer.from(await result.arrayBuffer()))
        } catch {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
        const endpoint = `http://127.0.0.1:${address.port}/agent-bridge/${tenantId}/${venueId}`
        const secret = issued.plaintextSecret!
        let interrupted: Record<string, unknown>
        try {
          interrupted = await runFreshProcess({ endpoint, secret, venueId, phase: 'INTERRUPT' })
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : 'Fresh interrupt failed'}; server=${JSON.stringify(latestServerDiagnostic)}`,
          )
        }
        expect(interrupted).toMatchObject({ phase: 'INTERRUPT', runId: run.id })
        await expect(
          db.agentRun.update({
            where: { id: run.id },
            data: { executionBridgeSessionId: null },
          }),
        ).rejects.toBeTruthy()
        const liveReplacementSessionId = randomUUID()
        const liveReplacementRegistration = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            method: 'register',
            params: {
              sessionId: liveReplacementSessionId,
              venueId,
              provider: 'CODEX_SUBSCRIPTION',
              label: 'Live-owner replacement negative control',
              runnerVersion: 'deterministic-fresh-process-adapter/1',
              supportedModels: ['subscription-default'],
            },
          }),
        })
        expect(liveReplacementRegistration.status).toBe(200)
        await expect(
          db.agentRun.update({
            where: { id: run.id },
            data: { executionBridgeSessionId: liveReplacementSessionId },
          }),
        ).rejects.toBeTruthy()
        const question = await askAgentQuestionAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          agentRunId: run.id,
          question: 'What is the approved visitor capacity?',
          category: 'venue.capacity',
          blocking: true,
        })
        await expect(
          db.agentRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { status: true, executionBridgeSessionId: true },
          }),
        ).resolves.toEqual({
          status: 'AWAITING_INPUT',
          executionBridgeSessionId: interrupted.sessionId,
        })
        const answered = await answerAgentQuestionAction({
          tenantId,
          venueId,
          questionId: question.question.id,
          expectedUpdatedAt: question.question.updatedAt,
          outcome: 'ANSWERED',
          answer: 'The approved visitor capacity is exactly 137.',
          actor: { actorType: 'HUMAN', actorId: actor.id, auditRole: 'PLATFORM_ADMIN' },
        })
        expect(answered).toMatchObject({
          questionId: question.question.id,
          status: 'ANSWERED',
          runEligibleToResume: true,
          replayed: false,
        })
        await expect(
          db.agentRun.findUniqueOrThrow({
            where: { id: run.id },
            select: {
              status: true,
              executionBridgeSessionId: true,
              executionLeaseToken: true,
              executionLeaseExpiresAt: true,
            },
          }),
        ).resolves.toEqual({
          status: 'QUEUED',
          executionBridgeSessionId: null,
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
        })
        const staleCompletion = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            method: 'completeTask',
            params: {
              sessionId: interrupted.sessionId,
              venueId,
              runId: run.id,
              leaseToken: interrupted.leaseToken,
              summary: 'Stale process must not complete.',
              artifacts: [],
              modelName: 'subscription-default',
              costE8Usd: '0',
              costStatus: 'UNREPORTED',
            },
          }),
        })
        expect(staleCompletion.status).toBe(409)
        let replacement: Record<string, unknown>
        try {
          replacement = await runFreshProcess({ endpoint, secret, venueId, phase: 'REPLACE' })
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : 'Fresh replacement failed'}; server=${JSON.stringify(latestServerDiagnostic)}`,
          )
        }
        expect(replacement).toMatchObject({
          phase: 'REPLACE',
          runId: run.id,
          attemptNumber: 2,
          derivedCapacity: '137',
        })
        expect(replacement.processId).not.toBe(interrupted.processId)
        const evidence = await db.agentRun.findUniqueOrThrow({
          where: { id: run.id },
          select: {
            status: true,
            attemptNumber: true,
            artifacts: true,
            timelineEvents: { select: { eventType: true }, orderBy: { createdAt: 'asc' } },
          },
        })
        expect(evidence).toMatchObject({
          status: 'COMPLETED',
          attemptNumber: 2,
          artifacts: [
            {
              type: 'markdown',
              title: 'Deterministic fixture draft',
              content: 'DRAFT_FROM_PERSISTED_ANSWER: capacity 137',
            },
          ],
        })
        expect(evidence.timelineEvents.map((event) => event.eventType)).toEqual(
          expect.arrayContaining(['EXECUTION_CLAIMED', 'EXECUTION_COMPLETED']),
        )
        const proof = {
          executionSurface: 'actual OS process replacement with deterministic protocol adapter',
          runId: run.id,
          questionId: question.question.id,
          firstProcessId: interrupted.processId,
          replacementProcessId: replacement.processId,
          processRestartObserved: replacement.processId !== interrupted.processId,
          leaseExpiryAcceleratedByFixture: false,
          providerInferenceCalled: false,
          artifactState: evidence.status,
          blockedStatusObserved: 'AWAITING_INPUT',
          answeredStatusObserved: answered.status,
          derivedCapacity: replacement.derivedCapacity,
        }
        expect(proof).toMatchObject({
          processRestartObserved: true,
          leaseExpiryAcceleratedByFixture: false,
          providerInferenceCalled: false,
          artifactState: 'COMPLETED',
          blockedStatusObserved: 'AWAITING_INPUT',
          answeredStatusObserved: 'ANSWERED',
          derivedCapacity: '137',
        })
        process.stdout.write(`${JSON.stringify({ agentBridgeFreshProcessProof: proof })}\n`)
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    })
  }, 45_000)
})
