import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'mediaop',
      databasePrefix: 'pathfinder_disposable_media_provider_operation_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_MEDIA_PROVIDER_OPERATION_SHAKEDOWN',
      lifecycleEvent: 'test:media-provider-operation:disposable',
      successAction: 'media-provider-operation.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'durable-provider-file-identity',
        'validated-output-before-cleanup',
        'cleanup-only-retry',
        'no-provider-regeneration',
      ],
      failureScope: ['migration-drift', 'receipt-fence-drift', 'provider-cleanup-retry-drift'],
      integration: {
        packageDirectory: 'apps/workers',
        testFile: 'src/processors/media-provider-operation.disposable.integration.test.ts',
        expectedPassed: 2,
        environment: {
          RUN_MEDIA_PROVIDER_OPERATION_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
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
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
