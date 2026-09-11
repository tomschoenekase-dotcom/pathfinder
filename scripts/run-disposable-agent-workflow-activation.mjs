import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableAgentWorkflowActivationShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableAgentWorkflowActivationShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
