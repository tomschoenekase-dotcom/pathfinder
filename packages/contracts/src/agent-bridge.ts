import { z } from 'zod'

import { AgentConfigurationAutonomyLevel } from './agent-identity'

const Id = z.string().trim().min(1).max(191)

export const AgentBridgeProvider = z.enum([
  'HERMES',
  'CLAUDE_SUBSCRIPTION',
  'CODEX_SUBSCRIPTION',
  'OPENAI_COMPATIBLE',
])
export type AgentBridgeProvider = z.infer<typeof AgentBridgeProvider>

export const AgentBridgeModelProvider = z.enum([
  'hermes-bridge',
  'claude-bridge',
  'codex-bridge',
  'openai-compatible-bridge',
])
export type AgentBridgeModelProvider = z.infer<typeof AgentBridgeModelProvider>

export const AGENT_BRIDGE_MODEL_PROVIDER = {
  HERMES: 'hermes-bridge',
  CLAUDE_SUBSCRIPTION: 'claude-bridge',
  CODEX_SUBSCRIPTION: 'codex-bridge',
  OPENAI_COMPATIBLE: 'openai-compatible-bridge',
} as const satisfies Record<AgentBridgeProvider, AgentBridgeModelProvider>

export const AgentCostStatus = z.enum(['UNREPORTED', 'ESTIMATED', 'EXACT'])
export type AgentCostStatus = z.infer<typeof AgentCostStatus>

export const AgentRunFailureCode = z.enum([
  'AGENT_EXECUTION_FAILED',
  'CANCELLED_OR_LEASE_LOST',
  'CAPABILITY_MISMATCH',
  'CAPABILITY_NOT_ENTITLED',
  'CAPABILITY_UNAVAILABLE',
  'NO_HEALTHY_ROUTE',
  'PROVIDER_CONFIGURATION_REQUIRED',
  'PROVIDER_CONNECTION_FAILED',
  'PROVIDER_INVALID_RESPONSE',
  'PROVIDER_REQUEST_ABORTED',
  'PROVIDER_REQUEST_FAILED',
  'PROVIDER_UNAVAILABLE',
  'REQUEST_BUDGET_CEILING_EXCEEDED',
  'TASK_CANCELLED',
  'TASK_ERROR_OUTPUT_TOO_LARGE',
  'TASK_EXECUTOR_EMPTY_RESULT',
  'TASK_EXECUTOR_FAILED',
  'TASK_EXECUTOR_INVALID_RESULT',
  'TASK_EXECUTOR_UNAVAILABLE',
  'TASK_OUTPUT_TOO_LARGE',
  'TASK_PROVIDER_MISMATCH',
  'TASK_TIMEOUT',
  'TASK_VENUE_MISMATCH',
  'TIMEOUT',
])
export type AgentRunFailureCode = z.infer<typeof AgentRunFailureCode>

export const AgentBridgeTask = z
  .object({
    id: Id,
    operationId: z.string().uuid().nullable(),
    venueId: Id,
    runType: z.string().trim().min(1).max(100),
    requestedOperation: Id,
    prompt: z.string().trim().min(1).max(10_000).nullable(),
    modelProvider: AgentBridgeModelProvider,
    modelName: z.string().trim().min(1).max(191).nullable(),
    leaseToken: z.string().uuid(),
    leaseExpiresAt: z.string().datetime(),
    attemptNumber: z.number().int().positive(),
    scope: z.record(z.unknown()),
    initiator: z
      .object({
        type: z.enum(['HUMAN', 'AGENT', 'SYSTEM', 'INTEGRATION']),
        id: Id,
      })
      .strict(),
    agent: z
      .object({
        identityKey: z.string().trim().min(1).max(100),
        name: Id,
        description: z.string().trim().max(2_000).nullable(),
        accessCapabilities: z.array(z.string().trim().min(1).max(191)).max(100),
        autonomyLevel: AgentConfigurationAutonomyLevel,
        autonomousActions: z.array(z.string().trim().min(1).max(191)).max(100),
      })
      .strict(),
  })
  .strict()
export type AgentBridgeTask = z.infer<typeof AgentBridgeTask>

export const AgentBridgeClaimResult = z.object({ task: AgentBridgeTask.nullable() }).strict()
export type AgentBridgeClaimResult = z.infer<typeof AgentBridgeClaimResult>

export const AgentBridgeExecutionResult = z
  .object({
    content: z.string().trim().min(1).max(100_000),
    modelName: z.string().trim().min(1).max(191),
    costE8Usd: z.string().regex(/^\d{1,30}$/u),
    costStatus: AgentCostStatus,
  })
  .strict()
export type AgentBridgeExecutionResult = z.infer<typeof AgentBridgeExecutionResult>
