import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'characterfactory',
      databasePrefix: 'pathfinder_disposable_character_factory_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_CHARACTER_ARTIFACT',
      lifecycleEvent: 'test:character-artifact-storage:disposable',
      successAction: 'character-artifact-storage.disposable-shakedown.passed',
      proofScope: [
        'versioned-content-addressed-storage',
        'actual-byte-roundtrip',
        'tamper-and-missing-rejection',
        'cross-tenant-fence',
        'postgresql-job-completion-linkage',
        'provider-dark',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/lib/character-artifact-storage.integration.test.ts',
        expectedPassed: 2,
        environment: {
          RUN_CHARACTER_ARTIFACT_STORAGE_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
        },
      },
    },
  })
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
