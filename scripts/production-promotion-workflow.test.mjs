import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const promotion = readFileSync(
  new URL('../.github/workflows/production-promotion.yml', import.meta.url),
  'utf8',
)
test('promotion consumes a trusted staging admission log before live web health without a staging secret', () => {
  const proofStep = promotion.indexOf('name: Require the exact PR revision on all staging services')
  const healthStep = promotion.indexOf(
    'name: Require the exact PR revision to be healthy in staging',
  )
  assert.ok(proofStep > 0 && healthStep > proofStep)
  assert.match(promotion, /^  actions: read$/mu)
  assert.doesNotMatch(promotion, /\bsecrets\b|RAILWAY_TOKEN/u)
  assert.match(promotion, /gh run view "\$ADMISSION_RUN_ID" --log --repo "\$GITHUB_REPOSITORY"/u)
  assert.match(promotion, /ADMISSION_RUN_ID: \$\{\{ steps\.admission\.outputs\.run_id \}\}/u)
  assert.match(promotion.slice(proofStep, healthStep), /promotion-admission-evidence\.mjs verify/u)
  assert.match(
    promotion.slice(proofStep, healthStep),
    /--log "\$RUNNER_TEMP\/staging-admission\.log"/u,
  )
  assert.match(promotion.slice(proofStep, healthStep), /--release-sha "\$RELEASE_SHA"/u)
  assert.match(promotion.slice(healthStep), /--expected-revision "\$RELEASE_SHA"/u)
})
