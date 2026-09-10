import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { resolve as resolvePath } from 'node:path'

import {
  activateAgentBridgeCredentialAction,
  answerAgentQuestionAction,
  configureIntakeSourceAgentRouting,
  db,
  dispatchIntakeSourceAgentTask,
  issueExternalCredentialAction,
  registerAgentBridgeSession,
  registerAgentWorkerAction,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import {
  createAgentBridgeRegistry,
  handleAgentBridgeHttpRequest,
} from '@pathfinder/api/agent-bridge'
import { createPathfinderMcpAgentActions } from '@pathfinder/api/mcp/agent-actions'
import { readMcpResource } from '@pathfinder/api/mcp/read-actions'
import {
  createPathfinderMcpRegistry,
  type PathfinderMcpDomainActions,
} from '@pathfinder/api/mcp/registry'

type ConnectedSourceWorkerInput = {
  tenantId: string
  venueId: string
  actorId: string
  intakeRunId: string
  receiptId: string
  extractedTextHash: string
  sourceText: string
}

export type ConnectedSourceWorkerProof = {
  agentIdentityId: string
  agentRunId: string
  workerId: string
  questionId: string
  resolutionId: string
  amendmentDigest: string
  initialAttemptNumber: number
  resumedAttemptNumber: number
  serverStopped: true
}

const capabilities = [
  'agent-runs:execute',
  'intake-source:read',
  'intake:draft',
  'questions:ask',
  'resources:read',
] as const

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Drives one extracted fixture source through the registered worker contract. This helper
 * performs no inference or provider call; its deterministic question and answer stand in for
 * those two decisions while admission, source reads, question persistence and amendment writes
 * use the production bridge actions.
 */
export async function runConnectedSourceWorker(
  input: ConnectedSourceWorkerInput,
): Promise<ConnectedSourceWorkerProof> {
  if (
    process.env.RUN_ONBOARDING_CONNECTED_SOURCE_WORKER !== '1' ||
    !/\/pathfinder_disposable_onboarding_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')
  )
    throw new Error('Connected source worker requires the guarded disposable onboarding mode')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const scope = { tenantId: input.tenantId, venueId: input.venueId }
  const identityId = `connected-source-${suffix}`
  const bridgeSessionId = randomUUID()

  if (sha256(input.sourceText) !== input.extractedTextHash)
    throw new Error('Connected source text does not match the retained extraction hash')

  const dispatch = await withTenantIsolationBypass(() =>
    db.intakeSourceAgentDispatch.findFirstOrThrow({
      where: {
        ...scope,
        intakeRunId: input.intakeRunId,
        receiptId: input.receiptId,
        extractedTextHash: input.extractedTextHash,
      },
      select: { id: true },
    }),
  )

  await withTenantIsolationBypass(() =>
    db.agentIdentity.create({
      data: {
        id: identityId,
        ...scope,
        identityKey: `connected.source.${suffix}`,
        name: 'Connected source review specialist',
        defaultProvider: 'codex-bridge',
        defaultModel: 'subscription-default',
        agentType: 'CONTENT',
        accessScope: 'VENUE',
        accessCapabilities: ['intake.read', 'content.draft'],
        autonomyLevel: 'DRAFT',
        autonomousActions: ['content.prepare-draft'],
        enabled: true,
        createdBy: input.actorId,
      },
    }),
  )
  const routing = await configureIntakeSourceAgentRouting(
    { ...scope, agentIdentityId: identityId, expectedRevision: 0, enabled: true },
    input.actorId,
  )
  if (!routing.policy.enabled || routing.policy.agentIdentityId !== identityId)
    throw new Error('Connected source routing was not enabled for the fixture identity')

  const actor = { type: 'HUMAN' as const, id: input.actorId, role: 'PLATFORM_ADMIN' as const }
  const issued = await issueExternalCredentialAction({
    operationId: randomUUID(),
    tenantId: input.tenantId,
    clientId: input.tenantId,
    venueId: input.venueId,
    actor,
    kind: 'MCP',
    label: 'Connected source review fixture credential',
    capabilities: [...capabilities],
    expiresAt: new Date(Date.now() + 60 * 60_000),
  })
  if (!issued.plaintextSecret) throw new Error('Connected source credential secret unavailable')
  await activateAgentBridgeCredentialAction({
    operationId: randomUUID(),
    tenantId: input.tenantId,
    clientId: input.tenantId,
    venueId: input.venueId,
    credentialId: issued.credential.id,
    expectedUpdatedAt: issued.credential.updatedAt,
    actor,
  })
  const credential = await verifyAgentBridgeCredential({
    ...scope,
    plaintext: issued.plaintextSecret,
  })
  const worker = await registerAgentWorkerAction(
    {
      workerKey: `connected-source-${suffix}`,
      runtimeType: 'CODEX',
      label: 'Connected source review fixture worker',
      protocolVersion: 'mcp-2026-07-28',
      softwareVersion: 'connected-proof/1',
      capabilities: [...capabilities],
      agentRoles: ['CONTENT'],
      safeHealth: {},
    },
    credential,
  )
  await registerAgentBridgeSession({
    sessionId: bridgeSessionId,
    venueId: input.venueId,
    provider: 'CODEX_SUBSCRIPTION',
    label: 'Connected source review fixture session',
    runnerVersion: 'connected-proof/1',
    supportedModels: ['subscription-default'],
    credential,
  })

  const dispatched = await dispatchIntakeSourceAgentTask({ id: dispatch.id, ...scope })
  if (dispatched.status !== 'COMPLETED' || !dispatched.runId)
    throw new Error(`Connected source task was not dispatched: ${dispatched.status}`)
  const agentRunId = dispatched.runId
  const operationalRegistry = createPathfinderMcpRegistry(
    createPathfinderMcpAgentActions(db, {
      read: (request, context) => readMcpResource(db as never, request, context),
    } as Omit<PathfinderMcpDomainActions, 'askOperator' | 'delegateSpecialist'>),
  )
  const bridge = createAgentBridgeRegistry({ operationalRegistry })
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value)
      const result = await handleAgentBridgeHttpRequest(
        new Request('http://127.0.0.1/bridge', {
          method: request.method,
          headers,
          body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
          duplex: 'half',
        } as RequestInit),
        scope,
        { registry: bridge },
      )
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
      response.end(Buffer.from(await result.arrayBuffer()))
    } catch {
      response.writeHead(500)
      response.end('connected-source-worker-failure')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected owned loopback port')
  const url = `http://127.0.0.1:${address.port}/bridge`
  type WorkerResult = {
    pid: number
    runId: string
    attemptNumber: number
    questionId: string
    answer?: string
    sourceHash: string
    capacityRead: boolean
    resolutionId?: string
  }
  const sourceQuestion = {
    excerptPrefix: 'The fictional North Gallery auditorium capacity',
    question: 'Please confirm that the approved visitor capacity is exactly 137.',
    fieldPath: 'visitor.capacity',
    rationale: 'The retained answer confirms the current auditorium capacity for human review.',
    reason: 'DATE_SENSITIVE',
  }
  const runWorker = (mode: 'ask' | 'resume') =>
    new Promise<WorkerResult>((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
      for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
        if (process.env[key]) childEnv[key] = process.env[key]
      const child = spawn(
        process.execPath,
        [resolvePath(process.cwd(), '../../scripts/fixtures/source-question-http-worker.mjs')],
        { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill(), 30_000)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.length > 16_000) child.kill()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(
            new Error(
              `Connected source worker ${mode} exited ${code}: ${stderr.replaceAll(issued.plaintextSecret!, '[redacted]')}`,
            ),
          )
          return
        }
        try {
          resolve(JSON.parse(stdout) as WorkerResult)
        } catch {
          reject(new Error('Connected source worker returned invalid bounded JSON'))
        }
      })
      child.stdin.end(
        JSON.stringify({
          url,
          mode,
          token: issued.plaintextSecret,
          sessionId: bridgeSessionId,
          venueId: input.venueId,
          workerKey: `connected-source-${suffix}`,
          workerId: worker.id,
          identityId,
          sourceQuestion,
        }),
      )
    })
  let firstWorker: WorkerResult
  let resumedWorker: WorkerResult
  let question!: { id: string; updatedAt: Date }
  try {
    firstWorker = await runWorker('ask')
    if (
      firstWorker.runId !== agentRunId ||
      firstWorker.sourceHash !== input.extractedTextHash ||
      !firstWorker.capacityRead
    )
      throw new Error('Connected source worker returned mismatched first-attempt identity')
    question = await withTenantIsolationBypass(() =>
      db.agentQuestion.findFirstOrThrow({
        where: {
          id: firstWorker.questionId,
          ...scope,
          agentRunId,
          agentIdentityId: identityId,
        },
        select: { id: true, updatedAt: true },
      }),
    )
    const founderAnswer = 'Confirmed: the approved visitor capacity is exactly 137.'
    await answerAgentQuestionAction({
      ...scope,
      questionId: question.id,
      expectedUpdatedAt: question.updatedAt,
      outcome: 'ANSWERED',
      answer: founderAnswer,
      actor: { actorType: 'HUMAN', actorId: input.actorId, auditRole: 'PLATFORM_ADMIN' },
    })

    resumedWorker = await runWorker('resume')
    if (
      resumedWorker.pid === firstWorker.pid ||
      resumedWorker.runId !== agentRunId ||
      resumedWorker.questionId !== question.id ||
      resumedWorker.answer !== founderAnswer ||
      resumedWorker.sourceHash !== input.extractedTextHash ||
      !resumedWorker.capacityRead ||
      !resumedWorker.resolutionId
    )
      throw new Error('Connected source worker returned mismatched resumed identity')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  const resolution = await withTenantIsolationBypass(() =>
    db.intakeFileClarificationResolution.findFirstOrThrow({
      where: {
        id: resumedWorker.resolutionId!,
        ...scope,
        questionId: question.id,
        receiptId: input.receiptId,
        runId: input.intakeRunId,
        expectedExtractedTextHash: input.extractedTextHash,
      },
      select: {
        id: true,
        receiptId: true,
        questionId: true,
        kind: true,
        amendedExcerpt: true,
        createdBy: true,
      },
    }),
  )
  if (resolution.createdBy !== identityId)
    throw new Error('Connected source amendment has the wrong author identity')

  return {
    agentIdentityId: identityId,
    agentRunId,
    workerId: worker.id,
    questionId: question.id,
    resolutionId: resolution.id,
    amendmentDigest: sha256(JSON.stringify(resolution)),
    initialAttemptNumber: firstWorker.attemptNumber,
    resumedAttemptNumber: resumedWorker.attemptNumber,
    serverStopped: !server.listening,
  }
}
