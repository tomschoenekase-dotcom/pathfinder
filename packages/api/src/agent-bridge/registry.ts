import { z } from 'zod'

import { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import {
  claimAgentBridgeTask,
  completeAgentBridgeTask,
  failAgentBridgeTask,
  heartbeatAgentBridgeSession,
  heartbeatAgentBridgeTask,
  heartbeatAgentWorkerAction,
  listAgentWorkerHealth,
  registerAgentWorkerAction,
  registerAgentBridgeSession,
} from '@pathfinder/db'

import { createProspectAgentRegistry } from '../prospect-agent/registry'
import { createSafeOperationalMcpRegistry } from '../mcp/composition'

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

/** Transport-neutral authenticated bridge service. An HTTP/MCP transport must
 * verify the machine secret and construct the credential context before call. */
export function createAgentBridgeRegistry(
  dependencies: Readonly<{ operationalRegistry?: OperationalRegistry }> = {},
) {
  const prospectRegistry = createProspectAgentRegistry()
  let operationalRegistry = dependencies.operationalRegistry
  const operational = () => (operationalRegistry ??= createSafeOperationalMcpRegistry())
  return {
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
      z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      return operational().listTools()
    },
    callOperationalTool: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = z
        .object({
          venueId: z.string().trim().min(1).max(191).optional(),
          toolName: z.string().trim().min(1).max(191),
          arguments: z.record(z.unknown()),
        })
        .strict()
        .parse(raw)
      if (input.venueId && !context.credential.venueIds.includes(input.venueId))
        throw new Error('Operational tools require exact credential venue scope')
      return operational().callTool(
        input.toolName,
        {
          ...input.arguments,
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
        },
        context,
      )
    },
    register: (raw: unknown, rawContext: unknown) => {
      const context = z.object({ credential: VerifiedMcpCredentialScope }).parse(rawContext)
      const input = sessionScope
        .extend({
          provider: z.enum([
            'HERMES',
            'CLAUDE_SUBSCRIPTION',
            'CODEX_SUBSCRIPTION',
            'OPENAI_COMPATIBLE',
          ]),
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
          errorCode: z.string().trim().min(1).max(100),
          errorMessage: z.string().trim().min(1).max(5_000),
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
