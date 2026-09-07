import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableMediaRelationApplicationShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableMediaRelationApplicationShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
