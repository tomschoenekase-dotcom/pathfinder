import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  runDisposablePublicInterestConversionShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposablePublicInterestConversionShakedown()
} catch (error) {
  if (error instanceof DisposableIntakeVerificationRefusal) {
    console.error(`Disposable public-interest conversion shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable public-interest conversion shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error(
      'Disposable public-interest conversion shakedown and cleanup did not both succeed.',
    )
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable public-interest conversion shakedown failed: ${error.message}`
        : 'Disposable public-interest conversion shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
