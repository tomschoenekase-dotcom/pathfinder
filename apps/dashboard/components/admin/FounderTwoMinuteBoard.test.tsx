/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'

import { deriveTwoMinuteItems, FounderTwoMinuteBoard } from './FounderTwoMinuteBoard'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

function fixture(size: number) {
  const questions = Array.from({ length: size }, (_, index) => ({
    id: `question-${index}`,
    tenantId: `tenant-${index}`,
    venueId: `venue-${index}`,
    question:
      index === size - 1
        ? 'Visitor chat is failing at the west entrance'
        : `Confirm non-blocking label ${index}`,
    context: null,
    questionType: 'YES_NO',
    category: 'fixture-observation',
    urgency: index === size - 1 ? 'URGENT' : 'LOW',
    choices: ['Yes', 'No'],
    dueAt: null,
    evidence: [],
    proposedAnswer: null,
    blocking: index === size - 1,
    createdAt: new Date('2026-09-07T10:00:00.000Z'),
    updatedAt: new Date('2026-09-07T10:00:00.000Z'),
    agentIdentity: { name: 'Fixture observer' },
    agentRun: null,
  }))
  return {
    questions: {
      items: questions,
      nextCursor: size >= 50 ? { createdAt: '2026-09-07T10:00:00.000Z', id: 'older' } : null,
    },
    approvals: { items: [], nextCursor: null },
    events: { items: [], nextCursor: null },
    platformEvents: { items: [], nextCursor: null },
    blockedAgents: { items: [], nextCursor: null },
    completedAgents: {
      items: [
        {
          id: 'done-1',
          tenantId: 'tenant-done',
          venueId: 'venue-done',
          requestedOperation: 'Review retained source',
          status: 'COMPLETED',
          runType: 'REVIEW',
          createdAt: new Date(),
          completedAt: new Date(),
          agentIdentityId: 'agent-1',
          agentIdentity: { id: 'agent-1', name: 'Evidence reviewer' },
          _count: { outcomeObservations: 1 },
        },
      ],
      nextCursor: null,
    },
  } as never
}

describe('FounderTwoMinuteBoard', () => {
  afterEach(cleanup)
  it('supports keyboard navigation and links the active tab to its panel', () => {
    render(<FounderTwoMinuteBoard data={fixture(5)} />)
    const action = screen.getByRole('tab', { name: /Needs action/ })
    action.focus()
    fireEvent.keyDown(action, { key: 'ArrowRight' })
    const later = screen.getByRole('tab', { name: /Can wait/ })
    expect(document.activeElement).toBe(later)
    expect(later.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(later.id)
    fireEvent.keyDown(later, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Completed/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(action)
  })
  it.each([5, 50, 500])('surfaces the sole urgent item first across %i venue records', (size) => {
    const groups = deriveTwoMinuteItems(fixture(size))
    expect(groups.now[0]?.title).toBe('Visitor chat is failing at the west entrance')
    expect(groups.now).toHaveLength(1)
    expect(groups.later).toHaveLength(size - 1)
  })

  it('moves between action, lower priority, and completed summaries without losing boundedness', async () => {
    const { container } = render(<FounderTwoMinuteBoard data={fixture(50)} />)
    expect(screen.getByText('Visitor chat is failing at the west entrance')).toBeTruthy()
    expect(screen.getByText(/older records exist beyond this bounded snapshot/)).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /Can wait/ }))
    expect(screen.getByText('Confirm non-blocking label 0')).toBeTruthy()
    expect(screen.getByText(/Showing 6 of 49 loaded items/)).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /Completed/ }))
    expect(screen.getByText('Review retained source')).toBeTruthy()
    expect(screen.getByText(/1 recorded outcome signal/)).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
