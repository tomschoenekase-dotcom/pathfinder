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
// Build sequentially so a clean forced build cannot race those shared trace inputs.
const result = spawnSync(
  process.execPath,
  [packageManagerCli, 'turbo', 'run', 'build', '--force', '--concurrency=1'],
  {
    cwd: repositoryRoot,
    env: buildSecretCanaryEnvironment(process.env),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  },
)

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) throw new Error(`Verified build failed to start: ${result.error.message}`)
if (result.status !== 0) process.exit(result.status ?? 1)

const targets = await discoverNextClientBundleTargets(repositoryRoot)
const scan = await scanClientBundleTargets(targets)
console.log(
  `Verified ${coveredKeys.length} server-only environment canaries and hardcoded credential patterns across ${scan.scannedFiles} browser-deliverable files in ${scan.applications} applications.`,
)
