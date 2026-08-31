import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

import {
  auditStagingRuntime,
  parseStagingRuntimeArgs,
  StagingRuntimeAuditError,
} from './lib/staging-runtime-audit.mjs'

try {
  const options = parseStagingRuntimeArgs(process.argv.slice(2))
  const result = auditStagingRuntime(options, (args) => {
    const npxArgs = ['--yes', '@railway/cli', ...args]
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
    error instanceof StagingRuntimeAuditError ? error.code : 'unexpected-runtime-audit-failure'
  process.stderr.write(`Staging runtime audit failed: ${code}\n`)
  process.exitCode = 1
}
