import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableOperatingCostShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableOperatingCostShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
