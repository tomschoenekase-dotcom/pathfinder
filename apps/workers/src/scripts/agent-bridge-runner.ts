import { parseAgentBridgeRunnerConfig, runAgentBridge } from '../lib/agent-bridge-runner'

function integer(value: string | undefined, fallback: number) {
  return value ? Number.parseInt(value, 10) : fallback
}

function commaSeparated(value: string | undefined) {
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
}

async function main() {
  const config = parseAgentBridgeRunnerConfig({
    endpoint: process.env.TORCHIKO_AGENT_BRIDGE_URL,
    secret: process.env.TORCHIKO_AGENT_BRIDGE_SECRET,
    venueId: process.env.TORCHIKO_AGENT_BRIDGE_VENUE_ID,
    provider: process.env.TORCHIKO_AGENT_BRIDGE_PROVIDER,
    label: process.env.TORCHIKO_AGENT_BRIDGE_LABEL ?? 'Torchiko desktop runner',
    workdir: process.env.TORCHIKO_AGENT_BRIDGE_WORKDIR ?? process.cwd(),
    sessionId: process.env.TORCHIKO_AGENT_BRIDGE_SESSION_ID,
    modelName: process.env.TORCHIKO_AGENT_BRIDGE_MODEL ?? 'subscription-default',
    workerKey: process.env.TORCHIKO_AGENT_BRIDGE_WORKER_KEY,
    workerCapabilities: commaSeparated(process.env.TORCHIKO_AGENT_BRIDGE_WORKER_CAPABILITIES),
    workerAgentRoles: commaSeparated(process.env.TORCHIKO_AGENT_BRIDGE_WORKER_AGENT_ROLES),
    pollMs: integer(process.env.TORCHIKO_AGENT_BRIDGE_POLL_MS, 2_000),
    taskTimeoutMs: integer(process.env.TORCHIKO_AGENT_BRIDGE_TASK_TIMEOUT_MS, 30 * 60_000),
    localInferenceUrl: process.env.TORCHIKO_LOCAL_INFERENCE_URL,
    localInferenceKey: process.env.TORCHIKO_LOCAL_INFERENCE_KEY,
    hermesMcpUrl: process.env.TORCHIKO_HERMES_MCP_URL,
    hermesProfile: process.env.TORCHIKO_HERMES_PROFILE,
  })
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  process.stdout.write(
    `Torchiko bridge runner ${config.sessionId} starting for ${config.provider}.\n`,
  )
  await runAgentBridge(config, controller.signal)
}

void main().catch(() => {
  process.stderr.write('Torchiko bridge runner stopped without a confirmed connection.\n')
  process.exitCode = 1
})
