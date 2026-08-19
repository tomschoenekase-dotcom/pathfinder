import { AI_MODEL_KEYS, AiGatewayError, generateText } from '@pathfinder/ai'
import {
  AgentRunExecutionError,
  assertVenueAiAvailable,
  claimAgentRunExecution,
  completeAgentRunExecution,
  db,
  failAgentRunExecution,
  heartbeatAgentRunExecution,
} from '@pathfinder/db'
import type { AgentRunJobPayload } from '@pathfinder/jobs'

import { createWorkerAiBudgetGate, createWorkerAiUsageSink } from '../lib/ai-usage'

const LEASE_DURATION_MS = 90_000
const HEARTBEAT_INTERVAL_MS = 20_000

function providerKind(provider: string | null): 'anthropic' | 'bridge' | 'missing' {
  if (!provider) return 'missing'
  if (['anthropic', 'claude', 'claude-api'].includes(provider.toLowerCase())) return 'anthropic'
  return 'bridge'
}

function systemPrompt(run: Awaited<ReturnType<typeof claimAgentRunExecution>>): string {
  return [
    `You are ${run.agentIdentity.name}, an AI specialist inside Torchiko.`,
    run.agentIdentity.description ?? '',
    `Your autonomy level is ${run.agentIdentity.autonomyLevel}.`,
    `Your allowed capabilities are: ${run.agentIdentity.accessCapabilities.join(', ') || 'none'}.`,
    run.runType === 'PRIMARY'
      ? 'You are the primary coordinator. When a connected bridge exposes pathfinder.delegate_specialist, assign bounded work to the best specialist and synthesize their evidence. If no tool is available, say which specialist should be assigned rather than pretending delegation occurred.'
      : '',
    'Complete the requested analysis or draft. Do not claim to have used tools, changed records, sent messages, or performed external actions.',
    'If the task needs a mutation, approval, credential, or missing fact, clearly describe what is needed instead of inventing success.',
    'Return a concise operator-ready result in Markdown.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Executes the safe text-work portion of an AgentRun. Tool-capable Hermes,
 * Codex, and Claude subscription sessions use the separate bridge contract;
 * they are never impersonated with server credentials or shell commands. */
export async function processAgentRunJob(payload: AgentRunJobPayload, signal?: AbortSignal) {
  const run = await claimAgentRunExecution({ ...payload, leaseDurationMs: LEASE_DURATION_MS })
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason ?? new Error('Agent job cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  const heartbeat = setInterval(() => {
    void heartbeatAgentRunExecution({
      tenantId: payload.tenantId,
      runId: payload.runId,
      leaseToken: run.leaseToken,
      leaseDurationMs: LEASE_DURATION_MS,
    })
      .then((state) => {
        if (state.cancelRequested) controller.abort(new Error('Agent run cancellation requested'))
      })
      .catch(() => controller.abort(new Error('Agent execution lease was lost')))
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  try {
    if (!run.venueId) throw new Error('Agent execution requires an exact venue scope')
    const kind = providerKind(run.modelProvider)
    if (kind !== 'anthropic') {
      const provider = run.modelProvider ?? 'unconfigured'
      const error = new Error(
        kind === 'missing'
          ? 'No execution provider is configured for this specialist'
          : `Provider ${provider} requires a connected Torchiko agent bridge`,
      )
      error.name = 'AgentProviderConfigurationError'
      throw error
    }
    const result = await generateText({
      modelKey: AI_MODEL_KEYS.AGENT_RUN,
      system: [{ type: 'text', text: systemPrompt(run) }],
      messages: [{ role: 'user', content: run.requestPrompt ?? run.requestedOperation }],
      maxOutputTokens: 1_800,
      maxAttempts: 1,
      signal: controller.signal,
      admissionGuard: () =>
        assertVenueAiAvailable(db, { tenantId: run.tenantId, venueId: run.venueId! }),
      usageSink: createWorkerAiUsageSink({
        tenantId: run.tenantId,
        venueId: run.venueId,
        feature: 'agent-run',
      }),
      budgetGate: createWorkerAiBudgetGate({
        tenantId: run.tenantId,
        venueId: run.venueId,
        feature: 'agent-run',
      }),
    })
    const costE8Usd = BigInt(Math.max(0, Math.round(result.estimatedCostUsd * 100_000_000)))
    return await completeAgentRunExecution({
      tenantId: run.tenantId,
      runId: run.id,
      leaseToken: run.leaseToken,
      summary: result.text.slice(0, 5_000),
      artifacts: [{ type: 'markdown', title: 'Agent result', content: result.text }],
      modelProvider: result.provider,
      modelName: result.model,
      costE8Usd,
    })
  } catch (error) {
    const configurationError =
      error instanceof Error && error.name === 'AgentProviderConfigurationError'
    const cancellation = controller.signal.aborted
    const errorCode = cancellation
      ? 'CANCELLED_OR_LEASE_LOST'
      : configurationError
        ? 'PROVIDER_CONFIGURATION_REQUIRED'
        : error instanceof AiGatewayError
          ? error.code
          : 'AGENT_EXECUTION_FAILED'
    const failureState = await failAgentRunExecution({
      tenantId: run.tenantId,
      runId: run.id,
      leaseToken: run.leaseToken,
      errorCode,
      errorMessage: error instanceof Error ? error.message : 'Unknown agent execution failure',
      retryable: !configurationError && !cancellation,
    }).catch((failure) => {
      if (failure instanceof AgentRunExecutionError && failure.code === 'LEASE_LOST') return null
      throw failure
    })
    if (failureState?.status === 'QUEUED') throw error
    return failureState
  } finally {
    clearInterval(heartbeat)
    signal?.removeEventListener('abort', abort)
  }
}
