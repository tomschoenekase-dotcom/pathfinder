import { spawn } from 'node:child_process'

import {
  isTransientRegistryFailure,
  runProductionDependencyAudit,
} from './lib/production-dependency-audit.mjs'

const ATTEMPT_TIMEOUT_MS = 45_000
const pnpmEntry = process.env.npm_execpath
if (!pnpmEntry || !/pnpm(?:\.c?js)?$/iu.test(pnpmEntry)) {
  process.stderr.write('Production dependency audit requires the pinned pnpm runtime.\n')
  process.exitCode = 1
} else {
  let attempt = 0
  const result = await runProductionDependencyAudit({
    run: () =>
      new Promise((resolve) => {
        attempt += 1
        let settled = false
        const child = spawn(
          process.execPath,
          [pnpmEntry, 'audit', '--prod', '--audit-level', 'high', '--json'],
          {
            encoding: 'utf8',
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        const finish = (value) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(value)
        }
        const timeout = setTimeout(() => {
          child.kill()
          finish({ code: 1, stdout: '', stderr: 'dependency registry request timeout\n' })
        }, ATTEMPT_TIMEOUT_MS)
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.once('error', (error) =>
          finish({ code: 1, stdout, stderr: `${stderr}${error.message}\n` }),
        )
        child.once('exit', (code, signal) =>
          finish({ code: signal ? 1 : (code ?? 1), stdout, stderr }),
        )
      }),
    sleep: async (delayMs) => {
      process.stderr.write(
        `Dependency registry was transiently unavailable on attempt ${attempt}; retrying in ${delayMs}ms.\n`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    },
  })

  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.code !== 0) {
    if (isTransientRegistryFailure(result)) {
      process.stderr.write(`Dependency audit exhausted ${result.attempts} transient attempts.\n`)
    }
    process.exitCode = result.code
  }
}
