/* @vitest-environment jsdom */
import React from 'react'
import { render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it } from 'vitest'

import { ReleaseEvidenceSummary } from './ReleaseEvidenceSummary'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const evidence = {
  current: {
    revision: 'a'.repeat(40),
    readiness: 'ready-for-staging-review',
    repositoryClean: true,
    passed: 26,
    failed: 0,
    blocked: 0,
    gates: [{ id: 'typecheck', status: 'pass', durationMs: 100 }],
    limitations: ['Hosted behavior remains a separate evidence gate.'],
    rollback: {
      application: 'Redeploy the last admitted staging revision.',
      database: 'Repair forward.',
      runbook: 'docs/staging-release-workflow.md',
    },
    stagingHandoff: null,
    recordedByType: 'AGENT',
    recordedById: 'release-worker',
  },
  items: [{ id: 'evidence-1' }],
} as never

describe('release evidence summary', () => {
  it('shows exact evidence and retained authority boundaries', () => {
    render(<ReleaseEvidenceSummary evidence={evidence} />)
    expect(screen.getByRole('heading', { name: /Candidate aaaaaaaa/i })).toBeTruthy()
    expect(screen.getByText(/26 passed · 0 failed · 0 blocked/i)).toBeTruthy()
    expect(screen.getByText(/does not deploy an application/i)).toBeTruthy()
    expect(screen.getByText('Evidence only')).toBeTruthy()
    expect(screen.getByText('Not recorded')).toBeTruthy()
  })

  it('renders an honest empty state and has no automated accessibility violations', async () => {
    const { container } = render(
      <ReleaseEvidenceSummary evidence={{ current: null, items: [] } as never} />,
    )
    expect(screen.getByRole('heading', { name: /No release assessment is recorded/i })).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
