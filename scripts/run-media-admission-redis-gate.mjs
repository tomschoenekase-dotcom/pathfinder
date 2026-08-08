import {
  DisposableRedisExecutionError,
  DisposableRedisRefusal,
  runGuardedRedisSuite,
} from './lib/disposable-redis-integration.mjs'

try {
  process.exitCode = runGuardedRedisSuite({ suite: 'media-admission' })
} catch (error) {
  const label = error instanceof DisposableRedisRefusal ? 'refused' : 'failed'
  const message =
    error instanceof DisposableRedisExecutionError || error instanceof DisposableRedisRefusal
      ? error.message
      : 'Unexpected media admission Redis gate failure'
  console.error(`Media admission Redis gate ${label}: ${message}`)
  process.exitCode = error instanceof DisposableRedisRefusal ? 2 : 1
}
