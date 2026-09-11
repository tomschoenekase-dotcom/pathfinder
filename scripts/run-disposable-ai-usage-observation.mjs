import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableAiUsageObservationShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableAiUsageObservationShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
