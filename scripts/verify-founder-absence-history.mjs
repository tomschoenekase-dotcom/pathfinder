import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

import {
  auditFounderAbsenceHistory,
  FounderAbsenceHistoryAuditError,
  parseFounderAbsenceHistoryArgs,
} from './lib/founder-absence-history-audit.mjs'
import { RAILWAY_CLI_PACKAGE } from './lib/railway-cli-contract.mjs'

try {
  const options = parseFounderAbsenceHistoryArgs(process.argv.slice(2))
  const result = auditFounderAbsenceHistory(options, (args) => {
    const npxArgs = ['--yes', RAILWAY_CLI_PACKAGE, ...args]
    const executable = process.platform === 'win32' ? process.execPath : 'npx'
    const executableArgs =
      process.platform === 'win32'
        ? [resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'), ...npxArgs]
        : npxArgs
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
    error instanceof FounderAbsenceHistoryAuditError
      ? error.code
      : 'unexpected-founder-absence-history-failure'
  process.stderr.write(`Founder absence history audit failed: ${code}\n`)
  process.exitCode = 1
}
