import assert from 'node:assert/strict'
import test from 'node:test'
import { assertWriterHold } from './writer-hold.mjs'

const now = Date.parse('2026-09-28T06:30:00.000Z')
const sample = (at) => ({ at, queueRows: 4, auditRows: 7 })
const accepted = {
  projectId: '8621111a-4ac8-4d88-9566-4627c8a02059',
  environmentId: 'a7a394fc-aa4e-4a45-bd3c-904419a67818',
  maintenance: { enabled: true, ingressPaused: true, automaticReleaseAt: '2026-09-28T06:39:00.000Z' },
  services: { 'staging-web': 0, 'staging-dashboard': 0, 'staging-workers': 0 },
  samples: [sample('2026-09-28T06:29:00.000Z'), sample('2026-09-28T06:29:45.000Z')],
}

test('writer hold requires a bounded live TTL, all writers drained and stable observations', () => {
  assert.equal(assertWriterHold(accepted, now).ok, true)
  for (const changed of [
    { projectId: 'other' },
    { environmentId: 'other' },
    { maintenance: { ...accepted.maintenance, enabled: false } },
    { maintenance: { ...accepted.maintenance, ingressPaused: false } },
    { maintenance: { ...accepted.maintenance, automaticReleaseAt: '2026-09-28T06:30:00.000Z' } },
    { maintenance: { ...accepted.maintenance, automaticReleaseAt: 'not-a-date' } },
    { maintenance: { ...accepted.maintenance, automaticReleaseAt: '2026-09-28T07:00:00.000Z' } },
    { services: { ...accepted.services, 'staging-web': 1 } },
    { services: { ...accepted.services, 'staging-dashboard': 1 } },
    { services: { ...accepted.services, 'staging-workers': 1 } },
    { services: { ...accepted.services, 'unknown-writer': 1 } },
    { samples: [accepted.samples[0], { ...accepted.samples[1], queueRows: 5 }] },
    { samples: [accepted.samples[0], { ...accepted.samples[1], auditRows: 8 }] },
    { samples: [accepted.samples[0], sample('2026-09-28T06:29:05.000Z')] },
    { samples: [accepted.samples[0], sample('2026-09-28T06:31:00.000Z')] },
  ]) assert.throws(() => assertWriterHold({ ...accepted, ...changed }, now), /writer-hold-unverified/u)
})
