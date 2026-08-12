// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { WeeklyReportContent } from './WeeklyReportContent'

describe('WeeklyReportContent', () => {
  it('renders bounded report text as semantic paragraphs instead of preformatted raw output', () => {
    const { container } = render(
      <WeeklyReportContent
        content={'Visitors asked about parking.\n\nThe garden tour was popular.'}
      />,
    )
    expect(screen.getByText('Visitors asked about parking.')).toBeTruthy()
    expect(screen.getByText('The garden tour was popular.')).toBeTruthy()
    expect(container.querySelector('pre')).toBeNull()
  })
})
