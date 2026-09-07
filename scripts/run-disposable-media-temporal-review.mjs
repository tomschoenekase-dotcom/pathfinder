import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'mediatemporal',
      databasePrefix: 'pathfinder_disposable_media_temporal_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_MEDIA_TEMPORAL_REVIEW',
      lifecycleEvent: 'test:media-temporal-review:disposable',
      successAction: 'media-temporal-review.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'exact-current-media-generation',
        'compact-immutable-review',
        'inactive-operational-draft-handoff',
        'provider-dark',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/media-temporal-review.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: { RUN_MEDIA_TEMPORAL_REVIEW_DB_INTEGRATION: '1' },
      },
    },
  })
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
