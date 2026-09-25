import assert from 'node:assert/strict'
import test from 'node:test'

import { writeClientBundleBuildDiagnostic } from './lib/client-bundle-build-diagnostic.mjs'

test('client bundle build diagnostics are bounded, escaped, and redacted', () => {
  const chunks = []
  writeClientBundleBuildDiagnostic({
    result: {
      stdout: `${'old context\n'.repeat(100)}API_TOKEN=synthetic-value`,
      stderr: 'components/App.tsx(2,3): error TS2322: fixture failure',
    },
    application: '@pathfinder/web',
    stdout: { write: (chunk) => chunks.push(chunk) },
  })

  const annotation = chunks.join('')
  assert.ok(annotation.length <= 8_100)
  assert.match(annotation, /::error title=Client bundle build failed::@pathfinder\/web/u)
  assert.match(annotation, /API_TOKEN=\[REDACTED\]/u)
  assert.match(annotation, /components\/App\.tsx\(2,3\): error TS2322/u)
  assert.doesNotMatch(annotation, /synthetic-value/u)
})
