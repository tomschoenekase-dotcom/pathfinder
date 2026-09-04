import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  auditStagingRuntime,
  parseStagingRuntimeArgs,
  StagingRuntimeAuditError,
} from './lib/staging-runtime-audit.mjs'
import { RAILWAY_CLI_PACKAGE } from './lib/railway-cli-contract.mjs'

try {
  const options = parseStagingRuntimeArgs(process.argv.slice(2))
  const result = auditStagingRuntime(options, (args) => {
    const pnpmCandidates = [
      process.env.npm_execpath,
      process.env.APPDATA
        ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
        : null,
    ]
    const pnpmEntry = pnpmCandidates.find(
      (candidate) =>
        typeof candidate === 'string' && /pnpm(?:\.c?js)?$/iu.test(candidate) && existsSync(candidate),
    )
    if (process.platform === 'win32' && !pnpmEntry) return { status: 1, stdout: '' }
    const executable = pnpmEntry ? process.execPath : 'pnpm'
    const executableArgs = pnpmEntry
      ? [pnpmEntry, 'dlx', RAILWAY_CLI_PACKAGE, ...args]
      : ['dlx', RAILWAY_CLI_PACKAGE, ...args]
    const child = spawnSync(executable, executableArgs, {
      encoding: 'utf8',
      maxBuffer: 1_048_576,
      shell: false,
    })
    return { status: child.status, stdout: child.stdout }
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const code =
    error instanceof StagingRuntimeAuditError ? error.code : 'unexpected-runtime-audit-failure'
  process.stderr.write(`Staging runtime audit failed: ${code}\n`)
  process.exitCode = 1
}
