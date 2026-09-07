import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import { runDisposableLegacyKnowledgeAdoptionShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableLegacyKnowledgeAdoptionShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
