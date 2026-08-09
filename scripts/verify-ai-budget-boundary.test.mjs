import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyAiBudgetSource } from './verify-ai-budget-boundary.mjs'

test('AI budget boundary accepts direct and propagated budget gates', () => {
  const result = verifyAiBudgetSource(`
    generateText({ modelKey, budgetGate })
    generateEmbedding({ modelKey, budgetGate: params.budgetGate })
  `)
  assert.equal(result.callCount, 2)
  assert.deepEqual(result.failures, [])
})

test('AI budget boundary rejects an unbudgeted gateway call', () => {
  const result = verifyAiBudgetSource(`generateEmbeddings({ modelKey, texts })`)
  assert.equal(result.callCount, 1)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /lacks definite budgetGate/u)
})

test('AI budget boundary recognizes aliases and member calls and rejects conditional omission', () => {
  const result = verifyAiBudgetSource(`
    import { generateText as textGateway } from '@pathfinder/ai'
    textGateway({ modelKey, budgetGate: undefined })
    ai.generateEmbedding({ modelKey, ...(budgetGate ? { budgetGate } : {}) })
  `)
  assert.equal(result.callCount, 2)
  assert.equal(result.failures.length, 2)
})
