import { describe, expect, it } from 'vitest'

import { applyFounderAbsenceObservationHistory } from './founder-absence-observation'
import { deriveFounderAbsenceReadiness } from './routers/admin/attention-founder-absence'

const page = <T>(items: T[] = []) => ({ items, nextCursor: null })
const RELEASE_A = 'a'.repeat(40)
const RELEASE_C = 'c'.repeat(40)

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
    releaseSha: RELEASE_A,
    snapshotHash: 'b'.repeat(64),
    snapshot: {},
    evidenceComplete,
  }
}

describe('applyFounderAbsenceObservationHistory', () => {
  it('keeps the maturity test not started without a retained daily sample', () => {
    const result = applyFounderAbsenceObservationHistory(currentReadiness(), [], RELEASE_A)

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
      RELEASE_A,
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
    const result = applyFounderAbsenceObservationHistory(
      currentReadiness(),
      [observation(23), observation(24), observation(27), observation(28)],
      RELEASE_A,
    )

    expect(result.observationHistory).toMatchObject({ retainedDays: 4, consecutiveDays: 2 })
    expect(result.target.observedDays).toBe(2)
  })

  it('requires complete evidence for every day in the current streak', () => {
    const result = applyFounderAbsenceObservationHistory(
      currentReadiness(),
      [observation(26), observation(27, false), observation(28)],
      RELEASE_A,
    )

    expect(result.observationHistory).toMatchObject({ consecutiveDays: 1, incompleteSamples: 1 })
    expect(result.target).toMatchObject({ observationState: 'IN_PROGRESS', observedDays: 1 })
  })

  it('makes seven complete days ready for human review while keeping certification false', () => {
    const result = applyFounderAbsenceObservationHistory(
      currentReadiness(),
      [22, 23, 24, 25, 26, 27, 28].map((day) => observation(day)),
      RELEASE_A,
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

  it('resets the visible streak when the latest sample belongs to another release', () => {
    const rows = [22, 23, 24, 25, 26, 27, 28].map((day) => observation(day))
    const result = applyFounderAbsenceObservationHistory(currentReadiness(), rows, RELEASE_C)

    expect(result.target).toMatchObject({
      observationState: 'NOT_STARTED',
      observedDays: 0,
      launchGate: false,
    })
    expect(result.target.explanation).toContain('earlier application release')
    expect(result.observationHistory).toMatchObject({
      consecutiveDays: 0,
      latestReleaseSha: RELEASE_A,
      currentReleaseSha: RELEASE_C,
      latestReleaseMatchesCurrent: false,
    })
    expect(result.evidenceWindow.historicalContinuityVerified).toBe(false)
  })

  it('does not bridge a current-release streak across an intervening release', () => {
    const rows = [observation(25), observation(26), observation(27), observation(28)]
    rows[1] = { ...rows[1]!, releaseSha: RELEASE_C }
    const result = applyFounderAbsenceObservationHistory(currentReadiness(), rows, RELEASE_A)

    expect(result.observationHistory.consecutiveDays).toBe(2)
    expect(result.target.observedDays).toBe(2)
  })

  it('fails closed when exact current release identity is unavailable', () => {
    const result = applyFounderAbsenceObservationHistory(
      currentReadiness(),
      [observation(28)],
      'unknown',
    )

    expect(result.target).toMatchObject({ observationState: 'NOT_STARTED', observedDays: 0 })
    expect(result.observationHistory.currentReleaseSha).toBeNull()
    expect(result.target.explanation).toContain('release is unavailable')
  })
})
