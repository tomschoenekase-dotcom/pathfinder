import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const config = JSON.parse(await readFile(path.join(root, 'railway.staging.web.json'), 'utf8'))
const [command] = config.deploy.preDeployCommand
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh'
const secret = 'SYNTHETIC-ENV-MUST-NOT-BE-PRINTED'
const body = command.match(/^sh -c '([^']+)'$/u)?.[1]

test('only staging web captures its fixed migration child status; other services stay absent', async () => {
  assert.equal(config.deploy.preDeployCommand.length, 1)
  assert.equal(
    body,
    'node /migration/scripts/run-staging-migration-predeploy.mjs; code=$?; printf "{\\"kind\\":\\"staging-predeploy-process-exit\\",\\"exitCode\\":%s}\\n" "$code"; exit "$code"',
  )
  for (const service of ['dashboard', 'workers']) {
    const other = JSON.parse(
      await readFile(path.join(root, `railway.staging.${service}.json`), 'utf8'),
    )
    assert.equal(Object.hasOwn(other.deploy, 'preDeployCommand'), false)
  }
})

for (const code of [0, 1, 2, 127]) {
  test(`the actual shell emits one finite marker and preserves child exit ${code}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'staging-exit-marker-'))
    try {
      // A separate synthetic executable substitutes only node; the complete configured
      // sh -c command runs unchanged. No migration, database or provider is contacted.
      const executable = path.join(directory, 'node')
      await writeFile(
        executable,
        `#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = /migration/scripts/run-staging-migration-predeploy.mjs ] || exit 125\nprintf 'synthetic-child-complete\\n'\nexit ${code}\n`,
      )
      await chmod(executable, 0o700)
      const result = spawnSync(shell, ['-c', command], {
        env: {
          PATH: `${directory.replaceAll('\\', '/')}${path.delimiter}${path.dirname(shell)}`,
          SYSTEMROOT: 'C:/Windows',
          FIXTURE_PRIVATE_VALUE: secret,
        },
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 16_384,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, code)
      assert.equal(result.stderr, '')
      assert.equal(
        result.stdout,
        `synthetic-child-complete\n${JSON.stringify({ kind: 'staging-predeploy-process-exit', exitCode: code })}\n`,
      )
      assert.equal(result.stdout.includes(secret), false)
      assert.equal(result.stderr.includes(secret), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('no exit marker exists while the synthetic child has not returned', () => {
  // A shell function keeps the stalled child in this one process, so the bounded
  // timeout kills no unrelated process and leaves no spawned fixture descendant.
  const result = spawnSync(shell, ['-c', `node() { while :; do :; done; }; ${body}`], {
    env: { SYSTEMROOT: 'C:/Windows', FIXTURE_PRIVATE_VALUE: secret },
    encoding: 'utf8',
    timeout: 500,
    killSignal: 'SIGKILL',
    maxBuffer: 16_384,
  })
  assert.equal(result.error?.code, 'ETIMEDOUT')
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
