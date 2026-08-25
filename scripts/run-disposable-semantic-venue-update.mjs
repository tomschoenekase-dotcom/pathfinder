import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  runDisposableSemanticVenueUpdateShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableSemanticVenueUpdateShakedown()
} catch (error) {
  if (error instanceof DisposableIntakeVerificationRefusal) {
    console.error(`Disposable semantic venue-update shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable semantic venue-update shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable semantic venue-update shakedown and cleanup both failed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable semantic venue-update shakedown failed: ${error.message}`
        : 'Disposable semantic venue-update shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
