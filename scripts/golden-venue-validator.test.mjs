import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

test('keeps the Golden Venue lifecycle and disposable-proof scope machine validated', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/golden-venue/validate.mjs')], {
    cwd: resolve('.'),
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /13 phases; 7 failure injections; 7 disposable phases/u)
})
