import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableServiceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'guestread',
      databasePrefix: 'pathfinder_disposable_native_guest_read_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_NATIVE_GUEST_READ_SHAKEDOWN',
      lifecycleEvent: 'test:native-guest-read:disposable',
      successAction: 'guest-chat.native-content-read.disposable-shakedown.passed',
      proofScope: [
        'actual-guest-chat-router',
        'in-process-provider-transport',
        'evaluation-evidence-does-not-authorize-apply',
        'human-approved-native-apply',
        'idempotent-apply-and-revert-command-replay',
        'drift-blocked-exact-rollback',
        'exact-native-head-rollback',
        'active-native-read',
        'dark-legacy-read',
        'semantic-place-retrieval',
        'semantic-knowledge-retrieval',
        'low-confidence-signals',
        'public-second-layer-boundary',
        'tenant-venue-isolation',
        'whole-request-fallback',
        'server-kill-switch-rollback',
        'read-only-activation-preflight',
        'preflight-cross-tenant-isolation',
        'mcp-readiness-preflight',
        'mcp-capability-scope',
        'mcp-preflight-secret-boundary',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/native-guest-read.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_NATIVE_GUEST_READ_DB_INTEGRATION: '1',
          NATIVE_GUEST_CONTENT_READ_ENABLED: 'true',
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
