/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SupportCompletionReviewFacts } from './SupportCompletionReviewFacts'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

describe('SupportCompletionReviewFacts', () => {
  it('renders exact declined summaries and review notes without effect claims', () => {
    render(
      <SupportCompletionReviewFacts
        reviewedDeclines={[
          {
            proposalSummary: 'Replace the east entrance directions.',
            reviewNote: 'The source photo did not establish a permanent route.\nKeep current text.',
          },
        ]}
      />,
    )
    expect(screen.getByText('Declined changes')).toBeTruthy()
    expect(screen.getByText('Replace the east entrance directions.')).toBeTruthy()
    expect(screen.getByText(/source photo did not establish/).textContent).toBe(
      'The source photo did not establish a permanent route.\nKeep current text.',
    )
    expect(screen.queryByText(/applied|published|fulfilled/i)).toBeNull()
  })

  it('renders nothing for historical responses without decline facts', () => {
    const { container } = render(<SupportCompletionReviewFacts />)
    expect(container.innerHTML).toBe('')
  })
})
