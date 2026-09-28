import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  incident: { paused: false, malformed: false },
  providerWarning: false,
}))
vi.mock('../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({
    admin: {
      overview: async () => ({
        jobs: { failed7d: 0 },
        tenants: { byStatus: { SUSPENDED: 0, TRIAL: 0 } },
      }),
      getGlobalAiControl: async () => state.incident,
      getAiProviderHealthControl: async () => ({
        malformed: state.providerWarning,
        activeUnhealthyProviders: [],
      }),
      attentionConsole: async () => ({
        questions: { items: [] },
        approvals: { items: [] },
        blockedAgents: { items: [] },
        evaluations: { items: [] },
        support: { items: [] },
        workingAgents: { items: [] },
      }),
    },
  }),
}))

import AdminOverviewPage from './page'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('Needs you home', () => {
  beforeEach(() => {
    state.incident = { paused: false, malformed: false }
    state.providerWarning = false
  })

  it('does not claim the queue is empty when the AI incident or provider control needs review', async () => {
    state.incident = { paused: true, malformed: false }
    state.providerWarning = true
    const html = renderToStaticMarkup(await AdminOverviewPage())
    expect(html).toContain('AI incident needs review')
    expect(html).toContain('AI provider routing needs review')
    expect(html).not.toContain('Nothing needs you.')
  })

  it('shows the quiet empty state when all attention signals are clear', async () => {
    const html = renderToStaticMarkup(await AdminOverviewPage())
    expect(html).toContain('Nothing needs you.')
    expect(html).not.toContain('AI incident needs review')
  })
})
