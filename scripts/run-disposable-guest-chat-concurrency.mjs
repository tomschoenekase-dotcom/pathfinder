import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'
import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

// Reuse the harness's allowlisted attribution resource namespace. Resources are
// still fresh UUID-scoped containers, migrated from zero and removed afterward.
try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'attribution',
      databasePrefix: 'pathfinder_disposable_answer_attribution_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_GUEST_CHAT_CONCURRENCY_SHAKEDOWN',
      lifecycleEvent: 'test:guest-chat-concurrency:disposable',
      successAction: 'guest-chat.finalization-concurrency.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'actual-postgresql-serializable',
        '24-same-venue-6-second-venue',
        'baseline-no-retry-comparison',
        'frozen-response-no-provider-redispatch',
        'atomic-message-pair',
        'replay',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/guest-chat-finalization-concurrency.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_GUEST_CHAT_CONCURRENCY_DB_INTEGRATION: '1',
          ...(process.env.GUEST_CHAT_CONCURRENCY_REPORT_PATH
            ? { GUEST_CHAT_CONCURRENCY_REPORT_PATH: process.env.GUEST_CHAT_CONCURRENCY_REPORT_PATH }
            : {}),
        },
      },
    },
  })
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
