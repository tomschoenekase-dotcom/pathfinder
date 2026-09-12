import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const entrypoint = new URL('./run-staging-migration-predeploy.mjs', import.meta.url)
const secret = 'SYNTHETIC-PRIVATE-ERROR-MUST-NOT-APPEAR'
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ['systemroot', 'windir', 'path', 'temp', 'tmp'].includes(key.toLowerCase()),
  ),
)

function child(args) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const process = spawn(globalThis.process.execPath, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      process.kill('SIGKILL')
    }, 5_000)
    process.stdout.on('data', (chunk) => (stdout += chunk))
    process.stderr.on('data', (chunk) => (stderr += chunk))
    process.once('error', reject)
    process.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr, timedOut, elapsed: Date.now() - started })
    })
  })
}

function finite(result, code) {
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, null)
  assert.equal(result.code, code)
  assert.equal(result.stderr.includes(secret), false)
  const held = code === 2
  assert.equal(
    result.stderr,
    `${JSON.stringify({
      ok: false,
      action: held ? 'staging-migration.application-held' : 'staging-migration.failed',
      errorCode: held ? 'migration-verified-application-held' : 'staging-migration-failed',
    })}\n`,
  )
}

async function boundary(body) {
  return child([
    '--input-type=module',
    '--eval',
    `import { withStagingApplicationHold, exitStagingPredeployFailure } from ${JSON.stringify(entrypoint.href)};
     setInterval(() => {}, 60_000);
     ${body}`,
  ])
}

test('verified hold exits 2 after cleanup despite a retained handle and flushes prior stdout', async () => {
  const result = await boundary(`
    withStagingApplicationHold({hold:true}, async () => {
      try { await Promise.resolve(); }
      finally { await Promise.resolve(); process.stdout.write('cleanup-complete\\n'.repeat(8192)); }
    }).catch(exitStagingPredeployFailure);
  `)
  finite(result, 2)
  assert.equal(result.stdout, 'cleanup-complete\n'.repeat(8192))
})

test('verification and disconnect rejection exit 1 without a false held record', async () => {
  for (const stage of ['verification', 'disconnect']) {
    const result = await boundary(`
      withStagingApplicationHold({hold:true}, async () => {
        try { if (${JSON.stringify(stage)} === 'verification') throw Error(${JSON.stringify(secret)}); }
        finally { await Promise.resolve(); if (${JSON.stringify(stage)} === 'disconnect') throw Error(${JSON.stringify(secret)}); }
      }).catch(exitStagingPredeployFailure);
    `)
    finite(result, 1)
    assert.equal(result.stdout, '')
  }
})

test('flush deadline still exits when stream callbacks never acknowledge', async () => {
  const result = await boundary(`
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk, ...args) => chunk === '' ? true : write(chunk, ...args);
    }
    withStagingApplicationHold({hold:true}, async () => {}).catch(exitStagingPredeployFailure);
  `)
  finite(result, 2)
  assert.ok(result.elapsed >= 1_900)
})

test('actual entrypoint refuses invalid admission with exit 1 despite a retained handle', async () => {
  const preload = `data:text/javascript,${encodeURIComponent('setInterval(() => {}, 60_000)')}`
  const result = await child(['--import', preload, fileURLToPath(entrypoint)])
  finite(result, 1)
  assert.equal(result.stdout, '')
})
