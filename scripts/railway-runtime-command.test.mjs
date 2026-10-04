import assert from 'node:assert/strict'
import test from 'node:test'
import { railwayRuntimeCommand } from './lib/railway-runtime-command.mjs'

const queryArgs = ['logs', 'f859a485-79ca-47d1-a9c7-d122f075b8e1',
  '--service', 'staging-web', '--environment', 'staging', '--json']
test('Linux standalone pnpm is executed directly, never interpreted through Node', () => {
  const result = railwayRuntimeCommand({ platform: 'linux', nodeExecutable: '/usr/bin/node',
    pnpmEntry: '/home/runner/setup-pnpm/node_modules/.bin/pnpm', queryArgs })
  assert.equal(result.executable, 'pnpm')
  assert.equal(result.args[0], 'dlx')
  assert.ok(!result.args.includes('/home/runner/setup-pnpm/node_modules/.bin/pnpm'))
})
test('Linux JavaScript pnpm installation uses the same portable command', () => {
  assert.equal(railwayRuntimeCommand({ platform: 'linux', pnpmEntry: '/pnpm/bin/pnpm.cjs', queryArgs }).executable, 'pnpm')
})
test('Windows retains its verified Node-compatible pnpm entry', () => {
  const result = railwayRuntimeCommand({ platform: 'win32', nodeExecutable: 'node.exe',
    pnpmEntry: 'C:\\pnpm\\bin\\pnpm.cjs', queryArgs })
  assert.equal(result.executable, 'node.exe')
  assert.equal(result.args[0], 'C:\\pnpm\\bin\\pnpm.cjs')
})
test('Windows fails closed for a shell launcher rather than interpreting it as JavaScript', () => {
  assert.throws(() => railwayRuntimeCommand({ platform: 'win32', pnpmEntry: 'C:\\pnpm\\pnpm.cmd', queryArgs }), /node-compatible-pnpm-entry-required/u)
})
test('read-only log request preserves pinned CLI, deployment, service and exact project context', () => {
  assert.deepEqual(railwayRuntimeCommand({ platform: 'linux', queryArgs }).args,
    ['dlx', '@railway/cli@5.45.10', ...queryArgs, '--project', '8621111a-4ac8-4d88-9566-4627c8a02059'])
})
