import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scanner = resolve(fileURLToPath(new URL('./verify-local-fixture-auth-bundle.mjs', import.meta.url)))

test('production scanner reads both build trees and rejects auth shims in manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p14-auth-bundle-scan-'))
  const web = join(root, 'web')
  const dashboard = join(root, 'dashboard')
  try {
    await mkdir(web)
    await mkdir(dashboard)
    await writeFile(join(web, 'app.js'), 'ordinary production bundle')
    await writeFile(join(dashboard, 'app.js'), 'ordinary production bundle')
    const run = () => spawnSync(process.execPath, [scanner, web, dashboard], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    })

    assert.equal(run().status, 0)
    await writeFile(join(dashboard, 'trace.json'), '{"file":"local-fixture/server"}')
    const manifestFailure = run()
    assert.notEqual(manifestFailure.status, 0)
    assert.match(manifestFailure.stderr, /Fixture auth appeared in production bundle/u)

    await rm(join(dashboard, 'trace.json'))
    await writeFile(join(web, 'app.js.map'), '{"source":"torchiko-local-fixture-auth-p14"}')
    const sourceMapFailure = run()
    assert.notEqual(sourceMapFailure.status, 0)
    assert.match(sourceMapFailure.stderr, /Fixture auth appeared in production bundle/u)

    await rm(join(web, 'app.js.map'))
    await rm(join(dashboard, 'app.js'))
    await writeFile(join(dashboard, 'trace.json'), '{"safe":true}')
    const manifestsOnlyFailure = run()
    assert.notEqual(manifestsOnlyFailure.status, 0)
    assert.match(manifestsOnlyFailure.stderr, /No JavaScript found in build directory/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
