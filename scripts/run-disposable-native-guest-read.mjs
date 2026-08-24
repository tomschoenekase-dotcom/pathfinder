import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  runDisposableServiceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'guestread',
      databasePrefix: 'pathfinder_disposable_native_guest_read_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_NATIVE_GUEST_READ_SHAKEDOWN',
      lifecycleEvent: 'test:native-guest-read:disposable',
      successAction: 'guest-chat.native-content-read.disposable-shakedown.passed',
      proofScope: [
        'actual-guest-chat-router',
        'in-process-provider-transport',
        'active-native-read',
        'dark-legacy-read',
        'semantic-place-retrieval',
        'semantic-knowledge-retrieval',
        'low-confidence-signals',
        'public-second-layer-boundary',
        'tenant-venue-isolation',
        'whole-request-fallback',
        'server-kill-switch-rollback',
        'read-only-activation-preflight',
        'preflight-cross-tenant-isolation',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/native-guest-read.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_NATIVE_GUEST_READ_DB_INTEGRATION: '1',
          NATIVE_GUEST_CONTENT_READ_ENABLED: 'true',
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
    console.error(`Disposable native guest-read shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable native guest-read shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable native guest-read shakedown and cleanup did not both succeed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable native guest-read shakedown failed: ${error.message}`
        : 'Disposable native guest-read shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
