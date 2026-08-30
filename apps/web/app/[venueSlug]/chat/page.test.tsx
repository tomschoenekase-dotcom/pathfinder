import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useParams: () => ({ venueSlug: 'museum' }),
  useSearchParams: () => new URLSearchParams('source=qr&prompt=Tell+me+about+the+Tide+Clock.'),
}))

vi.mock('../../../components/VenueChatExperience', () => ({
  VenueChatExperience: ({
    venueSlug,
    presentation,
    initialDraft,
    entrySource,
  }: Record<string, string>) => (
    <div>{`${presentation}:${venueSlug}:${entrySource}:${initialDraft}`}</div>
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

    expect(screen.getByText('standalone:museum:qr:Tell me about the Tide Clock.')).toBeTruthy()
  })
})
