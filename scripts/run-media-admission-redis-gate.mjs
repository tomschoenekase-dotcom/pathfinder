import {
  DisposableRedisRefusal,
  runGuardedRedisSuite,
} from './lib/disposable-redis-integration.mjs'
import { reportOperatorCliFailure } from './lib/operator-cli-failure.mjs'

try {
  process.exitCode = runGuardedRedisSuite({ suite: 'media-admission' })
} catch (error) {
  const refused = error instanceof DisposableRedisRefusal
  process.exitCode = reportOperatorCliFailure({
    action: 'redis.media-admission.failed',
    errorCode: refused ? 'redis-gate-refused' : 'redis-gate-failed',
    exitCode: refused ? 2 : 1,
  })
}
