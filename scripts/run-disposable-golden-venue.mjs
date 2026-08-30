import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableGoldenVenueShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableGoldenVenueShakedown()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
