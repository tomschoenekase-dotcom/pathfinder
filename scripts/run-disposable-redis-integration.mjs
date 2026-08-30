import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableRedisIntegration,
} from './lib/disposable-redis-integration.mjs'

try {
  process.exitCode = await runDisposableRedisIntegration()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
