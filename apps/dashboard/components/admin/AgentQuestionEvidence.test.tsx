/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentQuestionEvidence } from './AgentQuestionEvidence'

afterEach(cleanup)

describe('AgentQuestionEvidence', () => {
  it('renders bounded evidence and a primitive proposed interpretation without granting authority', async () => {
    const { container } = render(
      <AgentQuestionEvidence
        evidence={[
          {
            label: 'Public source',
            reference: 'https://example.com/hours',
            summary: 'The official hours page lists a 9 AM opening.',
          },
          {
            label: 'Staff answer',
            reference: 'intake-review:run-1:venue.operations.hours',
            summary: 'Operations reported a 10 AM opening.',
          },
          { label: 'Unsafe reference', reference: 'javascript:alert(1)' },
          { label: 'Malformed item' },
        ]}
        proposedAnswer={{
          draft: 'Use 10 AM pending a source amendment',
          confidence: 0.72,
          safe: true,
        }}
      />,
    )

    expect(screen.getByText('Evidence')).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'https://example.com/hours' }).getAttribute('href'),
    ).toBe('https://example.com/hours')
    expect(screen.getByText('intake-review:run-1:venue.operations.hours')).toBeTruthy()
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull()
    expect(screen.getByText('Proposed interpretation')).toBeTruthy()
    expect(screen.getByText('Use 10 AM pending a source amendment')).toBeTruthy()
    expect(screen.getByText(/does not approve, apply, or publish/i)).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('stays absent for malformed or empty decision metadata', () => {
    const { container } = render(
      <AgentQuestionEvidence
        evidence={{ label: 'not-an-array' }}
        proposedAnswer={['not-a-record']}
      />,
    )
    expect(container.innerHTML).toBe('')
  })
})
