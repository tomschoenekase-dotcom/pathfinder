import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyEnvironmentName,
  collectEnvironmentNames,
  renderRepositoryIndex,
} from './lib/repository-index.mjs'

test('environment inventory is sorted, unique, and includes commented examples', () => {
  assert.deepEqual(
    collectEnvironmentNames('BETA=false\n# API_KEY=example-secret\nALPHA=one\nBETA=true\n'),
    ['ALPHA', 'API_KEY', 'BETA'],
  )
})

test('generated index never copies environment values', () => {
  const output = renderRepositoryIndex({
    packageJson: {
      packageManager: 'pnpm@9.15.4',
      scripts: { test: 'node --test', build: 'turbo build' },
    },
    environmentSource: 'API_KEY=super-secret-value\nNEXT_PUBLIC_WEB_URL=https://example.test\n',
  })
  assert.match(output, /`API_KEY` \| secret\/server-only/u)
  assert.match(output, /`NEXT_PUBLIC_WEB_URL` \| browser-visible/u)
  assert.match(
    output,
    /^# Repository command and configuration index\n\n> \*\*Migration instruction status: STAGING-ONLY AUTHORIZED — PRODUCTION COMMANDS REMAIN STOPPED\.\*\*/u,
  )
  assert.doesNotMatch(output, /super-secret-value|https:\/\/example\.test/u)
  assert.ok(output.indexOf('pnpm build') < output.indexOf('pnpm test'))
})

test('environment classification keeps policy and identity distinct', () => {
  assert.equal(classifyEnvironmentName('VOICE_MODE_ENABLED'), 'policy/feature gate')
  assert.equal(classifyEnvironmentName('PATHFINDER_RELEASE_SHA'), 'deployment identity')
})
