import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function probe(app, mode) {
  const source = `
    process.argv = [process.execPath, 'next', 'dev', '--hostname',
      ${JSON.stringify(mode === 'wrong-bind' ? '0.0.0.0' : '127.0.0.1')}, '--port',
      ${JSON.stringify(mode === 'wrong-port' ? '3000' : app === 'web' ? '56345' : '56346')}];
    if (${JSON.stringify(mode === 'internal-worker' || mode === 'forged-worker')})
      process.argv = [process.execPath, ${JSON.stringify('C:/fixture/node_modules/next/dist/server/lib/start-server.js')}];
    if (${JSON.stringify(mode === 'duplicate-bind')}) process.argv.push('--hostname', '0.0.0.0');
    process.env.NODE_OPTIONS = ${JSON.stringify(mode === 'no-guard' ? '' : '--import=file:///synthetic/scripts/local-full-stack.mjs')};
    if (${JSON.stringify(!['no-guard', 'spoofed-guard'].includes(mode))})
      globalThis[Symbol.for('torchiko.p14.egressGuardInstalled')] = true;
    if (${JSON.stringify(mode === 'dotenv')}) {
      const fs = await import('node:fs');
      const original = fs.default.readdirSync;
      fs.default.readdirSync = (...args) => [...original(...args), '.env.local'];
      (await import('node:module')).syncBuiltinESMExports();
    }
    const config = (await import('./apps/${app}/next.config.ts')).default;
    if (process.env.NODE_ENV === 'production' && process.env.TORCHIKO_LOCAL_FIXTURE_AUTH === '1')
      process.exit(8);
    const edge = config.webpack({resolve:{alias:{}}}, {nextRuntime:'edge',dev:true});
    const node = config.webpack({resolve:{alias:{}}}, {nextRuntime:'nodejs',dev:true});
    const browser = config.webpack({resolve:{alias:{}}}, {nextRuntime:undefined,dev:true});
    const aliases = [edge,node,browser].map(x => x.resolve.alias);
    if (process.env.TORCHIKO_LOCAL_FIXTURE_AUTH === '1') {
      if (!aliases[0]['@clerk/nextjs/server$'].endsWith('edge.ts')) process.exit(9);
      if (!aliases[1]['@clerk/nextjs/server$'].endsWith('server.ts')) process.exit(10);
      if (!aliases[2]['@clerk/nextjs$'].endsWith('client.ts')) process.exit(11);
      if (process.env.NODE_ENV === 'development') {
        try { config.webpack({resolve:{alias:{}}}, {nextRuntime:'nodejs',dev:false}); process.exit(13) }
        catch (error) { if (!String(error).includes('forbidden in a production build')) throw error }
      }
    } else if (aliases.some(x => Object.keys(x).some(k => k.startsWith('@clerk/nextjs')))) process.exit(12);
  `
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: mode === 'production' ? 'production' : 'development',
    ...(mode !== 'ordinary' ? { TORCHIKO_LOCAL_FIXTURE_AUTH: '1' } : {}),
    ...(mode !== 'no-guard' ? { TORCHIKO_LOCAL_FULL_STACK_NETWORK_GUARD: '1' } : {}),
    ...(mode === 'internal-worker' ? { NEXT_PRIVATE_WORKER: '1' } : {}),
  }
  return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000,
  })
}

for (const app of ['web', 'dashboard']) {
  test(`${app} uses fixture aliases only in development`, () => {
    const development = probe(app, 'development')
    assert.equal(development.status, 0, development.stderr)
    const ordinary = probe(app, 'ordinary')
    assert.equal(ordinary.status, 0, ordinary.stderr)
  })

  test(`${app} refuses fixture auth during a production config load`, () => {
    const production = probe(app, 'production')
    assert.notEqual(production.status, 0)
    assert.match(production.stderr, /Local fixture authentication is forbidden outside development/u)
  })

  test(`${app} refuses a non-loopback or wrong-port fixture dev command`, () => {
    for (const mode of ['wrong-bind', 'wrong-port', 'duplicate-bind', 'forged-worker']) {
      const result = probe(app, mode)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /requires the exact loopback dev command/u)
    }
  })

  test(`${app} accepts only the installed Next internal child entry with its worker marker`, () => {
    const worker = probe(app, 'internal-worker')
    assert.equal(worker.status, 0, worker.stderr)
  })

  test(`${app} refuses a missing egress guard or app dotenv file`, () => {
    for (const mode of ['no-guard', 'spoofed-guard']) {
      const noGuard = probe(app, mode)
      assert.notEqual(noGuard.status, 0)
      assert.match(noGuard.stderr, /requires the local egress guard/u)
    }
    const dotenv = probe(app, 'dotenv')
    assert.notEqual(dotenv.status, 0)
    assert.match(dotenv.stderr, /refuses app dotenv files/u)
  })
}
