// Offline inventory only: never reads environment files, database URLs or credentials.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readMigrationManifest, assertFrozenManifest } from './run-staging-migration-predeploy.mjs'
import {
  assertRelease270Manifest,
  RELEASE270,
  RELEASE270_SUFFIX,
} from './lib/release270-migration-contract.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const manifest = await readMigrationManifest(
  fileURLToPath(new URL('../packages/db/prisma', import.meta.url)),
)
assertRelease270Manifest(manifest)
let hosted267Refusal
try {
  assertFrozenManifest(manifest)
} catch (error) {
  hosted267Refusal = error.message
}
if (!hosted267Refusal) throw new Error('Historical hosted contract unexpectedly accepts candidate')
console.log(
  JSON.stringify(
    {
      kind: 'release270-offline-inventory',
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
      ...RELEASE270,
      suffix: RELEASE270_SUFFIX,
      hosted267Refusal,
      limits:
        'Inventory validation only; no hosted migration, current ledger, backup or rollout approval is established.',
    },
    null,
    2,
  ),
)
