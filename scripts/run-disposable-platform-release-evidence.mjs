import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  runDisposablePlatformReleaseEvidenceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposablePlatformReleaseEvidenceShakedown()
} catch (error) {
  if (error instanceof DisposableIntakeVerificationRefusal) {
    console.error(`Disposable platform release-evidence shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable platform release-evidence shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable platform release-evidence shakedown and cleanup did not both succeed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable platform release-evidence shakedown failed: ${error.message}`
        : 'Disposable platform release-evidence shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
