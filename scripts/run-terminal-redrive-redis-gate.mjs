import {
  DisposableRedisExecutionError,
  DisposableRedisRefusal,
  runGuardedRedisSuite,
} from './lib/disposable-redis-integration.mjs'

try {
  process.exitCode = runGuardedRedisSuite({ suite: 'terminal-redrive' })
} catch (error) {
  const label = error instanceof DisposableRedisRefusal ? 'refused' : 'failed'
  const message =
    error instanceof DisposableRedisExecutionError || error instanceof DisposableRedisRefusal
      ? error.message
      : 'Unexpected terminal redrive Redis gate failure'
  console.error(`Terminal redrive Redis gate ${label}: ${message}`)
  process.exitCode = error instanceof DisposableRedisRefusal ? 2 : 1
}
