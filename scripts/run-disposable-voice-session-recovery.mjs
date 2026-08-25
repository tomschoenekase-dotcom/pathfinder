import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
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
  if (error instanceof DisposableIntakeVerificationRefusal) {
    console.error(`Disposable voice recovery shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable voice recovery shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable voice recovery shakedown and cleanup did not both succeed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable voice recovery shakedown failed: ${error.message}`
        : 'Disposable voice recovery shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
