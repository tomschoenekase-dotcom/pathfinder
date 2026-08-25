import {
  DisposableIntakeVerificationExecutionError,
  DisposableIntakeVerificationRefusal,
  runDisposableIntakeWebsiteResearchShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableIntakeWebsiteResearchShakedown()
} catch (error) {
  if (error instanceof DisposableIntakeVerificationRefusal) {
    console.error(`Disposable website research shakedown refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableIntakeVerificationExecutionError) {
    console.error(`Disposable website research shakedown failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable website research shakedown and cleanup both failed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable website research shakedown failed: ${error.message}`
        : 'Disposable website research shakedown failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
