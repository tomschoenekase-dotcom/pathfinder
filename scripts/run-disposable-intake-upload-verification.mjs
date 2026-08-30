import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableIntakeVerificationShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableIntakeVerificationShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
