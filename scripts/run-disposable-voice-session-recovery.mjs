import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableServiceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'voicerecovery',
      databasePrefix: 'pathfinder_disposable_voice_recovery_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_VOICE_RECOVERY_SHAKEDOWN',
      lifecycleEvent: 'test:voice-session-recovery:disposable',
      successAction: 'voice-session-recovery.disposable-shakedown.passed',
      proofScope: [
        'abandoned-authorization-expiry',
        'provider-secret-expiry',
        'active-session-hard-cap',
        'terminal-state-replay-safety',
        'live-session-preservation',
      ],
      failureScope: ['migration-drift', 'voice-session-recovery-contract-drift'],
      integration: {
        packageDirectory: 'packages/db',
        testFile: 'src/helpers/voice-session-recovery.disposable.integration.test.ts',
        expectedPassed: 1,
        environment: { RUN_VOICE_SESSION_RECOVERY_DB_INTEGRATION: '1' },
      },
    },
  })
}

try {
  process.exitCode = await run()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
