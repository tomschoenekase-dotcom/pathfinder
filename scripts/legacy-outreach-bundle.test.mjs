import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = path.dirname(fileURLToPath(import.meta.url))
const suite = path.join(root, 'legacy-outreach', 'test_legacy_outreach_bundle.py')
const python = process.platform === 'win32' ? 'python' : 'python3'

test('legacy Outreach bundle exporter and reconciler pass their read-only fixture suite', () => {
  const result = spawnSync(python, [suite], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
})
