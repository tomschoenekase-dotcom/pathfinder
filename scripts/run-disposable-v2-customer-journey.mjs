import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'
try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'v2journey',
      databasePrefix: 'pathfinder_disposable_v2_journey_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_V2_JOURNEY',
      lifecycleEvent: 'test:v2-journey:disposable',
      successAction: 'v2-journey.disposable-shakedown.passed',
      proofScope: [
        'real-postgresql-draft-cas',
        'atomic-stale-submit-rollback',
        'submission-replay',
        'draft-scope-isolation',
        'reviewed-media-temporal-conflict-hold',
        'immutable-temporal-evidence-replay',
        'local-temporal-clarification-idempotency',
        'actual-production-retrieval',
        'long-tail-fact',
        'spanish-holdout',
        'private-disabled-cross-tenant-exclusion',
        'provider-dark',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/lib/v2-customer-journey-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_V2_CUSTOMER_JOURNEY_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
        },
      },
    },
  })
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
