import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  runDisposableServiceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'convergence',
      databasePrefix: 'pathfinder_disposable_content_convergence_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_CONTENT_CONVERGENCE_SHAKEDOWN',
      lifecycleEvent: 'test:content-convergence:disposable',
      successAction: 'native-content.convergence.disposable-shakedown.passed',
      proofScope: [
        'exact-tenant-venue-scope',
        'missing-native-head',
        'valid-in-sync-native-head',
        'materialized-state-drift',
        'legacy-retirement-retained',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/native-content-convergence-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_CONTENT_CONVERGENCE_DB_INTEGRATION: '1',
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
    console.error(`Disposable content convergence shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable content convergence shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable content convergence shakedown and cleanup did not both succeed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable content convergence shakedown failed: ${error.message}`
        : 'Disposable content convergence shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
