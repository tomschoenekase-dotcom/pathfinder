import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableFounderDirectiveTaskShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableFounderDirectiveTaskShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
