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
      // Avoid the implicit projectToken/local-link resolver used by `logs`.
      // Topology admission has already verified this exact staging project.
      const child = spawnSync(process.execPath, [cli, 'dlx', RAILWAY_CLI_PACKAGE, ...queryArgs,
        '--project', '8621111a-4ac8-4d88-9566-4627c8a02059'], {
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
          diagnostic: /unauthorized/iu.test(child.stderr ?? '') ? 'unauthorized'
            : /no linked project|no project specified/iu.test(child.stderr ?? '') ? 'project-context-missing'
            : /not found/iu.test(child.stderr ?? '') ? 'resource-not-found'
            : /unknown|unexpected argument/iu.test(child.stderr ?? '') ? 'invalid-cli-arguments'
            : 'runtime-query-failed',
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
