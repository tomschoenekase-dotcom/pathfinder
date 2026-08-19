import { spawn } from 'node:child_process'

import { assertStagingMigrationAdmission } from './lib/staging-migration-admission.mjs'

const admission = assertStagingMigrationAdmission(process.env)
console.log(
  JSON.stringify({
    action: 'staging-migration.admitted',
    releaseSha: admission.releaseSha,
    databaseResource: admission.resource,
    databaseHost: admission.databaseHost,
    directDatabaseHost: admission.directDatabaseHost,
    database: admission.database,
    dataPolicy: 'synthetic-only',
    spendCeilingUsd: admission.spendCeilingUsd,
  }),
)

const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(executable, ['--filter', '@pathfinder/db', 'db:migrate:prod'], {
  cwd: new URL('..', import.meta.url),
  env: process.env,
  stdio: 'inherit',
  shell: false,
})

child.once('error', (error) => {
  console.error(`Staging migration process could not start: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Staging migration process ended by signal ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
