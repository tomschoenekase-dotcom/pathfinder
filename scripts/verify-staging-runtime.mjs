import { spawnSync } from 'node:child_process'

import {
  auditStagingRuntime,
  parseStagingRuntimeArgs,
  StagingRuntimeAuditError,
} from './lib/staging-runtime-audit.mjs'

try {
  const options = parseStagingRuntimeArgs(process.argv.slice(2))
  const result = auditStagingRuntime(options, (args) => {
    const npxArgs = ['--yes', '@railway/cli', ...args]
    const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npx'
    const executableArgs =
      process.platform === 'win32' ? ['/d', '/s', '/c', ['npx.cmd', ...npxArgs].join(' ')] : npxArgs
    const child = spawnSync(executable, executableArgs, {
      encoding: 'utf8',
      maxBuffer: 1_048_576,
      // Windows cannot execute npm's npx.cmd shim directly (spawn EINVAL). The cmd.exe
      // command contains only constants and UUIDs strictly validated before this point.
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
