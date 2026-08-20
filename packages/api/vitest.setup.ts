import { resolveDatabaseTestEnvironment } from '../db/src/test-environment-boundary'

const syntheticTestEnvironment = {
  CLERK_SECRET_KEY: 'sk_test_pathfinder_unit_tests',
  CLERK_PUBLISHABLE_KEY: 'pk_test_pathfinder_unit_tests',
} as const

const databaseTarget = resolveDatabaseTestEnvironment(process.env)

for (const name of [
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGPASSFILE',
  'PGOPTIONS',
  'PGSSLMODE',
]) {
  delete process.env[name]
}

process.env.DATABASE_URL = databaseTarget.databaseUrl
process.env.DIRECT_DATABASE_URL = databaseTarget.directDatabaseUrl

for (const [name, value] of Object.entries(syntheticTestEnvironment)) {
  process.env[name] = value
}
