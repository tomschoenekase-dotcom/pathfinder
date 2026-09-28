import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('source-run verifier reports a fixed invalid-input code without an API call', () => {
  const result = spawnSync(process.execPath, ['scripts/staging-release/verify-source-run.mjs', 'not-a-run', 'a'.repeat(40)], {
    encoding: 'utf8', shell: false, windowsHide: true,
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo' },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim(), JSON.stringify({ ok: false, code: 'invalid-source-run-input' }))
})
