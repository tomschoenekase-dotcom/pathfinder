import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  classifySyntheticOperationalUpdate,
  buildSyntheticVisitorSimulation,
} from './lib/synthetic-visitor-simulation.mjs'
import { loadScenarioRegistry, simulateScenarioVisitor } from './lib/torchiko-developer-tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('operational update lifecycle uses canonical boundary ordering', () => {
  const base = {
    id: 'update-1',
    title: 'Synthetic update',
    status: 'PUBLISHED',
    isActive: true,
    startsAt: '2026-08-24T16:00:00.000Z',
    expiresAt: '2026-08-24T18:00:00.000Z',
  }
  assert.equal(
    classifySyntheticOperationalUpdate(
      { ...base, status: 'DRAFT' },
      new Date('2026-08-24T17:00:00Z'),
    ).lifecycle,
    'DRAFT',
  )
  assert.equal(
    classifySyntheticOperationalUpdate(
      { ...base, isActive: false },
      new Date('2026-08-24T17:00:00Z'),
    ).lifecycle,
    'INACTIVE',
  )
  assert.equal(
    classifySyntheticOperationalUpdate(base, new Date(base.expiresAt)).lifecycle,
    'EXPIRED',
  )
  assert.equal(
    classifySyntheticOperationalUpdate(base, new Date('2026-08-24T15:59:59Z')).lifecycle,
    'SCHEDULED',
  )
  assert.equal(classifySyntheticOperationalUpdate(base, new Date(base.startsAt)).lifecycle, 'LIVE')
})

test('all canonical scenarios expose synthetic configuration and update evidence', async () => {
  const registry = await loadScenarioRegistry(root)
  assert.equal(registry.healthy, true)
  for (const scenario of registry.scenarios) {
    const report = buildSyntheticVisitorSimulation(scenario, '2026-08-24T17:00:00.000Z', 'bot')
    assert.equal(report.synthetic, true)
    assert.equal(report.providerDispatch, false)
    assert.equal(report.clientConfiguration.liveEntitlementEvaluated, false)
    assert.ok(report.operationalUpdates.all.length > 0)
  }
})

test('disabled requested mode falls back to the enabled synthetic default', async () => {
  const report = await simulateScenarioVisitor(
    root,
    'small-museum',
    '2026-08-24T17:00:00.000Z',
    'voice',
  )
  assert.deepEqual(
    {
      requestedMode: report.clientConfiguration.requestedMode,
      effectiveMode: report.clientConfiguration.effectiveMode,
      fallback: report.clientConfiguration.fallback,
      reason: report.clientConfiguration.reason,
    },
    {
      requestedMode: 'voice',
      effectiveMode: 'bot',
      fallback: true,
      reason: 'requested-mode-disabled-in-fixture',
    },
  )
})

test('enabled voice configuration preserves the requested mode', async () => {
  const report = await simulateScenarioVisitor(
    root,
    'outdoor-park',
    '2026-08-24T17:00:00.000Z',
    'voice',
  )
  assert.equal(report.clientConfiguration.effectiveMode, 'voice')
  assert.equal(report.clientConfiguration.fallback, false)
})

test('scheduled update visibility changes exactly at start and expiry', async () => {
  const scheduled = await simulateScenarioVisitor(
    root,
    'small-museum',
    '2026-08-24T15:59:59.999Z',
    'bot',
  )
  const live = await simulateScenarioVisitor(
    root,
    'small-museum',
    '2026-08-24T16:00:00.000Z',
    'bot',
  )
  const expired = await simulateScenarioVisitor(
    root,
    'small-museum',
    '2026-08-24T18:00:00.000Z',
    'bot',
  )
  assert.equal(scheduled.operationalUpdates.all[0].lifecycle, 'SCHEDULED')
  assert.equal(scheduled.operationalUpdates.visible.length, 0)
  assert.equal(live.operationalUpdates.all[0].lifecycle, 'LIVE')
  assert.equal(live.operationalUpdates.visible.length, 1)
  assert.equal(expired.operationalUpdates.all[0].lifecycle, 'EXPIRED')
  assert.equal(expired.operationalUpdates.visible.length, 0)
})

test('invalid instants and requested modes fail before producing a simulation', async () => {
  const registry = await loadScenarioRegistry(root)
  const scenario = registry.scenarios[0]
  assert.throws(
    () => buildSyntheticVisitorSimulation(scenario, 'not-a-date', 'bot'),
    /instant-invalid/u,
  )
  assert.throws(
    () => buildSyntheticVisitorSimulation(scenario, '2026-08-24T17:00:00Z', 'auto'),
    /mode-invalid/u,
  )
  assert.throws(
    () =>
      classifySyntheticOperationalUpdate(
        { ...scenario.operationalUpdates[0], expiresAt: scenario.operationalUpdates[0].startsAt },
        new Date('2026-08-24T17:00:00Z'),
      ),
    /update-invalid/u,
  )
  assert.throws(
    () =>
      buildSyntheticVisitorSimulation(
        { ...scenario, visitorConfiguration: { ...scenario.visitorConfiguration, botMode: false } },
        '2026-08-24T17:00:00Z',
        'bot',
      ),
    /configuration-invalid/u,
  )
})
