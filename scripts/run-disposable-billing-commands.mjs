import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'
try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'billingcmd',
      databasePrefix: 'pathfinder_disposable_billing_command_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_BILLING_COMMANDS',
      lifecycleEvent: 'test:billing-commands:disposable',
      successAction: 'billing-commands.disposable-shakedown.passed',
      proofScope: [
        'real-postgresql-concurrent-claims',
        'stable-grace-effect',
        'completion-write-recovery',
        'expired-claim-recovery',
        'tenant-isolation',
        'immutable-effect-terms',
        'audit-once',
        'provider-dark',
        'exact-customer-request-replay-kind-and-scope',
        'multi-venue-paid-through-then-ended-entitlements',
        'approved-custom-quote-seasonal-reactivation',
        'single-base-agreement-authority-after-reactivation',
        'distinct-operation-reactivation-reservation-fenced-before-provider',
        'missing-account-first-checkout-concurrency-fenced',
        'same-operation-concurrent-reservation-replay',
        'retained-venue-content-across-cancellation-reactivation',
        'no-live-stripe-or-automatic-reactivation-charge',
      ],
      integration: {
        packageDirectory: 'packages/billing',
        testFile: 'src/agent-commands-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_BILLING_COMMAND_DB_INTEGRATION: '1',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
        },
      },
    },
  })
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
