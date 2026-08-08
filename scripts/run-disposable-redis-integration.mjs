import {
  DisposableRedisExecutionError,
  DisposableRedisRefusal,
  runDisposableRedisIntegration,
} from './lib/disposable-redis-integration.mjs'

try {
  process.exitCode = await runDisposableRedisIntegration()
} catch (error) {
  if (error instanceof DisposableRedisRefusal) {
    console.error(`Disposable Redis integration refused: ${error.message}`)
    process.exitCode = 2
  } else if (error instanceof DisposableRedisExecutionError) {
    console.error(`Disposable Redis integration failed: ${error.message}`)
    process.exitCode = 1
  } else if (error instanceof AggregateError) {
    console.error('Disposable Redis integration failed and cleanup also failed.')
    for (const cause of error.errors) {
      console.error(cause instanceof Error ? cause.message : 'Unknown failure')
    }
    process.exitCode = 1
  } else {
    console.error(
      error instanceof Error
        ? `Disposable Redis integration failed: ${error.message}`
        : 'Disposable Redis integration failed unexpectedly.',
    )
    process.exitCode = 1
  }
}
