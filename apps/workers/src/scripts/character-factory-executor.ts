import { parseAgentBridgeRunnerConfig } from '../lib/agent-bridge-runner'
import {
  parseCharacterFactoryCompletion,
  runCharacterFactoryExecutor,
} from '../lib/character-factory-executor'

function json(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return JSON.parse(value) as unknown
}

async function main() {
  const completion = parseCharacterFactoryCompletion({
    requestId: process.env.TORCHIKO_CHARACTER_FACTORY_REQUEST_ID,
    resultPayload: {
      ...(json('TORCHIKO_CHARACTER_FACTORY_RESULT_JSON') as Record<string, unknown>),
      executionProvenance: {
        executor: 'provider-dark-retained-artifact-v1',
        modelProvider: null,
        modelName: null,
      },
    },
    ...(process.env.TORCHIKO_CHARACTER_FACTORY_SPEC_JSON
      ? { characterSpec: json('TORCHIKO_CHARACTER_FACTORY_SPEC_JSON') }
      : {}),
    ...(process.env.TORCHIKO_CHARACTER_FACTORY_ARTIFACT_REFERENCE_JSON
      ? { assetStorageReference: json('TORCHIKO_CHARACTER_FACTORY_ARTIFACT_REFERENCE_JSON') }
      : {}),
  })
  const config = parseAgentBridgeRunnerConfig({
    endpoint: process.env.TORCHIKO_AGENT_BRIDGE_URL,
    secret: process.env.TORCHIKO_AGENT_BRIDGE_SECRET,
    venueId: process.env.TORCHIKO_AGENT_BRIDGE_VENUE_ID,
    provider: 'CODEX_SUBSCRIPTION',
    label: 'Torchiko character executor',
    workdir: process.cwd(),
    modelName: 'provider-dark-artifact-executor',
    taskTimeoutMs: 60_000,
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.taskTimeoutMs)
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  try {
    const result = await runCharacterFactoryExecutor(config, completion, controller.signal)
    process.stdout.write(
      `Character factory request ${completion.requestId}: ${result.state}; no model was invoked.\n`,
    )
  } finally {
    clearTimeout(timeout)
  }
}

void main().catch(() => {
  process.stderr.write('Character factory executor stopped without confirmed completion.\n')
  process.exitCode = 1
})
