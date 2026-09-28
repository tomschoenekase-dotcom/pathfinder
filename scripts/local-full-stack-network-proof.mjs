import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PRELOADER = path.join(ROOT, 'scripts', 'local-full-stack.mjs')

// These are the only application listeners Packet 14 launches on the host.
export const LOCAL_TARGETS = Object.freeze([
  Object.freeze({ name: 'provider', port: 56344, pathname: '/health' }),
  Object.freeze({ name: 'web', port: 56345, pathname: '/api/health' }),
  Object.freeze({ name: 'dashboard', port: 56346, pathname: '/sign-in' }),
])

// RFC 5737 TEST-NET-3; the preloader must reject this before a socket opens.
export const SYNTHETIC_EGRESS_TARGET = 'http://203.0.113.17:80/packet14-egress-proof'
const AUDITED_PROCESSES = Object.freeze(['provider', 'workers', 'web', 'dashboard'])

function fail(message) {
  throw new Error(`LOCAL_FULL_STACK_NETWORK_PROOF_FAILED: ${message}`)
}

function listenerRows(port) {
  if (process.platform === 'win32') {
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    const script = `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress`
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    })
    if (result.status !== 0) fail(`could not inspect listener on ${port}`)
    if (!result.stdout.trim()) return []
    const parsed = JSON.parse(result.stdout)
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      address: String(row.LocalAddress).toLowerCase(), port: Number(row.LocalPort), pid: Number(row.OwningProcess),
    }))
  }

  const result = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], {
    encoding: 'utf8', timeout: 10_000,
  })
  if (result.status !== 0) fail(`could not inspect listener on ${port}`)
  return result.stdout.split(/\r?\n/u).filter(Boolean).map((row) => {
    const local = row.trim().split(/\s+/u)[3] ?? ''
    const separator = local.lastIndexOf(':')
    const pid = row.match(/pid=(\d+)/u)
    return { address: local.slice(0, separator).replace(/^\[|\]$/gu, '').toLowerCase(), port, pid: Number(pid?.[1]) }
  })
}

function taskOwnerRoot(environment = process.env) {
  const supplied = environment.TORCHIKO_LOCAL_FULL_STACK_ROOT
  const root = supplied
    ? path.resolve(supplied)
    : process.platform === 'win32'
      ? 'C:\\Users\\tomsc\\MachineWorkspaces\\torchiko\\20260928-local-full-stack'
      : ''
  const normalized = root.replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase()
  if (!path.isAbsolute(root) || !normalized.endsWith('/machineworkspaces/torchiko/20260928-local-full-stack')) {
    fail('task owner root is unavailable or outside the Packet 14 workspace')
  }
  return root
}

export function taskProcessRecords(state, checkoutRoot = ROOT, ownerRoot) {
  const records = state?.processes
  const selected = {}
  for (const name of AUDITED_PROCESSES) {
    const record = records?.[name]
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0 || path.resolve(record.root ?? '') !== path.resolve(checkoutRoot)) {
      fail(`task state has no valid owned ${name} process record`)
    }
    const expectedMarker = name === 'provider'
      ? path.join(checkoutRoot, 'scripts', 'local-provider-stub.mjs')
      : name === 'workers'
        ? path.join(ownerRoot ?? '', 'data', 'workers-dist', 'bootstrap.js')
        : path.join(checkoutRoot, 'apps', name, 'node_modules', 'next', 'dist', 'bin', 'next')
    if (path.resolve(record.marker ?? '') !== path.resolve(expectedMarker)) fail(`task state ${name} process marker is invalid`)
    const expectedCwd = name === 'provider' ? undefined : path.join(checkoutRoot, 'apps', name)
    if (expectedCwd && path.resolve(record.cwd ?? '') !== expectedCwd) {
      fail(`task state ${name} working directory is invalid`)
    }
    selected[name] = record.pid
  }
  return selected
}

export function isLoopbackAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.')
}

export function decodeProcAddress(hex, family) {
  if (family === 4) {
    if (!/^[a-f\d]{8}$/iu.test(hex)) fail('task TCP table contains an invalid IPv4 address')
    const bytes = hex.match(/../gu).reverse().map((part) => Number.parseInt(part, 16))
    return bytes.join('.')
  }
  if (family === 6) {
    if (!/^[a-f\d]{32}$/iu.test(hex)) fail('task TCP table contains an invalid IPv6 address')
    const bytes = hex.match(/.{8}/gu).flatMap((word) => word.match(/../gu).reverse())
      .map((part) => Number.parseInt(part, 16))
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return '::1'
    if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
      return `::ffff:${bytes.slice(12).join('.')}`
    }
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':')
  }
  fail('unsupported TCP address family')
}

export function parseProcTcpTable(contents, ownedInodes, family) {
  const peers = []
  for (const line of contents.split(/\r?\n/u).slice(1)) {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 10 || fields[3] !== '01' || !ownedInodes.has(fields[9])) continue
    const [remoteHex] = fields[2].split(':')
    peers.push(decodeProcAddress(remoteHex, family))
  }
  return peers
}

async function ownedSocketInodes(pid) {
  const descriptors = await readdir(`/proc/${pid}/fd`)
  const inodes = new Set()
  for (const descriptor of descriptors) {
    let target
    try {
      target = await readlink(`/proc/${pid}/fd/${descriptor}`)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const match = target.match(/^socket:\[(\d+)\]$/u)
    if (match) inodes.add(match[1])
  }
  return inodes
}

function nextServerPath(name, checkoutRoot = ROOT) {
  return path.join(checkoutRoot, 'apps', name, 'node_modules', 'next', 'dist', 'server', 'lib', 'start-server.js')
}

export function hasNextServerArgv(argv, name, checkoutRoot = ROOT) {
  // Next resolves pnpm's app-local symlink before launching its server child.
  const expected = realpathSync(nextServerPath(name, checkoutRoot))
  return argv.filter((argument) => path.resolve(argument) === expected).length === 1
}

async function isLinuxNextChild(parentPid, childPid, name) {
  const children = (await readFile(`/proc/${parentPid}/task/${parentPid}/children`, 'utf8')).trim().split(/\s+/u).filter(Boolean)
  if (!children.includes(String(childPid))) return false
  const executable = path.basename(await readlink(`/proc/${childPid}/exe`)).toLowerCase()
  if (executable !== 'node' && executable !== 'node.exe') return false
  const argv = (await readFile(`/proc/${childPid}/cmdline`)).toString('utf8').split('\0').filter(Boolean)
  return hasNextServerArgv(argv, name)
}

function windowsNextChildren(parentPid, name) {
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const expected = realpathSync(nextServerPath(name)).replaceAll("'", "''")
  const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine.IndexOf('${expected}', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress -Depth 3`
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  if (result.status !== 0) fail(`could not attribute ${name} Next server child process`)
  if (!result.stdout.trim()) return []
  const parsed = JSON.parse(result.stdout)
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId),
  }))
}

async function resolveAuditedPids(parentPids, listenerPids) {
  const audited = new Set(Object.values(parentPids))
  for (const name of ['web', 'dashboard']) {
    const parentPid = parentPids[name]
    const listenerPid = listenerPids[name]
    if (listenerPid === parentPid) continue
    let validated = false
    if (process.platform === 'win32') {
      validated = windowsNextChildren(parentPid, name).some((row) => row.pid === listenerPid && row.parentPid === parentPid)
    } else {
      validated = await isLinuxNextChild(parentPid, listenerPid, name)
    }
    if (!validated) fail(`${name} listener is not owned by its launcher or validated Next child`)
    audited.add(listenerPid)
  }
  if (listenerPids.provider !== parentPids.provider) fail('provider listener is not owned by its task process')
  return [...audited]
}

function windowsEstablishedPeers(pids) {
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const pidList = Object.values(pids).join(',')
  // Query by each selected process ID; unavailable or denied attribution fails closed.
  const script = `$ErrorActionPreference = 'Stop'; Get-Command Get-NetTCPConnection -ErrorAction Stop | Out-Null; $targetPids = @(${pidList}); @($targetPids | ForEach-Object { try { Get-NetTCPConnection -OwningProcess $_ -State Established -ErrorAction Stop | Select-Object OwningProcess,RemoteAddress } catch { if ($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*') { throw } } }) | ConvertTo-Json -Compress -Depth 3`
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  if (result.status !== 0) fail('could not inspect Packet 14 process connections')
  if (!result.stdout.trim()) return []
  const parsed = JSON.parse(result.stdout)
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.OwningProcess), address: String(row.RemoteAddress),
  }))
}

async function linuxEstablishedPeers(pids) {
  const owned = new Map()
  for (const pid of Object.values(pids)) owned.set(pid, await ownedSocketInodes(pid))
  const [ipv4, ipv6] = await Promise.all([
    readFile('/proc/net/tcp', 'utf8'),
    readFile('/proc/net/tcp6', 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return ''
      throw error
    }),
  ])
  const peers = []
  for (const [pid, inodes] of owned) {
    peers.push(...parseProcTcpTable(ipv4, inodes, 4).map((address) => ({ pid, address })))
    if (ipv6) peers.push(...parseProcTcpTable(ipv6, inodes, 6).map((address) => ({ pid, address })))
  }
  return peers
}

export async function assertOwnedConnectionsLoopback(listenerPids, environment = process.env) {
  const ownerRoot = taskOwnerRoot(environment)
  const statePath = path.join(ownerRoot, 'state', 'local-full-stack.json')
  let state
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    fail('could not read the Packet 14 task process state')
  }
  const parentPids = taskProcessRecords(state, ROOT, ownerRoot)
  const pids = await resolveAuditedPids(parentPids, listenerPids)
  const peers = process.platform === 'win32'
    ? windowsEstablishedPeers(Object.fromEntries(pids.map((pid, index) => [`p${index}`, pid])))
    : await linuxEstablishedPeers(Object.fromEntries(pids.map((pid, index) => [`p${index}`, pid])))
  const unknownOwners = peers.filter(({ pid }) => !pids.includes(pid))
  if (unknownOwners.length) fail('connection query returned an unowned process')
  const outside = peers.filter(({ address }) => !isLoopbackAddress(address))
  if (outside.length) fail(`Packet 14 has ${outside.length} established non-loopback connection(s)`)
  return { auditedProcesses: pids.length, establishedConnections: peers.length, nonLoopbackConnections: 0 }
}

export async function assertLoopbackListeners(targets = LOCAL_TARGETS) {
  const listenerPids = {}
  for (const target of targets) {
    const rows = listenerRows(target.port)
    if (rows.length !== 1 || rows[0].port !== target.port || rows[0].address !== '127.0.0.1' || !Number.isSafeInteger(rows[0].pid) || rows[0].pid <= 0) {
      fail(`${target.name} port ${target.port} is not bound solely to 127.0.0.1`)
    }
    listenerPids[target.name] = rows[0].pid
  }
  return listenerPids
}

function requestStatus(target) {
  const url = `http://127.0.0.1:${target.port}${target.pathname}`
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { agent: false }, (response) => {
      response.resume()
      response.once('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${target.name} health path returned HTTP ${response.statusCode}`))
          return
        }
        resolve(response.statusCode)
      })
    })
    request.setTimeout(3_000, () => request.destroy(new Error(`${target.name} health request timed out`)))
    request.once('error', reject)
  })
}

export function assertSyntheticEgressDenied() {
  const preloaderUrl = pathToFileURL(PRELOADER).href
  const childScript = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import net from 'node:net';
    assert.equal(process.env.TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD, '1');
    assert.equal(globalThis[Symbol.for('torchiko.p14.egressGuardInstalled')], true);
    const target = ${JSON.stringify(SYNTHETIC_EGRESS_TARGET)};
    let socketAttempts = 0;
    net.Socket.prototype.connect = function () {
      socketAttempts++;
      throw new Error('TEST_OUTSIDE_SOCKET_ATTEMPT');
    };
    assert.throws(() => http.get(target), /network guard denied/u);
    assert.equal(socketAttempts, 0, 'the guard must deny before socket creation');
    process.stdout.write('denied-before-socket\\n');
  `
  const env = {
    NODE_OPTIONS: `--import=${preloaderUrl}`,
    TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD: '1',
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'denied-before-socket') {
    fail(`egress preloader proof failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  }
  return { target: SYNTHETIC_EGRESS_TARGET, deniedBeforeSocket: true }
}

export function assertUdpWildcardBindDenied() {
  const preloaderUrl = pathToFileURL(PRELOADER).href
  const childScript = `
    import assert from 'node:assert/strict';
    import dgram from 'node:dgram';
    assert.equal(globalThis[Symbol.for('torchiko.p14.egressGuardInstalled')], true);
    const socket = dgram.createSocket('udp4');
    assert.throws(() => socket.bind({ port: 0, address: '0.0.0.0' }), /non-loopback UDP bind/u);
    assert.throws(() => socket.bind(0), /non-loopback UDP bind/u);
    const loopbackSocket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      loopbackSocket.once('error', reject);
      loopbackSocket.bind({ port: 0, address: '127.0.0.1' }, resolve);
    });
    assert.equal(loopbackSocket.address().address, '127.0.0.1');
    loopbackSocket.close();
    process.stdout.write('wildcard-denied-loopback-allowed\\n');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: ROOT,
    env: { NODE_OPTIONS: `--import=${preloaderUrl}`, TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD: '1' },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'wildcard-denied-loopback-allowed') {
    fail(`UDP bind guard proof failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  }
  return { wildcardDeniedBeforeBind: true, loopbackAllowed: true }
}

export async function runNetworkProof() {
  const listenerPids = await assertLoopbackListeners()
  const services = []
  for (const target of LOCAL_TARGETS) {
    services.push({ name: target.name, port: target.port, status: await requestStatus(target) })
  }
  const egress = assertSyntheticEgressDenied()
  const udpBind = assertUdpWildcardBindDenied()
  const connections = await assertOwnedConnectionsLoopback(listenerPids)
  return { services, egress, udpBind, connections }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNetworkProof().then((result) => {
    process.stdout.write(`${JSON.stringify({ event: 'local.full-stack.network-proof', ...result })}\n`)
  }).catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
