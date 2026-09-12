import assert from 'node:assert/strict'
import { verifyGuestDispositionRuntimeArtifacts } from './lib/guest-disposition-runtime-artifacts.mjs'

const args = process.argv.slice(2)
assert(
  args.length === 0 || (args.length === 1 && args[0] === '--write'),
  'Only explicit --write is accepted; default checks fixed files',
)
await verifyGuestDispositionRuntimeArtifacts({ write: args[0] === '--write' })
process.stdout.write(
  'Guest disposition runtime artifacts match canonical TypeScript 5.9.3 output.\n',
)
