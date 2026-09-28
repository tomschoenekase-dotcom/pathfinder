import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB_NAME = 'pathfinder_disposable_p14_local'
const PROJECT = 'nc-p14'
const PORTS = Object.freeze({ postgres: 56340, redis: 56341, minio: 56342, minioConsole: 56343, provider: 56344, web: 56345, dashboard: 56346, clamav: 56347 })
const PROCESSES = ['provider', 'workers', 'web', 'dashboard']
const COMPOSE_FILE = path.join(ROOT, 'compose.local-full-stack.yml')
const SEED_FILE = path.join(ROOT, 'packages', 'db', 'prisma', 'local-full-stack-seed.ts')
const MIGRATION_FILE = path.join(ROOT, 'scripts', 'migrate-disposable-db.mjs')

const FORBIDDEN_ENV = /^(?:CLERK_|STRIPE_|GMAIL_|GOOGLE_|RAILWAY_|VERCEL|OPENAI_|ANTHROPIC_|DEEPSEEK_|GEMINI_|RESEND_|AWS_|DATABASE_URL$|DIRECT_DATABASE_URL$|REDIS_URL$|STORAGE_|NEXT_PUBLIC_)/iu
const HOSTED_ENDPOINT_ENV = /(?:^|_)(?:URL|HOST|ENDPOINT)$/iu
const SAFE_BASE_ENV = ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']
const DOCKER_ENDPOINT_OVERRIDES = new Set(['docker_host', 'docker_context', 'docker_tls_verify', 'docker_cert_path'])

function refuse(message) {
  throw new Error(`LOCAL_FULL_STACK_REFUSED: ${message}`)
}

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizePath(value, platform = process.platform) {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, '')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function resolveOwnerRoot(environment = process.env, platform = process.platform) {
  const supplied = environment.TORCHIKO_LOCAL_FULL_STACK_ROOT
  let root
  if (supplied) root = path.resolve(supplied)
  else if (platform === 'win32') root = 'C:\\Users\\tomsc\\MachineWorkspaces\\torchiko\\20260928-local-full-stack'
  else refuse('TORCHIKO_LOCAL_FULL_STACK_ROOT must point into the runner MachineWorkspaces owner folder')

  const normalized = root.replaceAll('\\', '/').toLowerCase()
  if (!normalized.endsWith('/machineworkspaces/torchiko/20260928-local-full-stack')) {
    refuse('owner root must end in MachineWorkspaces/torchiko/20260928-local-full-stack')
  }
  return root
}

export function assertResetTarget(ownerRoot, target, platform = process.platform) {
  const owner = path.resolve(ownerRoot)
  const expected = path.join(owner, 'data')
  const resolvedTarget = path.resolve(target)
  if (!path.isAbsolute(target) || normalizePath(resolvedTarget, platform) !== normalizePath(expected, platform)) {
    refuse('reset target must be the exact absolute lane-owned data directory')
  }
  if (!isInside(owner, resolvedTarget) || path.basename(resolvedTarget).toLowerCase() !== 'data') {
    refuse('reset target escaped the Packet 14 owner directory')
  }
  return resolvedTarget
}

export function safeChildEnvironment(extra = {}, inherited = process.env) {
  const forbidden = Object.keys(inherited).filter((key) => FORBIDDEN_ENV.test(key) || HOSTED_ENDPOINT_ENV.test(key) && /(?:RAILWAY|VERCEL|DATABASE|REDIS|STORAGE|CLERK|OPENAI|ANTHROPIC|GOOGLE)/iu.test(key))
  if (forbidden.length) refuse(`inherited service credential or endpoint variable is present: ${forbidden.sort().join(', ')}`)
  const output = {}
  for (const key of SAFE_BASE_ENV) {
    const existing = Object.keys(inherited).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
    if (existing && inherited[existing] !== undefined) output[key] = inherited[existing]
  }
  return { ...output, ...extra }
}

export function assertLocalDockerEndpoint(endpoint, environment = {}, platform = process.platform) {
  const overrides = Object.keys(environment).filter((key) => DOCKER_ENDPOINT_OVERRIDES.has(key.toLowerCase()))
  if (overrides.length) refuse(`Docker endpoint override variables are present: ${overrides.sort().join(', ')}`)
  const host = String(endpoint ?? '').trim()
  const local = platform === 'win32'
    ? /^npipe:\/{3,4}\.\/pipe\/docker(?:_engine|DesktopLinuxEngine)$/iu.test(host)
    : /^unix:\/\/(?:\/var\/run\/docker\.sock|\/run\/docker\.sock)$/iu.test(host)
  if (!local) refuse('selected Docker context does not target the local engine')
  return host
}

async function existingPathHasReparsePoint(input) {
  const absolute = path.resolve(input)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || (process.platform === 'win32' && (stat.mode & 0o170000) === 0o120000)) {
        refuse(`reset path contains a symbolic link or reparse point: ${current}`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function assertCanonicalOwnerRoot(ownerRoot) {
  const root = path.resolve(ownerRoot)
  await existingPathHasReparsePoint(root)
  const canonical = await realpath(root)
  if (normalizePath(root) !== normalizePath(canonical)) refuse('owner root does not resolve to its canonical path')
  return canonical
}

async function rejectLinksBelow(target) {
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name)
    const stat = await lstat(child)
    if (stat.isSymbolicLink()) refuse(`reset data contains a symbolic link: ${child}`)
    if (stat.isDirectory()) await rejectLinksBelow(child)
  }
}

async function validateResetDataPath(ownerRoot, dataRoot) {
  const canonicalRoot = await assertCanonicalOwnerRoot(ownerRoot)
  const target = assertResetTarget(ownerRoot, dataRoot)
  const exists = await lstat(target).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
  if (exists) {
    if (!(await lstat(target)).isDirectory()) refuse('reset target must be a directory')
    const canonicalTarget = await realpath(target)
    if (normalizePath(canonicalTarget) !== normalizePath(target)) refuse('reset data path is not canonical')
    await rejectLinksBelow(target)
  }
  if (!isInside(canonicalRoot, target) || normalizePath(target) !== normalizePath(path.join(canonicalRoot, 'data'))) {
    refuse('canonical reset target is outside the owner directory')
  }
  return target
}

function ownerPaths(environment = process.env) {
  const root = resolveOwnerRoot(environment)
  return {
    root,
    data: path.join(root, 'data'),
    venueQrDirectory: path.join(root, 'data', 'venue-qrs'),
    logs: path.join(root, 'logs'),
    state: path.join(root, 'state'),
    stateFile: path.join(root, 'state', 'local-full-stack.json'),
    cookieKeyFile: path.join(root, 'state', 'fixture-cookie-key'),
  }
}

function composeArgs(paths, args) {
  return ['--project-name', PROJECT, '-f', COMPOSE_FILE, ...args]
}

function composeEnvironment(paths, inherited = process.env) {
  return safeChildEnvironment({
    TORCHIKO_LOCAL_FULL_STACK_DATA_DIR: paths.data.replaceAll('\\', '/'),
  }, inherited)
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? safeChildEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32' && command.toLowerCase() === 'pnpm.cmd',
    timeout: options.timeout ?? 120_000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error || result.status !== 0) {
    refuse(`${options.label ?? command} failed${result.status === null ? '' : ` (exit ${result.status})`}`)
  }
  return result.stdout ?? ''
}

function runPnpm(args, options = {}) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  return runSync(command, args, options)
}

function readState(paths) {
  return readFile(paths.stateFile, 'utf8').then((text) => JSON.parse(text), (error) => {
    if (error?.code === 'ENOENT') return { version: 1, project: PROJECT, processes: {} }
    throw error
  })
}

async function writeState(paths, state) {
  await mkdir(paths.state, { recursive: true })
  const temporary = `${paths.stateFile}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rm(paths.stateFile, { force: true })
  await (await import('node:fs/promises')).rename(temporary, paths.stateFile)
}

async function fixtureCookieKey(paths) {
  await mkdir(paths.state, { recursive: true })
  let key
  try {
    key = (await readFile(paths.cookieKeyFile, 'utf8')).trim()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    key = randomBytes(32).toString('hex')
    const file = await open(paths.cookieKeyFile, 'wx', 0o600)
    try {
      await file.writeFile(`${key}\n`, 'utf8')
    } finally {
      await file.close()
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(key)) refuse('fixture cookie key file is malformed')
  return key
}

function appEnvironment(paths, appPort, key, inherited = process.env) {
  const extras = {
    NODE_ENV: 'development',
    TORCHIKO_LOCAL_FIXTURE_AUTH: '1',
    TORCHIKO_VISUAL_FIXTURES_ENABLED: '1',
    TORCHIKO_LOCAL_FIXTURE_PORT: String(appPort),
    TORCHIKO_LOCAL_FIXTURE_COOKIE_KEY: key,
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(ROOT, 'scripts', 'local-font-mocks.cjs'),
    DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
    DIRECT_DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
    REDIS_URL: `redis://127.0.0.1:${PORTS.redis}`,
    STORAGE_BUCKET: 'p14-local',
    STORAGE_REGION: 'us-east-1',
    STORAGE_ENDPOINT: `http://127.0.0.1:${PORTS.minio}`,
    STORAGE_ACCESS_KEY_ID: 'p14-local',
    STORAGE_SECRET_ACCESS_KEY: 'p14-local-only-secret',
    CLERK_SECRET_KEY: 'p14-fixture-no-clerk-call',
    CLERK_PUBLISHABLE_KEY: 'p14-fixture-no-clerk-call',
    OPENAI_API_KEY: 'p14-local-fixture-only',
    OPENAI_BASE_URL: `http://127.0.0.1:${PORTS.provider}/v1`,
    GUEST_CHAT_DEFAULT_MODEL_KEY: 'guest-chat-luna',
    STRIPE_BILLING_UI_ENABLED: 'false',
    NEXT_PUBLIC_WEB_URL: `http://127.0.0.1:${PORTS.web}`,
    OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
    INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
    WORKER_SCHEDULERS_ENABLED: 'false',
    EMBEDDING_DISPATCH_ENABLED: 'false',
    GENERATION_DISPATCH_ENABLED: 'false',
    GENERATION_RECOVERY_ENABLED: 'false',
    EVALUATION_RUNNER_ENABLED: 'false',
    VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED: 'false',
  }
  const result = safeChildEnvironment(extras, inherited)
  result.NODE_OPTIONS = `--import=${pathToFileURL(fileURLToPath(import.meta.url)).href}`
  result.TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD = '1'
  return result
}

function installNetworkGuard() {
  const allowed = new Set(['127.0.0.1', '::1'])
  const deny = (target) => {
    if (typeof target !== 'string') return
    let host
    try {
      host = new URL(target).hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    } catch {
      throw new Error('Packet 14 local network guard denied an invalid destination')
    }
    if (!allowed.has(host)) throw new Error('Packet 14 local network guard denied a non-loopback destination')
  }
  const net = awaitImportSync('node:net')
  const dns = awaitImportSync('node:dns')
  const dgram = awaitImportSync('node:dgram')
  const tls = awaitImportSync('node:tls')
  const http = awaitImportSync('node:http')
  const https = awaitImportSync('node:https')
  const assertLocalSocket = (options, rest, label) => {
    const normalized = Array.isArray(options) ? options[0] : options
    if (typeof normalized === 'string' || (normalized && typeof normalized === 'object' && (normalized.path != null || normalized.socketPath != null))) {
      throw new Error(`Packet 14 local network guard denied a socket path (${label})`)
    }
    const host = normalized && typeof normalized === 'object'
      ? normalized.host ?? normalized.hostname
      : typeof normalized === 'number'
        ? typeof rest[0] === 'string' ? rest[0] : undefined
        : undefined
    if (!host || !allowed.has(String(host).replace(/^\[|\]$/gu, '').toLowerCase())) {
      throw new Error(`Packet 14 local network guard denied a non-loopback socket (${label})`)
    }
  }
  for (const module of [net]) {
    for (const name of ['connect', 'createConnection']) {
      const original = module[name]
      module[name] = function (options, ...rest) {
        assertLocalSocket(options, rest, name)
        return original.call(this, options, ...rest)
      }
    }
  }
  const originalSocketConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (options, ...rest) {
    assertLocalSocket(options, rest, 'Socket.connect')
    return originalSocketConnect.call(this, options, ...rest)
  }
  const originalServerListen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    const options = args[0]
    if (typeof options === 'string') return originalServerListen.apply(this, args)
    const host = options && typeof options === 'object'
      ? options.host ?? options.hostname
      : typeof options === 'number' && typeof args[1] === 'string'
        ? args[1]
        : undefined
    if (!host || !allowed.has(String(host).replace(/^\[|\]$/gu, '').toLowerCase())) {
      throw new Error('Packet 14 local network guard denied a non-loopback server bind')
    }
    return originalServerListen.apply(this, args)
  }
  const originalLookup = dns.lookup
  dns.lookup = function (hostname, ...rest) {
    if (!allowed.has(String(hostname).toLowerCase())) throw new Error('Packet 14 local network guard denied DNS lookup')
    return originalLookup.call(this, hostname, ...rest)
  }
  for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt']) {
    if (typeof dns[name] !== 'function') continue
    dns[name] = function () {
      throw new Error('Packet 14 local network guard denied DNS resolution')
    }
  }
  const dnsPromises = dns.promises
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt']) {
    if (typeof dnsPromises[name] !== 'function') continue
    dnsPromises[name] = function () {
      return Promise.reject(new Error('Packet 14 local network guard denied DNS resolution'))
    }
  }
  const originalTlsConnect = tls.connect
  tls.connect = function (options, ...rest) {
    if (typeof options === 'string' || (options && typeof options === 'object' && (options.path != null || options.socketPath != null))) {
      throw new Error('Packet 14 local network guard denied a TLS socket path')
    }
    const host = typeof options === 'object'
      ? options.host ?? options.hostname
      : typeof options === 'number' && typeof rest[0] === 'string'
        ? rest[0]
        : undefined
    if (!host || !allowed.has(String(host).replace(/^\[|\]$/gu, '').toLowerCase())) {
      throw new Error('Packet 14 local network guard denied a non-loopback TLS socket')
    }
    return originalTlsConnect.call(this, options, ...rest)
  }
  const originalDgramSend = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function (message, ...rest) {
    const address = [...rest].reverse().find((value) => typeof value === 'string')
    if (address && !allowed.has(address.replace(/^\[|\]$/gu, '').toLowerCase())) {
      throw new Error('Packet 14 local network guard denied a non-loopback UDP socket')
    }
    return originalDgramSend.call(this, message, ...rest)
  }
  const originalDgramConnect = dgram.Socket.prototype.connect
  dgram.Socket.prototype.connect = function (port, address, ...rest) {
    if (!address || !allowed.has(String(address).replace(/^\[|\]$/gu, '').toLowerCase())) {
      throw new Error('Packet 14 local network guard denied a non-loopback UDP socket')
    }
    return originalDgramConnect.call(this, port, address, ...rest)
  }
  const originalDgramBind = dgram.Socket.prototype.bind
  dgram.Socket.prototype.bind = function (...args) {
    const options = args[0]
    const address = options && typeof options === 'object'
      ? options.address
      : typeof options === 'number' && typeof args[1] === 'string'
        ? args[1]
        : undefined
    if (!address || !allowed.has(String(address).replace(/^\[|\]$/gu, '').toLowerCase())) {
      throw new Error('Packet 14 local network guard denied a non-loopback UDP bind')
    }
    return originalDgramBind.apply(this, args)
  }
  for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt']) {
    if (typeof dns.Resolver.prototype[name] !== 'function') continue
    dns.Resolver.prototype[name] = function () {
      throw new Error('Packet 14 local network guard denied DNS resolution')
    }
  }
  for (const module of [http, https]) {
    const assertHttpDestination = (input, rest) => {
      const options = rest.find((value) => value && typeof value === 'object' && !(value instanceof URL))
      for (const candidate of [input, options]) {
        if (!candidate || typeof candidate !== 'object') continue
        if (candidate.socketPath != null) {
          throw new Error('Packet 14 local network guard denied an HTTP socket path')
        }
        if (candidate.createConnection != null || (candidate.agent != null && candidate.agent !== false)) {
          throw new Error('Packet 14 local network guard denied a custom HTTP connection')
        }
        for (const host of [candidate.hostname, candidate.host]) {
          if (host != null) {
            deny(`${candidate.protocol ?? (module === https ? 'https:' : 'http:')}//${host}`)
          }
        }
      }
      const target = input instanceof URL
        ? input.href
        : typeof input === 'string'
          ? input
          : input && typeof input === 'object'
            ? `${input.protocol ?? (module === https ? 'https:' : 'http:')}//${input.hostname ?? input.host ?? ''}`
            : undefined
      if (target) deny(target)
      else throw new Error('Packet 14 local network guard denied an HTTP destination without a host')
    }
    const originalRequest = module.request
    module.request = function (input, ...rest) {
      assertHttpDestination(input, rest)
      return originalRequest.call(this, input, ...rest)
    }
    const originalGet = module.get
    module.get = function (input, ...rest) {
      assertHttpDestination(input, rest)
      return originalGet.call(this, input, ...rest)
    }
  }
  awaitImportSync('node:module').syncBuiltinESMExports()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async function (input, ...rest) {
    deny(input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url)
    const response = await originalFetch.call(this, input, { ...(rest[0] ?? {}), redirect: 'manual' }, ...rest.slice(1))
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Packet 14 local network guard denied an HTTP redirect')
    }
    return response
  }
  globalThis[Symbol.for('torchiko.p14.egressGuardInstalled')] = true
}

function awaitImportSync(specifier) {
  // Node's built-in CommonJS loader is synchronous and shares these modules with ESM consumers.
  return process.getBuiltinModule(specifier.replace(/^node:/u, ''))
}

async function processCommandLine(pid) {
  if (process.platform === 'win32') {
    const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine)`
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
    return result.status === 0 ? result.stdout.trim() : ''
  }
  try {
    return (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').replaceAll('\0', ' ')
  } catch {
    return ''
  }
}

async function processParentPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'win32') {
    const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ParentProcessId)`
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
    const parentPid = Number(result.stdout.trim())
    return result.status === 0 && Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)
    const parentPid = Number(fields[1])
    return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null
  } catch {
    return null
  }
}

async function isDescendantOf(pid, ancestorPid) {
  let current = pid
  for (let depth = 0; depth < 16 && current > 0; depth += 1) {
    if (current === ancestorPid) return true
    current = await processParentPid(current)
    if (!current) return false
  }
  return false
}

async function processWorkingDirectory(pid) {
  if (process.platform === 'win32') return null
  try {
    return await realpath(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

async function isAttributedProcess(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0 || record.root !== ROOT) return false
  const command = await processCommandLine(record.pid)
  if (!command || !record.marker || !command.includes(record.marker)) return false
  if (process.platform === 'win32') return command.includes(process.execPath)
  return normalizePath(await processWorkingDirectory(record.pid) ?? '') === normalizePath(record.cwd)
}

async function listenerRows(port) {
  if (process.platform === 'win32') {
    const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
    const script = `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress`
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0 || !result.stdout.trim()) return []
    const parsed = JSON.parse(result.stdout)
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      address: String(row.LocalAddress), port: Number(row.LocalPort), pid: Number(row.OwningProcess),
    }))
  }
  const result = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split(/\r?\n/u).filter(Boolean).map((row) => {
    const fields = row.trim().split(/\s+/u)
    const local = fields[3] ?? ''
    const match = fields.join(' ').match(/pid=(\d+)/u)
    return { address: local.slice(0, local.lastIndexOf(':')).replace(/^\[|\]$/gu, ''), port, pid: Number(match?.[1]) }
  })
}

async function assertLoopbackListener(port, record) {
  const rows = await listenerRows(port)
  const good = []
  for (const row of rows) {
    if (row.port === port && row.address === '127.0.0.1' && await isDescendantOf(row.pid, record.pid)) good.push(row)
  }
  if (good.length !== 1 || rows.length !== 1) refuse(`port ${port} is not owned solely by its expected 127.0.0.1 process`)
}

async function writeStructured(event, detail) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, detail })}\n`)
}

async function startTracked(paths, state, name, executable, args, options) {
  const stdoutPath = path.join(paths.logs, `${name}.stdout.log`)
  const stderrPath = path.join(paths.logs, `${name}.stderr.log`)
  const stdout = await open(stdoutPath, 'a')
  const stderr = await open(stderrPath, 'a')
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    detached: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  }).finally(async () => {
    await stdout.close()
    await stderr.close()
  })
  const record = { pid: child.pid, cwd: options.cwd, root: ROOT, marker: options.marker, port: options.port }
  state.processes[name] = record
  await writeState(paths, state)
  child.unref()
  return { child, record }
}

async function waitForHttp(url, record, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus
  while (Date.now() < deadline) {
    if (!(await isAttributedProcess(record))) refuse(`attributed process for ${url} exited`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      lastStatus = response.status
      if (response.status >= 200 && response.status < 300) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  refuse(`health wait expired for ${url}${lastStatus === undefined ? '' : ` (last HTTP status ${lastStatus})`}`)
}

async function stopTracked(paths, state) {
  for (const name of [...PROCESSES].reverse()) {
    const record = state.processes?.[name]
    if (!record || !(await isAttributedProcess(record))) continue
    try {
      if (process.platform === 'win32') {
        const taskkill = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
        const killed = spawnSync(taskkill, ['/PID', String(record.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
        if (killed.status !== 0 && !/not found|no running instance/iu.test(killed.stderr ?? '')) refuse(`could not stop attributed process ${name}`)
      } else process.kill(-record.pid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const alive = []
    for (const name of PROCESSES) {
      const record = state.processes?.[name]
      if (record && (await isAttributedProcess(record))) alive.push(name)
    }
    if (!alive.length) break
    if (attempt === 49) refuse(`owned processes remain after stop request: ${alive.join(', ')}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  state.processes = {}
  await writeState(paths, state)
}

function migrationEnvironment(paths) {
  return safeChildEnvironment({
    NODE_ENV: 'development',
    DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
    DIRECT_DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
    PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
    PATHFINDER_DISPOSABLE_DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
  })
}

function requireNoHostedDeploymentEnvironment(environment = process.env) {
  const names = Object.keys(environment)
  if (names.some((name) => /^(?:RAILWAY_|VERCEL)/iu.test(name))) refuse('Railway or Vercel environment variable is present')
  if (names.some((name) => FORBIDDEN_ENV.test(name))) refuse('inherited real service credentials or endpoints are present')
}

async function prepareFolders(paths) {
  await mkdir(paths.root, { recursive: true })
  const canonicalRoot = await assertCanonicalOwnerRoot(paths.root)
  if (normalizePath(canonicalRoot) !== normalizePath(paths.root)) refuse('owner workspace folder is not canonical')
  for (const directory of [paths.data, paths.logs, paths.state]) {
    await existingPathHasReparsePoint(directory)
    await mkdir(directory, { recursive: true })
    if (normalizePath(await realpath(directory)) !== normalizePath(directory)) {
      refuse(`owner workspace directory is not canonical: ${directory}`)
    }
  }
}

function runCompose(paths, ...args) {
  const env = verifyLocalDockerTarget()
  const info = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, env,
  })
  if (info.status !== 0) refuse('local Docker engine is unavailable; refusing Compose operation')
  if (info.stdout.trim() !== 'linux') refuse('local Docker engine must use Linux containers for Packet 14')
  const command = process.platform === 'win32' ? 'docker-compose.exe' : 'docker'
  const composeArguments = process.platform === 'win32' ? composeArgs(paths, args) : ['compose', ...composeArgs(paths, args)]
  return runSync(command, composeArguments, {
    env: composeEnvironment(paths),
    label: `Docker Compose ${args[0]}`,
    timeout: args[0] === 'up' ? 900_000 : 120_000,
  })
}

async function waitForLoopbackPort(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.setTimeout(2_000)
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => resolve(false))
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  refuse(`loopback port ${port} did not become reachable after local Compose health`)
}

async function makeFixtureEnv(paths, key, port) {
  const appRoot = path.join(ROOT, 'apps', port === PORTS.web ? 'web' : 'dashboard')
  const env = appEnvironment(paths, port, key)
  const distRoot = path.join(appRoot, '.next-local-staging', 'packet-14')
  await mkdir(distRoot, { recursive: true })
  env.NEXT_DIST_DIR = path.relative(appRoot, distRoot)
  return { appRoot, env }
}

async function up(paths) {
  requireNoHostedDeploymentEnvironment()
  await prepareFolders(paths)
  if (!(await dockerAvailable())) refuse('Docker engine is unavailable; no containers were started')
  const state = await readState(paths)
  if (Object.keys(state.processes ?? {}).length) await stopTracked(paths, state)
  runCompose(paths, 'up', '-d', '--wait', 'postgres', 'redis', 'minio', 'clamav', 'port-proxy')
  for (const port of [PORTS.postgres, PORTS.redis, PORTS.minio, PORTS.clamav]) {
    await waitForLoopbackPort(port)
  }
  runCompose(paths, 'run', '--rm', 'minio-init')

  runSync(process.execPath, [MIGRATION_FILE, '--database', DB_NAME, '--confirm-database', DB_NAME], {
    cwd: ROOT,
    env: migrationEnvironment(paths),
    label: 'guarded disposable migration',
    timeout: 900_000,
  })
  runPnpm(['--dir', 'packages/db', 'db:generate'], {
    cwd: ROOT,
    env: safeChildEnvironment({ NODE_ENV: 'development', DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`, DIRECT_DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}` }),
    label: 'Prisma client generation',
  })
  runPnpm(['--dir', 'packages/db', 'exec', 'tsx', 'prisma/local-full-stack-seed.ts'], {
    cwd: ROOT,
    env: safeChildEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
      DIRECT_DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
      TORCHIKO_LOCAL_FULL_STACK_DATA_DIR: paths.data,
      TORCHIKO_LOCAL_FULL_STACK_QR_DIR: paths.venueQrDirectory,
    }),
    label: 'synthetic local seed',
  })
  const workerDist = path.join(paths.data, 'workers-dist')
  await mkdir(workerDist, { recursive: true })
  runPnpm(['--dir', 'apps/workers', 'exec', 'tsup', '--out-dir', workerDist], {
    cwd: ROOT,
    env: safeChildEnvironment({ NODE_ENV: 'development' }),
    label: 'worker build',
  })

  const key = await fixtureCookieKey(paths)
  const procEnv = appEnvironment(paths, PORTS.provider, key)
  const providerFile = path.join(ROOT, 'scripts', 'local-provider-stub.mjs')
  const provider = await startTracked(paths, state, 'provider', process.execPath,
    [providerFile, '--host', '127.0.0.1', '--port', String(PORTS.provider)],
    { cwd: ROOT, env: procEnv, marker: providerFile, port: PORTS.provider })
  await waitForHttp(`http://127.0.0.1:${PORTS.provider}/health`, provider.record)
  await assertLoopbackListener(PORTS.provider, provider.record)

  const workerEnv = safeChildEnvironment({
    NODE_ENV: 'development',
    DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
    DIRECT_DATABASE_URL: `postgresql://pathfinder:p14-local-only@127.0.0.1:${PORTS.postgres}/${DB_NAME}`,
    REDIS_URL: `redis://127.0.0.1:${PORTS.redis}`,
    STORAGE_BUCKET: 'p14-local', STORAGE_REGION: 'us-east-1',
    STORAGE_ENDPOINT: `http://127.0.0.1:${PORTS.minio}`,
    STORAGE_ACCESS_KEY_ID: 'p14-local', STORAGE_SECRET_ACCESS_KEY: 'p14-local-only-secret',
    CLERK_SECRET_KEY: 'p14-fixture-no-clerk-call', CLERK_PUBLISHABLE_KEY: 'p14-fixture-no-clerk-call',
    OPENAI_API_KEY: 'p14-local-fixture-only', OPENAI_BASE_URL: `http://127.0.0.1:${PORTS.provider}/v1`,
    GUEST_CHAT_DEFAULT_MODEL_KEY: 'guest-chat-luna', STRIPE_BILLING_UI_ENABLED: 'false',
    OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false', INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'true',
    WORKER_SCHEDULERS_ENABLED: 'false', EMBEDDING_DISPATCH_ENABLED: 'false',
    GENERATION_DISPATCH_ENABLED: 'false', GENERATION_RECOVERY_ENABLED: 'false',
    EVALUATION_RUNNER_ENABLED: 'false', VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED: 'false',
    INTAKE_CLAMAV_HOST: '127.0.0.1', INTAKE_CLAMAV_PORT: String(PORTS.clamav),
    NODE_OPTIONS: `--import=${pathToFileURL(fileURLToPath(import.meta.url)).href}`,
    NODE_PATH: [path.join(ROOT, 'node_modules'), path.join(ROOT, 'apps', 'workers', 'node_modules'), path.join(ROOT, 'packages', 'db', 'node_modules')].join(path.delimiter),
    TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD: '1',
  })
  const workerCwd = path.join(ROOT, 'apps', 'workers')
  const workerBootstrap = path.join(workerDist, 'bootstrap.js')
  const workerSentry = path.join(workerDist, 'sentry.js')
  const worker = await startTracked(paths, state, 'workers', process.execPath,
    ['--require', workerSentry, workerBootstrap],
    { cwd: workerCwd, env: workerEnv, marker: workerBootstrap })
  await waitForLog(path.join(paths.logs, 'workers.stdout.log'), '"action":"workers.started"', worker.record)

  for (const [name, port, url, appPath] of [
    ['web', PORTS.web, `http://127.0.0.1:${PORTS.web}/api/health`, 'web'],
    ['dashboard', PORTS.dashboard, `http://127.0.0.1:${PORTS.dashboard}/sign-in`, 'dashboard'],
  ]) {
    const { appRoot, env } = await makeFixtureEnv(paths, key, port)
    const nextCli = path.join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
    const server = await startTracked(paths, state, name, process.execPath,
      [nextCli, 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd: appRoot, env, marker: nextCli, port })
    await waitForHttp(url, server.record)
    await assertLoopbackListener(port, server.record)
    await writeStructured('local.full-stack.process-ready', { name, port, url, pid: server.record.pid, appPath })
  }
  await writeStructured('local.full-stack.ready', {
    project: PROJECT,
    ports: PORTS,
    dataRoot: paths.data,
    logsRoot: paths.logs,
    stateRoot: paths.state,
    syntheticSeed: { venues: 3, owners: 2, tenants: 2 },
  })
}

async function waitForLog(logPath, marker, record) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!(await isAttributedProcess(record))) refuse('worker process exited before readiness')
    const log = await readFile(logPath, 'utf8').catch(() => '')
    if (log.includes(marker)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  refuse(`worker readiness marker was not observed in ${logPath}`)
}

async function down(paths) {
  await prepareFolders(paths)
  const state = await readState(paths)
  await stopTracked(paths, state)
  if (await dockerAvailable()) runCompose(paths, 'stop')
  await writeStructured('local.full-stack.stopped', { project: PROJECT, dataPreservedAt: paths.data })
}

async function reset(paths) {
  await prepareFolders(paths)
  if (!(await dockerAvailable())) refuse('local Docker engine is unavailable; reset will not delete owner data')
  const state = await readState(paths)
  await stopTracked(paths, state)
  runCompose(paths, 'stop')
  const target = await validateResetDataPath(paths.root, paths.data)
  await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 })
  await mkdir(target, { recursive: true })
  for (const directory of ['postgres', 'redis', 'minio']) await mkdir(path.join(target, directory), { recursive: true })
  await writeStructured('local.full-stack.reset', { project: PROJECT, recreatedDataAt: target })
}

async function dockerAvailable() {
  const env = verifyLocalDockerTarget()
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}} {{.OSType}}'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env })
  if (result.status !== 0 || !result.stdout.trim()) return false
  if (!result.stdout.trim().endsWith(' linux')) refuse('local Docker engine must use Linux containers for Packet 14')
  return true
}

function verifyLocalDockerTarget(environment = process.env) {
  const env = safeChildEnvironment({}, environment)
  const inspected = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, env,
  })
  if (inspected.error || inspected.status !== 0) refuse('could not verify the selected Docker engine; refusing Docker operation')
  assertLocalDockerEndpoint(inspected.stdout, environment)
  return env
}

async function status(paths) {
  await prepareFolders(paths)
  const state = await readState(paths)
  const processes = {}
  for (const name of PROCESSES) {
    const record = state.processes?.[name]
    processes[name] = record && await isAttributedProcess(record)
      ? { pid: record.pid, port: record.port ?? null, attributed: true }
      : null
  }
  let containers = 'docker-unavailable'
  if (await dockerAvailable()) {
    containers = runCompose(paths, 'ps', '--format', 'json').trim().split(/\r?\n/u).filter(Boolean).map((line) => {
      const row = JSON.parse(line)
      return { service: row.Service, state: row.State, health: row.Health, status: row.Status }
    })
  }
  await writeStructured('local.full-stack.status', { project: PROJECT, ports: PORTS, processes, containers, dataRoot: paths.data })
}

async function cli() {
  const action = process.argv[2] ?? 'status'
  if (!['up', 'down', 'reset', 'status'].includes(action)) refuse('action must be up, down, reset, or status')
  requireNoHostedDeploymentEnvironment()
  const paths = ownerPaths()
  if (action === 'up') {
    try {
      await up(paths)
    } catch (error) {
      try {
        const state = await readState(paths)
        await stopTracked(paths, state)
        if (await dockerAvailable()) runCompose(paths, 'stop')
      } catch (cleanupError) {
        process.stderr.write(`LOCAL_FULL_STACK_CLEANUP_FAILED: ${cleanupError?.message ?? String(cleanupError)}\n`)
      }
      throw error
    }
  }
  if (action === 'down') await down(paths)
  if (action === 'reset') await reset(paths)
  if (action === 'status') await status(paths)
}

if (process.env.TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD === '1') installNetworkGuard()

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
