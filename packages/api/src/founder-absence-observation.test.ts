import { describe, expect, it } from 'vitest'

import { applyFounderAbsenceObservationHistory } from './founder-absence-observation'
import { deriveFounderAbsenceReadiness } from './routers/admin/attention-founder-absence'

const page = <T>(items: T[] = []) => ({ items, nextCursor: null })

function currentReadiness() {
  return deriveFounderAbsenceReadiness({
    generatedAt: new Date('2026-08-28T12:00:00.000Z'),
    jobs: page(),
    evaluations: page(),
    approvals: page(),
    support: page(),
    questions: page(),
    blockedAgents: page(),
    events: page(),
    platformEvents: page(),
    agentTrustEvidence: {
      actions: { denied: 0 },
      customerSignals: { negative: 0 },
      rollbackEvidence: { distinctActions: 0 },
      policyViolationEvidence: { observations: 0 },
      boundedSnapshot: { hasMore: false },
    },
  })
}

function observation(day: number, evidenceComplete = true) {
  const date = new Date(Date.UTC(2026, 7, day, 12))
  return {
    id: `observation-${day}`,
    observedOn: date,
    capturedAt: date,
    releaseSha: 'a'.repeat(40),
    snapshotHash: 'b'.repeat(64),
    snapshot: {},
    evidenceComplete,
  }
}

describe('applyFounderAbsenceObservationHistory', () => {
  it('keeps the maturity test not started without a retained daily sample', () => {
    const result = applyFounderAbsenceObservationHistory(currentReadiness(), [])

    expect(result.target).toMatchObject({
      certification: 'NOT_CERTIFIED',
      observationState: 'NOT_STARTED',
      observedDays: 0,
      launchGate: false,
    })
    expect(result.observationHistory).toMatchObject({ retainedDays: 0, consecutiveDays: 0 })
  })

  it('reports progress for consecutive complete samples without certifying maturity', () => {
    const result = applyFounderAbsenceObservationHistory(
      currentReadiness(),
      [observation(26), observation(27), observation(28)],
      new Date('2026-08-28T23:00:00.000Z'),
    )

    expect(result.target).toMatchObject({
      certification: 'NOT_CERTIFIED',
      observationState: 'IN_PROGRESS',
      observedDays: 3,
    })
    expect(result.evidenceWindow.historicalContinuityVerified).toBe(false)
  })

  it('resets the uninterrupted streak after a missing date', () => {
    const result = applyFounderAbsenceObservationHistory(currentReadiness(), [
      observation(23),
      observation(24),
      observation(27),
      observation(28),
    ])

    expect(result.observationHistory).toMatchObject({ retainedDays: 4, consecutiveDays: 2 })
    expect(result.target.observedDays).toBe(2)
  })

  it('requires complete evidence for every day in the current streak', () => {
    const result = applyFounderAbsenceObservationHistory(currentReadiness(), [
      observation(26),
      observation(27, false),
      observation(28),
    ])

    expect(result.observationHistory).toMatchObject({ consecutiveDays: 1, incompleteSamples: 1 })
    expect(result.target).toMatchObject({ observationState: 'IN_PROGRESS', observedDays: 1 })
  })

  it('makes seven complete days ready for human review while keeping certification false', () => {
    const result = applyFounderAbsenceObservationHistory(
      currentReadiness(),
      [22, 23, 24, 25, 26, 27, 28].map((day) => observation(day)),
      new Date('2026-08-30T12:00:00.000Z'),
    )

    expect(result.target).toMatchObject({
      certification: 'NOT_CERTIFIED',
      observationState: 'READY_FOR_REVIEW',
      observedDays: 7,
      launchGate: false,
    })
    expect(result.observationHistory).toMatchObject({
      consecutiveDays: 7,
      stale: true,
      immutableDailySamples: true,
    })
    expect(result.evidenceWindow.historicalContinuityVerified).toBe(true)
  })
})
