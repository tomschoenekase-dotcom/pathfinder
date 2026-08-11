import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useParams: () => ({ venueSlug: 'museum' }),
  useSearchParams: () => new URLSearchParams('prompt=Tell+me+about+the+Tide+Clock.'),
}))

vi.mock('../../../components/VenueChatExperience', () => ({
  VenueChatExperience: ({ venueSlug, presentation, initialDraft }: Record<string, string>) => (
    <div>{`${presentation}:${venueSlug}:${initialDraft}`}</div>
  ),
}))

import VenueChatPage from './page'

describe('standalone venue chat route', () => {
  beforeEach(() => {
    cleanup()
    vi.stubGlobal('React', React)
  })

  it('renders the shared experience in standalone presentation', () => {
    render(<VenueChatPage />)

    expect(screen.getByText('standalone:museum:Tell me about the Tide Clock.')).toBeTruthy()
  })
})
