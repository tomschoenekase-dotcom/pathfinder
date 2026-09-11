import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableMediaResolutionShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableMediaResolutionShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
