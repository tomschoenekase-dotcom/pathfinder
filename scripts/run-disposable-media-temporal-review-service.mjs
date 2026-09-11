import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'mediatemporal',
      databasePrefix: 'pathfinder_disposable_media_temporal_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_MEDIA_TEMPORAL_REVIEW_SERVICE',
      lifecycleEvent: 'test:media-temporal-review-service:disposable',
      successAction: 'media-temporal-review-service.disposable-shakedown.passed',
      proofScope: [
        'concurrent-exact-review-replay',
        'all-items-held-without-builder-run',
        'exact-source-observation-and-generation',
        'immutable-replay-after-source-change',
        'concurrent-inactive-operational-draft-handoff',
        'post-expiry-exact-handoff-replay',
        'conflicting-authority-and-scope-rejection',
        'no-publication',
        'provider-dark',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/lib/media-temporal-review.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: { RUN_MEDIA_TEMPORAL_REVIEW_SERVICE_DB_INTEGRATION: '1' },
      },
    },
  })
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
