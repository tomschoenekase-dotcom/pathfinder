import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'
try {
  process.exitCode = await runDisposableServiceShakedown({ configuration: {
    resourceFamily: 'characterfactory',
    databasePrefix: 'pathfinder_disposable_character_factory_',
    optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_CHARACTER_FACTORY',
    lifecycleEvent: 'test:character-factory:disposable',
    successAction: 'character-factory.disposable-shakedown.passed',
    proofScope: ['real-postgresql-character-jobs', 'exact-request-replay', 'concurrent-claims', 'lease-cancellation', 'completion', 'stale-result-rollback', 'provider-dark'],
    integration: {
      packageDirectory: 'packages/db',
      testFile: 'src/helpers/custom-character-factory-disposable.integration.test.ts',
      expectedPassed: 1,
      environment: { RUN_CHARACTER_FACTORY_DB_INTEGRATION: '1', OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false', WORKER_SCHEDULERS_ENABLED: 'false' },
    },
  } })
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
