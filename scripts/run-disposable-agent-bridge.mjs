import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  runDisposableServiceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'agentbridge',
      databasePrefix: 'pathfinder_disposable_agent_bridge_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_AGENT_BRIDGE_SHAKEDOWN',
      lifecycleEvent: 'test:agent-bridge:disposable',
      successAction: 'agent-bridge.runner-lifecycle.disposable-shakedown.passed',
      proofScope: [
        'machine-credential-authentication',
        'http-transport',
        'session-registration',
        'strict-shared-task-contract',
        'actor-agent-scope-model-provenance',
        'null-prompt-operation-fallback',
        'retryable-failure',
        'lease-reclaim',
        'durable-artifact-readback',
        'explicit-unreported-cost-status',
      ],
      failureScope: ['provider-or-venue-contract-drift', 'executor-failure'],
      integration: {
        packageDirectory: 'apps/workers',
        testFile: 'src/lib/agent-bridge-runner.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_AGENT_BRIDGE_RUNNER_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}

try {
  process.exitCode = await run()
} catch (error) {
  if (error instanceof DisposableIntakeVerificationRefusal) {
    console.error(`Disposable agent bridge shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable agent bridge shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable agent bridge shakedown and cleanup did not both succeed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable agent bridge shakedown failed: ${error.message}`
        : 'Disposable agent bridge shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
