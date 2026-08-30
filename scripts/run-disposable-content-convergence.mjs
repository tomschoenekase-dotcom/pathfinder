import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableServiceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'convergence',
      databasePrefix: 'pathfinder_disposable_content_convergence_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_CONTENT_CONVERGENCE_SHAKEDOWN',
      lifecycleEvent: 'test:content-convergence:disposable',
      successAction: 'native-content.convergence.disposable-shakedown.passed',
      proofScope: [
        'exact-tenant-venue-scope',
        'missing-native-head',
        'valid-in-sync-native-head',
        'materialized-state-drift',
        'nonzero-forward-materialization',
        'exact-revert-restoration',
        'control-venue-isolation',
        'compatibility-row-retained',
        'legacy-retirement-retained',
      ],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/native-content-convergence-disposable.integration.test.ts',
        expectedPassed: 2,
        environment: {
          RUN_CONTENT_CONVERGENCE_DB_INTEGRATION: '1',
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
}

try {
  process.exitCode = await run()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
