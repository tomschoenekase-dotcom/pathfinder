import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertLocalDockerEndpoint, assertResetTarget, resolveOwnerRoot, safeChildEnvironment } from './local-full-stack.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(path.join(root, relative), 'utf8')

test('owner root is fixed to the Packet 14 machine workspace', () => {
  const owner = path.resolve(path.parse(root).root, 'Users', 'tomsc', 'MachineWorkspaces', 'torchiko', '20260928-local-full-stack')
  assert.equal(
    resolveOwnerRoot({ TORCHIKO_LOCAL_FULL_STACK_ROOT: owner }, process.platform),
    owner,
  )
  assert.throws(
    () => resolveOwnerRoot({ TORCHIKO_LOCAL_FULL_STACK_ROOT: path.join(root, 'Downloads', 'PathFinder') }, process.platform),
    /MachineWorkspaces/u,
  )
})

test('reset accepts only the exact absolute data directory owned by this lane', () => {
  const owner = path.resolve(path.parse(root).root, 'Users', 'tomsc', 'MachineWorkspaces', 'torchiko', '20260928-local-full-stack')
  const data = path.join(owner, 'data')
  assert.equal(assertResetTarget(owner, data), data)
  for (const target of ['', 'data', path.join(owner, 'state'), path.join(owner, '..', 'other', 'data')]) {
    assert.throws(() => assertResetTarget(owner, target), /reset target/u)
  }
})

test('child environments are allowlisted and reject inherited credentials', () => {
  assert.deepEqual(
    safeChildEnvironment({ DATABASE_URL: 'postgresql://127.0.0.1/test' }, { PATH: 'fixture-path', SystemDrive: 'C:' }),
    { PATH: 'fixture-path', SystemDrive: 'C:', DATABASE_URL: 'postgresql://127.0.0.1/test' },
  )
  assert.throws(() => safeChildEnvironment({}, { STRIPE_SECRET_KEY: 'redacted-value' }), /STRIPE_SECRET_KEY/u)
  assert.throws(() => safeChildEnvironment({}, { CLERK_SECRET_KEY: 'redacted-value' }), /CLERK_SECRET_KEY/u)
  assert.throws(() => safeChildEnvironment({}, { RAILWAY_ENVIRONMENT: 'staging' }), /RAILWAY_ENVIRONMENT/u)
})

test('Docker operations accept only local daemon endpoints and reject endpoint overrides', () => {
  assert.equal(assertLocalDockerEndpoint('npipe:////./pipe/docker_engine', {}, 'win32'), 'npipe:////./pipe/docker_engine')
  assert.equal(assertLocalDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine', {}, 'win32'), 'npipe:////./pipe/dockerDesktopLinuxEngine')
  assert.equal(assertLocalDockerEndpoint('unix:///var/run/docker.sock', {}, 'linux'), 'unix:///var/run/docker.sock')
  assert.throws(() => assertLocalDockerEndpoint('tcp://remote.example:2376', {}, 'win32'), /local engine/u)
  assert.throws(() => assertLocalDockerEndpoint('npipe:////./pipe/dockerDesktopWindowsEngine', {}, 'win32'), /local engine/u)
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    let message = ''
    try {
      assertLocalDockerEndpoint('npipe:////./pipe/docker_engine', { [key]: 'sensitive-test-value' }, 'win32')
    } catch (error) {
      message = error.message
    }
    assert.match(message, new RegExp(key, 'u'))
    assert.doesNotMatch(message, /sensitive-test-value/u)
  }
})

test('preloaded egress guard denies external fetch and sockets while allowing loopback', () => {
  const preload = pathToFileURL(path.join(root, 'scripts', 'local-full-stack.mjs')).href
  const packetProtector = `
    import net from 'node:net';
    import dns from 'node:dns';
    import dgram from 'node:dgram';
    const error = () => { throw new Error('TEST_NETWORK_NO_PACKET'); };
    const allowed = new Set(['127.0.0.1', '::1']);
    const socketConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (options, ...rest) {
      const host = typeof options === 'object' ? options.host ?? options.hostname : typeof options === 'number' ? rest[0] : undefined;
      if (host && !allowed.has(String(host).replace(/^\\[|\\]$/gu, '').toLowerCase())) return error();
      return socketConnect.call(this, options, ...rest);
    };
    const dnsLookup = dns.lookup;
    dns.lookup = function (hostname, ...rest) {
      return allowed.has(String(hostname).toLowerCase()) ? dnsLookup.call(this, hostname, ...rest) : error();
    };
    for (const name of Object.keys(dns).filter(name => name.startsWith('resolve'))) if (typeof dns[name] === 'function') dns[name] = error;
    for (const name of Object.getOwnPropertyNames(dns.Resolver.prototype).filter(name => name.startsWith('resolve'))) {
      dns.Resolver.prototype[name] = error;
    }
    const promiseLookup = dns.promises.lookup;
    dns.promises.lookup = (hostname, ...rest) => allowed.has(String(hostname).toLowerCase())
      ? promiseLookup.call(dns.promises, hostname, ...rest)
      : Promise.reject(new Error('TEST_NETWORK_NO_PACKET'));
    for (const name of Object.keys(dns.promises).filter(name => name.startsWith('resolve'))) dns.promises[name] = () => Promise.reject(new Error('TEST_NETWORK_NO_PACKET'));
    dgram.Socket.prototype.send = error;
    dgram.Socket.prototype.connect = error;
  `
  const packetProtectorUrl = `data:text/javascript,${encodeURIComponent(packetProtector)}`
  const code = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { connect, Server, Socket } from 'node:net';
    import * as dns from 'node:dns';
    import { Socket as DgramSocket } from 'node:dgram';
    import tls from 'node:tls';
    assert.equal(globalThis[Symbol.for('torchiko.p14.egressGuardInstalled')], true);
    import { once } from 'node:events';
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'https://example.com/no-packet' });
        response.end();
      } else response.end('loopback-ok');
    });
    assert.throws(() => new Server().listen(0, '0.0.0.0'), /non-loopback server bind/u);
    assert.throws(() => new Server().listen(0), /non-loopback server bind/u);
    assert.throws(() => new Server().listen(0, 'example.com'), /non-loopback server bind/u);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'loopback-ok');
    await assert.rejects(fetch('http://127.0.0.1:' + port + '/redirect'), /HTTP redirect/u);
    await assert.rejects(Promise.resolve().then(() => fetch('https://example.com')), /network guard denied/u);
    assert.throws(() => connect(443, 'example.com'), /network guard denied/u);
    assert.throws(() => new Socket().connect({ port: 443, host: '8.8.8.8' }), /network guard denied/u);
    await assert.rejects(Promise.resolve().then(() => dns.promises.resolve4('example.com')), /network guard denied/u);
    await assert.rejects(Promise.resolve().then(() => dns.promises.resolve4('127.0.0.1')), /network guard denied/u);
    assert.throws(() => tls.connect({ host: 'example.com', port: 443 }), /network guard denied/u);
    assert.throws(() => tls.connect(443, 'example.com'), /network guard denied/u);
    const udp = new DgramSocket('udp4');
    assert.throws(() => udp.send(Buffer.from('blocked'), 9, '8.8.8.8'), /network guard denied/u);
    udp.close();
    server.close();
    await once(server, 'close');
  `
  const result = spawnSync(process.execPath, ['--import', packetProtectorUrl, '--import', preload, '--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
})

test('Compose binds the pinned dependency services to loopback on the reviewed p14 ports', async () => {
  const compose = await read('compose.local-full-stack.yml')
  for (const mapping of ['56340:5432', '56341:6379', '56342:9000', '56343:9001', '56347:3310']) {
    assert.ok(compose.includes(mapping.split(':')[0]), `Missing published loopback port ${mapping.split(':')[0]}`)
  }
  for (const mapping of ['56340:56340', '56341:56341', '56342:56342', '56343:56343', '56347:56347']) {
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${mapping}`, 'u'))
  }
  const internalNetwork = compose.match(/  nC-internal:\r?\n([\s\S]*?)(?=\r?\n  [A-Za-z0-9_-]+:|$)/u)
  assert.ok(internalNetwork)
  assert.match(internalNetwork[1], /internal:\s*true/u)
  const ingressNetwork = compose.match(/  nC-ingress:\r?\n([\s\S]*?)(?=\r?\n\S|$)/u)
  assert.ok(ingressNetwork)
  assert.doesNotMatch(ingressNetwork[1], /internal:\s*true/u)
  assert.match(compose, /const allowed=new Set\(\['postgres:5432','redis:6379','minio:9000','minio:9001','clamav:3310'\]\)/u)
  assert.match(compose, /local proxy destination denied/u)
  assert.doesNotMatch(compose, /cap_add:\s*\[NET_ADMIN\]/u)
  assert.match(compose, /name:\s*nC-local-full-stack/u)
  assert.match(compose, /container_name:\s*nC-port-proxy/u)
  assert.match(compose, /name:\s*nC-local-full-stack-ingress/u)
  assert.match(compose, /56340:\['postgres',5432\]/u)
  assert.match(compose, /56347:\['clamav',3310\]/u)
  const images = [...compose.matchAll(/^\s+image:\s+([^\s]+)\s*$/gmu)].map((match) => match[1])
  assert.equal(images.length, 6)
  for (const image of images) assert.match(image, /@sha256:[a-f0-9]{64}$/u)
})

test('launcher uses exact p14 ports, loopback Next binds, the guarded migration, and owner data paths', async () => {
  const script = await read('scripts/local-full-stack.mjs')
  for (const port of [56340, 56341, 56342, 56343, 56344, 56345, 56346, 56347]) assert.ok(script.includes(String(port)))
  assert.match(script, /--hostname', '127\.0\.0\.1/u)
  assert.doesNotMatch(script, /'--webpack'/u)
  assert.match(script, /migrate-disposable-db\.mjs/u)
  assert.match(script, /PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1'/u)
  assert.match(script, /'exec', 'tsx', 'prisma\/local-full-stack-seed\.ts'/u)
  assert.match(script, /response\.status < 300/u)
  assert.match(script, /last HTTP status/u)
  assert.match(script, /'context', 'inspect'/u)
  assert.match(script, /info\.stdout\.trim\(\) !== 'linux'/u)
  assert.match(script, /assertResetTarget/u)
  assert.match(script, /assertLoopbackListener/u)
  assert.match(script, /async function processParentPid\(pid\)/u)
  assert.match(script, /async function isDescendantOf\(pid, ancestorPid\)/u)
  assert.match(script, /marker: nextCli/u)
  assert.match(script, /detached: true/u)
  assert.match(script, /await isDescendantOf\(row\.pid, record\.pid\)/u)
  assert.match(script, /TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD/u)
  assert.match(script, /INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'true'/u)
  assert.match(script, /INTAKE_CLAMAV_HOST: '127\.0\.0\.1'/u)
  assert.match(script, /'clamav', 'port-proxy'/u)
  assert.match(script, /path\.join\(appRoot, '\.next-local-staging', 'packet-14'\)/u)
  const workerEnvironment = script.slice(script.indexOf('const workerEnv = safeChildEnvironment('), script.indexOf('const workerCwd ='))
  assert.match(workerEnvironment, /CLERK_SECRET_KEY: 'p14-fixture-no-clerk-call'/u)
  assert.match(workerEnvironment, /CLERK_PUBLISHABLE_KEY: 'p14-fixture-no-clerk-call'/u)
  assert.match(workerEnvironment, /TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD: '1'/u)
  const appEnvironment = script.slice(script.indexOf('function appEnvironment('), script.indexOf('function installNetworkGuard('))
  assert.match(appEnvironment, /CLERK_SECRET_KEY: 'p14-fixture-no-clerk-call'/u)
  assert.match(appEnvironment, /CLERK_PUBLISHABLE_KEY: 'p14-fixture-no-clerk-call'/u)
  assert.match(script, /process\.platform === 'win32' \? 'docker-compose\.exe'/u)
  const resetBody = script.slice(script.indexOf('async function reset('), script.indexOf('async function dockerAvailable('))
  assert.match(resetBody, /await prepareFolders\(paths\)/u)
  assert.match(resetBody, /if \(!\(await dockerAvailable\(\)\)\) refuse\('local Docker engine is unavailable; reset will not delete owner data'\)/u)
  assert.ok(resetBody.indexOf('dockerAvailable') < resetBody.indexOf('await stopTracked'))
  assert.ok(resetBody.indexOf('dockerAvailable') < resetBody.indexOf('await rm(target'))
})

test('seed uses the three agreed invented venues and identity/tenant fixtures', async () => {
  const seed = await read('packages/db/prisma/local-full-stack-seed.ts')
  for (const token of [
    'user_LocalAdmin', 'user_LocalOwnerA', 'user_LocalOwnerB',
    'org_LocalTenantA', 'org_LocalTenantB',
    'aurora-science-museum', 'pocket-collection-museum', 'riverbend-nature-centre',
    'venueKnowledgeEntry',
  ]) assert.ok(seed.includes(token), `Missing seed marker: ${token}`)
  for (const match of seed.matchAll(/\bid: '(c[a-z0-9]+)'/gu)) assert.match(match[1], /^c[a-z0-9]{24}$/u)
  assert.match(seed, /56340/u)
  assert.match(seed, /qr=http:\/\/127\.0\.0\.1:56345\/\$\{venue\.slug\}/u)
  assert.match(seed, /production/u)
  assert.doesNotMatch(seed, /seed\.ts/u)
})

test('root package scripts expose the four local lifecycle actions', async () => {
  const packageJson = JSON.parse(await read('package.json'))
  assert.equal(packageJson.scripts['local:up'], 'node scripts/local-full-stack.mjs up')
  assert.equal(packageJson.scripts['local:down'], 'node scripts/local-full-stack.mjs down')
  assert.equal(packageJson.scripts['local:reset'], 'node scripts/local-full-stack.mjs reset')
  assert.equal(packageJson.scripts['local:status'], 'node scripts/local-full-stack.mjs status')
})
