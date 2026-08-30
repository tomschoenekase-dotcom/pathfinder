import {
  DisposableMigrationRefusal,
  runDisposableMigration,
} from './lib/disposable-prisma-migration.mjs'
import { reportOperatorCliFailure } from './lib/operator-cli-failure.mjs'

try {
  process.exitCode = runDisposableMigration({
    argv: process.argv.slice(2),
    env: process.env,
  })
} catch (error) {
  if (error instanceof DisposableMigrationRefusal) {
    process.exitCode = reportOperatorCliFailure({
      action: 'disposable-migration.failed',
      errorCode: 'disposable-migration-refused',
      exitCode: 2,
    })
  } else {
    process.exitCode = reportOperatorCliFailure({
      action: 'disposable-migration.failed',
      errorCode: 'disposable-migration-failed',
    })
  }
}
