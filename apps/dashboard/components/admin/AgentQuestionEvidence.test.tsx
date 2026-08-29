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
            label: 'Walkthrough clip',
            reference: 'https://example.com/walkthrough.mp4',
            summary: 'The official hours page lists a 9 AM opening.',
            kind: 'VIDEO_TIMESTAMP',
            timestampSeconds: 94,
          },
          {
            label: 'Staff answer',
            reference: 'intake-review:run-1:venue.operations.hours',
            summary: 'Operations reported a 10 AM opening.',
          },
          {
            label: 'North entrance photo',
            reference: 'https://example.com/north-entrance.jpg',
            summary: 'Shows the accessible ramp beside the north doors.',
            kind: 'PHOTO',
          },
          { label: 'Unsafe reference', reference: 'javascript:alert(1)' },
          { label: 'Malformed item' },
        ]}
        proposedAnswer={{
          draft: 'Use 10 AM pending a source amendment',
          confidence: 0.72,
          safe: true,
          candidateEntities: [
            {
              label: 'North entrance',
              entityType: 'entrance',
              reference: 'venue-entity:north-entrance',
              summary: 'Accessible path shown in the walkthrough.',
            },
          ],
          answerConsequences: [
            {
              answer: 'Use north entrance',
              consequence: 'Visitor directions use the accessible north path.',
            },
          ],
        }}
      />,
    )

    expect(screen.getByText('Evidence')).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'https://example.com/walkthrough.mp4' })
        .getAttribute('href'),
    ).toBe('https://example.com/walkthrough.mp4')
    expect(screen.getByText(/video timestamp/i)).toBeTruthy()
    expect(screen.getByText('at 1:34')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'North entrance photo' }).getAttribute('src')).toBe(
      'https://example.com/north-entrance.jpg',
    )
    expect(
      screen.getByRole('img', { name: 'North entrance photo' }).getAttribute('referrerpolicy'),
    ).toBe('no-referrer')
    expect(screen.getByText('intake-review:run-1:venue.operations.hours')).toBeTruthy()
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull()
    expect(screen.getByText('Proposed interpretation')).toBeTruthy()
    expect(screen.getByText('Use 10 AM pending a source amendment')).toBeTruthy()
    expect(screen.getByText('72%')).toBeTruthy()
    expect(screen.getByText('Candidate entities')).toBeTruthy()
    expect(screen.getByText('North entrance')).toBeTruthy()
    expect(screen.getByText('What each answer changes')).toBeTruthy()
    expect(screen.getByText('Visitor directions use the accessible north path.')).toBeTruthy()
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
