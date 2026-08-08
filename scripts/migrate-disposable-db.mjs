import {
  DisposableMigrationRefusal,
  runDisposableMigration,
} from './lib/disposable-prisma-migration.mjs'

try {
  process.exitCode = runDisposableMigration({
    argv: process.argv.slice(2),
    env: process.env,
  })
} catch (error) {
  if (error instanceof DisposableMigrationRefusal) {
    console.error(`Disposable migration refused: ${error.message}`)
    process.exitCode = 2
  } else {
    console.error('Disposable migration refused because validation failed unexpectedly.')
    process.exitCode = 1
  }
}
