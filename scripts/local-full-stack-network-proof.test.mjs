import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_TARGETS,
  PRELOADER,
  SYNTHETIC_EGRESS_TARGET,
  assertSyntheticEgressDenied,
  assertUdpWildcardBindDenied,
  decodeProcAddress,
  hasNextServerArgv,
  isLoopbackAddress,
  parseProcTcpTable,
  taskProcessRecords,
} from './local-full-stack-network-proof.mjs'

const script = fileURLToPath(new URL('./local-full-stack-network-proof.mjs', import.meta.url))

test('probe has only the fixed Packet 14 loopback targets and health paths', () => {
  assert.deepEqual(LOCAL_TARGETS, [
    { name: 'provider', port: 56344, pathname: '/health' },
    { name: 'web', port: 56345, pathname: '/api/health' },
    { name: 'dashboard', port: 56346, pathname: '/sign-in' },
  ])
  assert.equal(SYNTHETIC_EGRESS_TARGET, 'http://203.0.113.17:80/packet14-egress-proof')
  assert.match(PRELOADER, /scripts[\\/]local-full-stack\.mjs$/u)
})

test('guard rejects the fixed TEST-NET-3 request before any socket attempt', () => {
  const result = assertSyntheticEgressDenied()
  assert.deepEqual(result, {
    target: 'http://203.0.113.17:80/packet14-egress-proof',
    deniedBeforeSocket: true,
  })
})

test('UDP guard denies wildcard binds before bind while allowing loopback', () => {
  assert.deepEqual(assertUdpWildcardBindDenied(), {
    wildcardDeniedBeforeBind: true,
    loopbackAllowed: true,
  })
})

test('fixed TEST-NET-3 target is never a probe listener or service request target', () => {
  const source = readFileSync(script, 'utf8')
  assert.equal(LOCAL_TARGETS.some(({ port }) => port === 80), false)
  assert.match(source, /http:\/\/127\.0\.0\.1:\$\{target\.port\}\$\{target\.pathname\}/u)
  assert.match(source, /assert\.throws\(\(\) => http\.get\(target\), \/network guard denied/u)
  assert.match(source, /export async function runNetworkProof\(\)/u)
  assert.match(source, /fileURLToPath\(import\.meta\.url\)/u)
})

test('connection audit selects provider, workers, web, and dashboard from validated task state', () => {
  const checkout = process.cwd()
  const ownerRoot = path.join(path.parse(checkout).root, 'MachineWorkspaces', 'torchiko', '20260928-local-full-stack')
  const state = {
    processes: {
      provider: { pid: 101, root: checkout, marker: path.join(checkout, 'scripts', 'local-provider-stub.mjs') },
      workers: { pid: 104, root: checkout, marker: path.join(ownerRoot, 'data', 'workers-dist', 'bootstrap.js'), cwd: path.join(checkout, 'apps', 'workers') },
      web: { pid: 102, root: checkout, marker: path.join(checkout, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next'), cwd: path.join(checkout, 'apps', 'web') },
      dashboard: { pid: 103, root: checkout, marker: path.join(checkout, 'apps', 'dashboard', 'node_modules', 'next', 'dist', 'bin', 'next'), cwd: path.join(checkout, 'apps', 'dashboard') },
    },
  }
  assert.deepEqual(taskProcessRecords(state, checkout, ownerRoot), { provider: 101, workers: 104, web: 102, dashboard: 103 })
  assert.throws(() => taskProcessRecords({ processes: { ...state.processes, provider: { ...state.processes.provider, root: `${checkout}/other` } } }, checkout, ownerRoot), /owned provider/u)
  assert.throws(() => taskProcessRecords({ processes: { ...state.processes, workers: { ...state.processes.workers, marker: 'worker' } } }, checkout, ownerRoot), /workers process marker/u)
})

test('Linux TCP ownership parser recognizes IPv4 and IPv6 loopback peers only', () => {
  assert.equal(decodeProcAddress('0100007F', 4), '127.0.0.1')
  assert.equal(decodeProcAddress('00000000000000000000000001000000', 6), '::1')
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('203.0.113.17'), false)
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:DD68 0100007F:DD69 01 00000000:00000000 00:00000000 00000000 1000 0 12345',
    '   1: 0100007F:DD68 117100CB:0050 01 00000000:00000000 00:00000000 00000000 1000 0 23456',
    '   2: 0100007F:DD68 117100CB:0050 01 00000000:00000000 00:00000000 00000000 1000 0 34567',
  ].join('\n')
  assert.deepEqual(parseProcTcpTable(table, new Set(['12345', '23456']), 4), ['127.0.0.1', '203.0.113.17'])
})

test('Next listener child must be directly launched with the exact task Next server argv', () => {
  const checkout = process.cwd()
  const expected = realpathSync(path.join(checkout, 'apps', 'web', 'node_modules', 'next', 'dist', 'server', 'lib', 'start-server.js'))
  assert.equal(hasNextServerArgv(['node', '--import=preload', expected], 'web', checkout), true)
  assert.equal(hasNextServerArgv(['node', 'next-server'], 'web', checkout), false)
  assert.equal(hasNextServerArgv(['node', expected, expected], 'web', checkout), false)
})

test('Windows connection audit scopes each query by PID and ignores only the cmdlet no-match result', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /Get-Command Get-NetTCPConnection -ErrorAction Stop/u)
  assert.match(source, /Get-NetTCPConnection -OwningProcess \$_ -State Established -ErrorAction Stop/u)
  assert.match(source, /FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound\*'/u)
  assert.match(source, /if \(result\.status !== 0\) fail\('could not inspect Packet 14 process connections'\)/u)
})
