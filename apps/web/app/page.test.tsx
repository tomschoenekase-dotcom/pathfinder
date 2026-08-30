import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/image', () => ({
  default: () => <span data-testid="next-image" />,
}))
vi.mock('@pathfinder/ui/fade-in', () => ({
  FadeIn: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}))

import WebHomePage from './page'

describe('marketing homepage', () => {
  it('states the current venue value and commercial truth without unverified claims', () => {
    render(<WebHomePage />)

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: "Give every guest a guide to the place they're in.",
      }),
    ).toBeTruthy()
    expect(screen.getByText('For guests')).toBeTruthy()
    expect(screen.getByText('For staff')).toBeTruthy()
    expect(screen.getByText('For venue teams')).toBeTruthy()
    expect(screen.getByText('Custom pricing for each venue. Setup is included.')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Talk about your venue' })).toHaveLength(2)

    expect(screen.queryByText(/set up in an afternoon/iu)).toBeNull()
    expect(screen.queryByText(/free trial/iu)).toBeNull()
    expect(screen.queryByText(/voice experiences/iu)).toBeNull()
  })
})
