import { z } from 'zod'

import { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import {
  AgentBridgeProvider,
  AgentCostStatus,
  AgentRunFailureCode,
} from '@pathfinder/contracts/agent-bridge'
import {
  claimAgentBridgeTask,
  cancelCharacterFactoryJobAction,
  claimCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  failCharacterFactoryJobAction,
  heartbeatCharacterFactoryJobAction,
  completeAgentBridgeTask,
  failAgentBridgeTask,
  heartbeatAgentBridgeSession,
  heartbeatAgentBridgeTask,
  heartbeatAgentWorkerAction,
  prepareCharacterFactoryJobAction,
  readCharacterFactoryJobAction,
  submitCharacterCandidateReviewBrief,
  readCharacterCandidateReviewBrief,
  listAgentWorkerHealth,
  registerAgentWorkerAction,
  registerAgentBridgeSession,
} from '@pathfinder/db'
import {
  beginCharacterArtifactUpload,
  createCharacterArtifactStorage,
} from '../lib/character-artifact-storage'

import { createProspectAgentRegistry } from '../prospect-agent/registry'
import { createSafeOperationalMcpRegistry } from '../mcp/composition'
import { McpExecutionClaim } from '../mcp/execution-claim'

const sessionScope = z
  .object({
    sessionId: z.string().uuid(),
    venueId: z.string().trim().min(1).max(191),
  })
  .strict()
const artifact = z
  .object({
    type: z.enum(['markdown', 'text', 'json']),
    title: z.string().trim().min(1).max(200),
    content: z.string().max(100_000),
  })
  .strict()

export type VerifiedAgentBridgeContext = Readonly<{
  credential: z.infer<typeof VerifiedMcpCredentialScope>
}>

type OperationalRegistry = ReturnType<typeof createSafeOperationalMcpRegistry>

function assertCharacterFactoryScope(
  credential: z.infer<typeof VerifiedMcpCredentialScope>,
  venueId: string,
) {
  if (
    credential.tenantId !== credential.clientId ||
    !credential.venueIds.includes(venueId) ||
    !credential.capabilities.includes('characters:build')
  ) {
    throw new Error('Character factory requires exact tenant, venue, and characters:build scope')
  }
}

function assertCharacterExecutorScope(
  credential: z.infer<typeof VerifiedMcpCredentialScope>,
  venueId: string,
) {
  if (
    credential.tenantId !== credential.clientId ||
    !credential.venueIds.includes(venueId) ||
    !credential.capabilities.includes('characters:execute')
  )
    throw new Error(
      'Character execution requires exact tenant, venue, and characters:execute scope',
    )
}

/** Transport-neutral authenticated bridge service. An HTTP/MCP transport must
 * verify the machine secret and construct the credential context before call. */
export function createAgentBridgeRegistry(
  dependencies: Readonly<{ operationalRegistry?: OperationalRegistry }> = {},
) {
  const prospectRegistry = createProspectAgentRegistry()
  let operationalRegistry = dependencies.operationalRegistry
  const operational = () => (operationalRegistry ??= createSafeOperationalMcpRegistry())
  return {
    listCharacterFactoryActions: (raw: unknown, rawContext: unknown) => {
      z.object({}).strict().parse(raw)
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      if (!context.credential.capabilities.includes('characters:build'))
        throw new Error('Character factory requires characters:build')
      return {
        capability: 'characters:build',
        actions: ['CREATE_FROM_IMPORT', 'REVISE', 'INSPECT', 'PREVIEW', 'VALIDATE', 'EXPORT'],
        lifecycle: [
          'prepareCharacterFactoryJob',
          'getCharacterFactoryJob',
          'cancelCharacterFactoryJob',
          'submitCharacterCandidateReview',
          'readCharacterCandidateReview',
        ],
        executorLifecycle: ['beginCharacterArtifactUpload', 'completeCharacterFactoryJob'],
      }
    },
    prepareCharacterFactoryJob: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
          action: z.enum([
            'CREATE_FROM_IMPORT',
            'REVISE',
            'INSPECT',
            'PREVIEW',
            'VALIDATE',
            'EXPORT',
          ]),
          requestPayload: z.record(z.unknown()),
          characterId: z.string().trim().min(1).max(191).optional(),
          baseVersion: z.number().int().positive().optional(),
          baseRevision: z.number().int().positive().optional(),
        })
        .strict()
        .parse(raw)
      assertCharacterFactoryScope(context.credential, input.venueId)
      return prepareCharacterFactoryJobAction({
        tenantId: context.credential.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        action: input.action,
        requestPayload: input.requestPayload,
        actor: { id: context.credential.credentialId, role: 'AGENT', type: 'AGENT' },
        ...(input.characterId === undefined ? {} : { characterId: input.characterId }),
        ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
        ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
      })
    },
    submitCharacterCandidateReview: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          characterId: z.string().trim().min(1).max(191),
          brief: z.string().trim().min(1).max(4_000),
          rationale: z.string().trim().min(1).max(2_000),
          sourceProvenance: z.enum(['GENERATED', 'IMPORTED', 'IMPORTED_FIXTURE']),
        })
        .strict()
        .parse(raw)
      assertCharacterFactoryScope(context.credential, input.venueId)
      return submitCharacterCandidateReviewBrief({
        tenantId: context.credential.tenantId,
        ...input,
        actor: { id: context.credential.credentialId, role: 'AGENT', type: 'AGENT' },
      })
    },
    readCharacterCandidateReview: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          briefId: z.string().trim().min(1).max(191),
        })
        .strict()
        .parse(raw)
      assertCharacterFactoryScope(context.credential, input.venueId)
      return readCharacterCandidateReviewBrief({
        tenantId: context.credential.tenantId,
        venueId: input.venueId,
        briefId: input.briefId,
      })
    },
    getCharacterFactoryJob: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
        })
        .strict()
        .parse(raw)
      assertCharacterFactoryScope(context.credential, input.venueId)
      return readCharacterFactoryJobAction({
        tenantId: context.credential.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
      })
    },
    cancelCharacterFactoryJob: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
        })
        .strict()
        .parse(raw)
      assertCharacterFactoryScope(context.credential, input.venueId)
      return cancelCharacterFactoryJobAction({
        tenantId: context.credential.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        actor: { id: context.credential.credentialId, role: 'AGENT', type: 'AGENT' },
      })
    },
    claimCharacterFactoryJob: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
        })
        .strict()
        .parse(raw)
      assertCharacterExecutorScope(context.credential, input.venueId)
      return claimCharacterFactoryJobAction({ tenantId: context.credential.tenantId, ...input })
    },
    heartbeatCharacterFactoryJob: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
          leaseToken: z.string().uuid(),
        })
        .strict()
        .parse(raw)
      assertCharacterExecutorScope(context.credential, input.venueId)
      return heartbeatCharacterFactoryJobAction({ tenantId: context.credential.tenantId, ...input })
    },
    beginCharacterArtifactUpload: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          characterId: z.string().trim().min(1).max(191),
          characterVersion: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          byteLength: z.number().int().positive().max(12_000_000),
        })
        .strict()
        .parse(raw)
      assertCharacterExecutorScope(context.credential, input.venueId)
      return beginCharacterArtifactUpload({ tenantId: context.credential.tenantId, ...input })
    },
    completeCharacterFactoryJob: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
          leaseToken: z.string().uuid(),
          resultPayload: z.record(z.unknown()),
          characterSpec: z.unknown().optional(),
          assetStorageReference: z.unknown().optional(),
        })
        .strict()
        .parse(raw)
      assertCharacterExecutorScope(context.credential, input.venueId)
      return completeCharacterFactoryJobAction(
        {
          tenantId: context.credential.tenantId,
          venueId: input.venueId,
          requestId: input.requestId,
          leaseToken: input.leaseToken,
          resultPayload: input.resultPayload,
          actor: { id: context.credential.credentialId, role: 'AGENT', type: 'AGENT' },
          ...(input.characterSpec === undefined ? {} : { characterSpec: input.characterSpec }),
          ...(input.assetStorageReference === undefined
            ? {}
            : { assetStorageReference: input.assetStorageReference }),
        },
        undefined,
        {
          verifyArtifact: async ({ tenantId, venueId, reference, expectedSpec }) => {
            const verified = await createCharacterArtifactStorage().getVerified({
              tenantId,
              venueId,
              reference,
              expectedSpec,
            })
            return {
              reference: verified.reference,
              spec: verified.spec,
              ...(verified.runtimePack === undefined ? {} : { runtimePack: verified.runtimePack }),
            }
          },
        },
      )
    },
    failCharacterFactoryJob: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191),
          requestId: z.string().trim().min(1).max(191),
          leaseToken: z.string().uuid(),
          errorCode: z.string().trim().min(1).max(100),
          errorMessage: z.string().trim().min(1).max(1000),
        })
        .strict()
        .parse(raw)
      assertCharacterExecutorScope(context.credential, input.venueId)
      return failCharacterFactoryJobAction({
        tenantId: context.credential.tenantId,
        ...input,
        actor: { id: context.credential.credentialId, role: 'AGENT', type: 'AGENT' },
      })
    },
    registerWorker: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          workerKey: z.string().trim().min(1).max(191),
          runtimeType: z.enum(['HERMES', 'CODEX', 'CLAUDE', 'OPENAI_COMPATIBLE', 'CUSTOM']),
          label: z.string().trim().min(1).max(200),
          protocolVersion: z.string().trim().min(1).max(100),
          softwareVersion: z.string().trim().min(1).max(100),
          capabilities: z.array(z.string().trim().min(1).max(191)).max(100),
          agentRoles: z.array(z.string().trim().min(1).max(191)).max(50),
          modelProvider: z.string().trim().min(1).max(100).optional(),
          modelName: z.string().trim().min(1).max(191).optional(),
          safeHealth: z.record(z.unknown()).default({}),
        })
        .strict()
        .parse(raw)
      return registerAgentWorkerAction(input, context.credential)
    },
    heartbeatWorker: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          workerKey: z.string().trim().min(1).max(191),
          safeHealth: z.record(z.unknown()).default({}),
        })
        .strict()
        .parse(raw)
      return heartbeatAgentWorkerAction(input, context.credential)
    },
    listWorkers: (raw: unknown, rawContext: unknown) => {
      z.object({}).strict().parse(raw)
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      if (!context.credential.capabilities.includes('workers:read')) {
        throw new Error('Worker health requires workers:read')
      }
      return listAgentWorkerHealth({ clientId: context.credential.clientId })
    },
    listOperationalTools: (_raw: unknown, rawContext: unknown) => {
      z.object({}).strict().parse(_raw)
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const granted = new Set(context.credential.capabilities)
      return operational()
        .listTools()
        .filter((definition) => {
          const required = definition._meta['com.pathfinder/security'].capability
          return (
            granted.has(required) ||
            (definition.name === 'pathfinder.read' && granted.has('resources:read'))
          )
        })
    },
    callOperationalTool: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191).optional(),
          toolName: z.string().trim().min(1).max(191),
          arguments: z.record(z.unknown()),
          executionClaim: McpExecutionClaim.optional(),
        })
        .strict()
        .parse(raw)
      if (input.venueId && !context.credential.venueIds.includes(input.venueId))
        throw new Error('Operational tools require exact credential venue scope')
      const questionSource =
        (input.toolName === 'pathfinder.read' &&
          ['question-source', 'assigned-source'].includes(input.arguments.resource as string)) ||
        (input.toolName === 'pathfinder.ask_operator' &&
          input.arguments.sourceClarification !== undefined) ||
        input.toolName === 'pathfinder.resolve_source_clarification'
      if (
        questionSource &&
        (!input.venueId ||
          !input.executionClaim ||
          input.executionClaim.agentRunId !== input.arguments.agentRunId ||
          context.credential.tenantId !== context.credential.clientId ||
          !context.credential.capabilities.includes('agent-runs:execute'))
      )
        throw new Error('Question source requires an exact worker execution claim')
      if (!questionSource && input.executionClaim)
        throw new Error('Execution claim is only supported for question source operations')
      return operational().callTool(
        input.toolName,
        {
          ...input.arguments,
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
        },
        {
          ...context,
          ...(input.executionClaim ? { executionClaim: input.executionClaim } : {}),
        },
      )
    },
    register: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = sessionScope
        .extend({
          provider: AgentBridgeProvider,
          label: z.string().trim().min(1).max(200),
          runnerVersion: z.string().trim().min(1).max(100),
          supportedModels: z.array(z.string().trim().min(1).max(191)).max(50),
        })
        .parse(raw)
      return registerAgentBridgeSession({ ...input, credential: context.credential })
    },
    heartbeatSession: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      return heartbeatAgentBridgeSession({
        ...sessionScope.parse(raw),
        credential: context.credential,
      })
    },
    claimTask: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = sessionScope
        .extend({ workerKey: z.string().trim().min(1).max(191).optional() })
        .parse(raw)
      return claimAgentBridgeTask({
        sessionId: input.sessionId,
        venueId: input.venueId,
        ...(input.workerKey ? { workerKey: input.workerKey } : {}),
        credential: context.credential,
      })
    },
    heartbeatTask: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = sessionScope
        .extend({
          runId: z.string().trim().min(1).max(191),
          leaseToken: z.string().uuid(),
        })
        .parse(raw)
      return heartbeatAgentBridgeTask({ ...input, credential: context.credential })
    },
    completeTask: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = sessionScope
        .extend({
          runId: z.string().trim().min(1).max(191),
          leaseToken: z.string().uuid(),
          summary: z.string().trim().min(1).max(5_000),
          artifacts: z.array(artifact).max(25),
          modelName: z.string().trim().min(1).max(191),
          costE8Usd: z
            .string()
            .regex(/^\d{1,30}$/u)
            .transform(BigInt),
          costStatus: AgentCostStatus,
        })
        .parse(raw)
      return completeAgentBridgeTask({ ...input, credential: context.credential })
    },
    failTask: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = sessionScope
        .extend({
          runId: z.string().trim().min(1).max(191),
          leaseToken: z.string().uuid(),
          errorCode: AgentRunFailureCode,
          retryable: z.boolean(),
        })
        .parse(raw)
      return failAgentBridgeTask({ ...input, credential: context.credential })
    },
    callProspectTool: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = sessionScope
        .extend({
          runId: z.string().trim().min(1).max(191),
          leaseToken: z.string().uuid(),
          correlationId: z.string().uuid(),
          toolName: z.string().trim().min(1).max(191),
          arguments: z.unknown(),
        })
        .parse(raw)
      if (
        context.credential.tenantId !== context.credential.clientId ||
        !context.credential.venueIds.includes(input.venueId) ||
        !context.credential.capabilities.includes('agent-runs:execute')
      ) {
        throw new Error('Prospect tools require an authenticated first-party agent bridge')
      }
      return prospectRegistry.callTool(input.toolName, input.arguments, {
        tenantId: context.credential.tenantId,
        venueId: input.venueId,
        sessionId: input.sessionId,
        agentRunId: input.runId,
        leaseToken: input.leaseToken,
        credentialId: context.credential.credentialId,
        correlationId: input.correlationId,
      })
    },
  } as const
}
