import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'guestread',
      databasePrefix: 'pathfinder_disposable_native_guest_read_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_GUIDE_CORRECTION_SHAKEDOWN',
      lifecycleEvent: 'test:guide-correction:disposable',
      successAction: 'guide-correction.disposable-shakedown.passed',
      proofScope: [
        'two-venue-in-chat-correction-capture',
        'in-chat-factual-addition-capture-and-publication',
        'source-answer-and-claim-evidence',
        'human-review-and-explicit-publication',
        'fresh-visitor-corrected-answer',
        'cross-venue-isolation',
        'unverified-claim-remains-inert',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/routers/admin/guide-correction.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_GUIDE_CORRECTION_DB_INTEGRATION: '1',
          NATIVE_GUEST_CONTENT_READ_ENABLED: 'false',
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
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
