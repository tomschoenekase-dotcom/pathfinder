/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

import { SupportCompletionApprovalContext } from './SupportCompletionApprovalContext'

describe('SupportCompletionApprovalContext', () => {
  it('shows the reviewed outcome before the exact completion body', () => {
    render(
      <SupportCompletionApprovalContext
        proposal={{
          completionOutcome: 'MIXED',
          body: 'The requested updates are complete.\nOne reviewed item remains unchanged.',
        }}
      />,
    )

    const outcome = screen.getByText('Updates and reviewed items')
    const body = screen.getByText(
      'The requested updates are complete. One reviewed item remains unchanged.',
    )

    expect(outcome.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(body.textContent).toBe(
      'The requested updates are complete.\nOne reviewed item remains unchanged.',
    )
  })

  it('shows reviewed declines before the founder decision body for a resolved no-change completion', () => {
    render(
      <SupportCompletionApprovalContext
        proposal={{
          completionOutcome: 'RESOLVED',
          reviewedDeclines: [
            {
              proposalSummary: 'Replace the accessible entrance directions.',
              reviewNote: 'The evidence did not establish a permanent route.',
            },
          ],
          body: 'We reviewed the requested guidance.',
        }}
      />,
    )
    const heading = screen.getByText('Declined changes')
    const body = screen.getByText('We reviewed the requested guidance.')
    expect(screen.getByText('Request resolved')).toBeTruthy()
    expect(screen.getByText('Replace the accessible entrance directions.')).toBeTruthy()
    expect(heading.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not invent an outcome for a historical proposal without one', () => {
    render(
      <SupportCompletionApprovalContext
        proposal={{ completionOutcome: null, body: 'Historical exact completion body.' }}
      />,
    )

    expect(screen.getByText('Historical exact completion body.')).toBeTruthy()
    expect(screen.queryByText('Updates applied')).toBeNull()
    expect(screen.queryByText('No change needed')).toBeNull()
    expect(screen.queryByText('Updates and reviewed items')).toBeNull()
    expect(screen.queryByText('Request resolved')).toBeNull()
  })

  it('renders nothing when the approval has no completion proposal projection', () => {
    const { container } = render(<SupportCompletionApprovalContext proposal={null} />)
    expect(container.innerHTML).toBe('')
  })
})
