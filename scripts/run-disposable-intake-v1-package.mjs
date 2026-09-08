import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'intakev1package',
      databasePrefix: 'pathfinder_disposable_intake_v1_package_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_INTAKE_V1_PACKAGE_SHAKEDOWN',
      lifecycleEvent: 'test:intake-v1-package:disposable',
      successAction: 'intake-v1-package.machine-approved-draft.disposable-shakedown.passed',
      proofScope: [
        'exact-v1-candidate-preview',
        'machine-proposal-with-live-worker-run-credential-and-lease',
        'human-decision-and-one-shot-grant',
        'inactive-package-draft-and-immutable-handoff',
        'exact-operation-replay',
        'grant-consumption-and-draft-atomic-rollback',
        'credential-revocation-immediate-effect',
        'tenant-venue-scope-isolation',
        'no-package-approval-application-or-publication',
        'provider-dark',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/intake-v1-package-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_INTAKE_V1_PACKAGE_DB_INTEGRATION: '1',
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
