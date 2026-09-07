import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'prospectoutreach',
      databasePrefix: 'pathfinder_disposable_prospect_outreach_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_PROSPECT_OUTREACH',
      lifecycleEvent: 'test:prospect-outreach:disposable',
      successAction: 'prospect-outreach.disposable-shakedown.passed',
      proofScope: [
        'fresh-migration-chain',
        'human-reviewed-frozen-batch-release',
        'internal-only-disposable-gmail-account',
        'provider-dark-claim',
        'late-synced-canonical-inbound-reply-after-frozen-item',
        'reply-before-provider-revalidation-cancellation',
        'inbound-preserved-and-no-outbound-message',
      ],
      failureScope: ['no-live-provider', 'no-provider-instantiation', 'workers-disabled'],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/prospect-outreach-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_PROSPECT_OUTREACH_DB_INTEGRATION: '1',
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
