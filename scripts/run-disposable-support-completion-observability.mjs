import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import { runDisposableSupportCompletionObservabilityShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableSupportCompletionObservabilityShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
