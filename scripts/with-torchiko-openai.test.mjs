import assert from 'node:assert/strict'
import test from 'node:test'
import { torchikoEvaluationEnvironment } from './with-torchiko-openai.mjs'

test('scoped credential wins over rejected generic credential without mutating parent', () => {
  const parent = { TORCHIKO_OPENAI_API_KEY: 'fake-scoped', OPENAI_API_KEY: 'fake-generic' }
  assert.equal(torchikoEvaluationEnvironment(parent).OPENAI_API_KEY, 'fake-scoped')
  assert.equal(parent.OPENAI_API_KEY, 'fake-generic')
})
test('missing or malformed scoped credential fails without generic fallback or secret echo', () => {
  for (const key of [undefined, '', ' fake-secret', 'fake-secret\n', 'fake\nsecret']) {
    assert.throws(() => torchikoEvaluationEnvironment({ TORCHIKO_OPENAI_API_KEY: key, OPENAI_API_KEY: 'fake-generic' }), error => !error.message.includes('fake-secret') && !error.message.includes('fake-generic'))
  }
})
test('unreviewed endpoint and account overrides fail closed', () => {
  for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) {
    assert.throws(() => torchikoEvaluationEnvironment({ TORCHIKO_OPENAI_API_KEY: 'fake-scoped', [name]: 'private-value' }), error => error.message.includes(name) && !error.message.includes('private-value'))
  }
})
