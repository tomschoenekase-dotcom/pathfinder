import { describe, expect, it } from 'vitest'

import {
  CLIENT_PORTAL_LIFECYCLES,
  resolveClientPortalLifecycle,
  type ClientPortalLifecycleEvidence,
} from './client-portal-lifecycle'

const base = (): ClientPortalLifecycleEvidence => ({
  isActive: false,
  publicContentCount: 0,
  wasLive: false,
  collectingSourceCount: 0,
  processingSourceCount: 0,
  reviewSourceCount: 0,
  intakeProposalCount: 0,
  packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
  hasActiveOffboarding: false,
})

describe('client portal lifecycle resolver', () => {
  const cases: Array<[string, Partial<ClientPortalLifecycleEvidence>]> = [
    ['SETUP_REQUESTED', {}],
    ['COLLECTING', { collectingSourceCount: 1 }],
    ['PROCESSING', { processingSourceCount: 1 }],
    ['INTERNAL_REVIEW', { intakeProposalCount: 1 }],
    ['CLIENT_PREVIEW', { packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 } }],
    ['REVISIONS', { packageCounts: { draft: 1, approved: 0, applied: 1, reverted: 0 } }],
    ['READY', { packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 } }],
    ['LIVE', { isActive: true, publicContentCount: 1 }],
    ['PAUSED', { wasLive: true }],
    ['OFFBOARDING', { hasActiveOffboarding: true }],
  ]

  it.each(cases)('derives %s from persisted evidence', (state, override) => {
    expect(resolveClientPortalLifecycle({ ...base(), ...override }).state).toBe(state)
  })

  it('has a human-facing view for every contract state without internal implementation terms', () => {
    expect(cases.map(([state]) => state)).toEqual(CLIENT_PORTAL_LIFECYCLES)
    for (const [state, override] of cases) {
      const view = resolveClientPortalLifecycle({ ...base(), ...override })
      expect(view.state).toBe(state)
      expect(`${view.label} ${view.headline} ${view.summary}`).not.toMatch(
        /package|worker|queue|database|analytics|agent/iu,
      )
    }
  })

  it('gives offboarding and paused evidence precedence over otherwise-live content', () => {
    expect(
      resolveClientPortalLifecycle({
        ...base(),
        isActive: true,
        publicContentCount: 2,
        hasActiveOffboarding: true,
      }).state,
    ).toBe('OFFBOARDING')
    expect(
      resolveClientPortalLifecycle({
        ...base(),
        publicContentCount: 2,
        wasLive: true,
      }).state,
    ).toBe('PAUSED')
  })
})
