import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertSecretCanaryRegistryCoversConfig,
  buildSecretCanaryEnvironment,
  discoverNextClientBundleTargets,
  scanClientBundleTargets,
} from './lib/client-bundle-secret-scan.mjs'
import { reportOperatorCliFailure } from './lib/operator-cli-failure.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageManagerCli = process.env.npm_execpath
if (!packageManagerCli) {
  throw new Error('Run this verifier through pnpm so the package-manager CLI is explicit')
}

const configSource = await readFile(
  join(repositoryRoot, 'packages', 'config', 'src', 'env.ts'),
  'utf8',
)
const coveredKeys = assertSecretCanaryRegistryCoversConfig(configSource)
// Both Next applications produce standalone traces rooted at the workspace.
// Build them directly and sequentially so shared trace inputs cannot race and a
// completed nested Turbo process cannot retain the verifier indefinitely.
let buildFailed = false
for (const application of ['@pathfinder/web', '@pathfinder/dashboard']) {
  const result = spawnSync(
    process.execPath,
    [packageManagerCli, '--filter', application, 'build'],
    {
      cwd: repositoryRoot,
      env: buildSecretCanaryEnvironment(process.env),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  )

  if (result.error || result.status !== 0) {
    process.exitCode = reportOperatorCliFailure({
      action: 'client-bundle-verification.failed',
      errorCode: result.error ? 'build-start-failed' : 'application-build-failed',
    })
    buildFailed = true
    break
  }
}
if (buildFailed) process.exit(process.exitCode ?? 1)

const targets = await discoverNextClientBundleTargets(repositoryRoot)
const scan = await scanClientBundleTargets(targets)
console.log(
  `Verified ${coveredKeys.length} server-only environment canaries and hardcoded credential patterns across ${scan.scannedFiles} browser-deliverable files in ${scan.applications} applications.`,
)
