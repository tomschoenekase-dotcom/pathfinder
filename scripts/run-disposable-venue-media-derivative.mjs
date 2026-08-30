import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableVenueMediaDerivativeShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableVenueMediaDerivativeShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
