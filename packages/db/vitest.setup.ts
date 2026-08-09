import { resolveDatabaseTestEnvironment } from './src/test-environment-boundary'

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
