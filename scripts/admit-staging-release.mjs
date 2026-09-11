import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { admitStagingRelease } from './lib/staging-release-admission.mjs'
import { parseBoundedTopologyJson } from './lib/staging-topology-admission.mjs'
import { parseStagingHealthArgs } from './lib/staging-health-admission.mjs'
import { RAILWAY_CLI_PACKAGE } from './lib/railway-cli-contract.mjs'

try {
  const args = process.argv.slice(2)
  if (args[0] !== '--topology-file' || !args[1]) throw new Error('topology-file-required')
  const topology = parseBoundedTopologyJson(await readFile(args[1], 'utf8'))
  const health = parseStagingHealthArgs(args.slice(2))
  const cli = process.env.npm_execpath
  if (!cli) throw new Error('run-through-pnpm')
  const result = await admitStagingRelease({
    topology,
    expectedRevision: health.expectedRevision,
    health,
    executeRuntimeQuery: (queryArgs) => {
      const child = spawnSync(process.execPath, [cli, 'dlx', RAILWAY_CLI_PACKAGE, ...queryArgs], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1_048_576,
      })
      if (child.status !== 0) {
        process.stderr.write(`${JSON.stringify({
          ok: false,
          stage: 'runtime-query',
          service: queryArgs[queryArgs.indexOf('--service') + 1],
          query: queryArgs.includes('--http') ? 'http5xx' : queryArgs.includes('--filter') ? 'errors' : 'events',
          status: child.status,
          code: child.error?.code ?? null,
          signal: child.signal,
        })}\n`)
      }
      return { status: child.status, stdout: child.stdout }
    },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  // Bounded verdict only: provider stderr and environment values may contain private information.
  const code =
    typeof error?.code === 'string' && /^[a-z-]+$/u.test(error.code)
      ? error.code
      : 'staging-release-admission-failed'
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
  process.exitCode = 1
}
