import { resolveDatabaseTestEnvironment } from '../../packages/db/src/test-environment-boundary'

const target = resolveDatabaseTestEnvironment(process.env)

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

process.env.DATABASE_URL = target.databaseUrl
process.env.DIRECT_DATABASE_URL = target.directDatabaseUrl
process.env.CLERK_SECRET_KEY = 'sk_test_pathfinder_unit_tests'
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_pathfinder_unit_tests'
