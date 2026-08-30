import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../../components/RequestDemoForm', () => ({ RequestDemoForm: () => <div>Demo form</div> }))

import RequestDemoPage, { metadata } from './page'

describe('request demo page', () => {
  it('presents a mobile-friendly remote-intake surface without pricing promises', () => {
    render(<RequestDemoPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Show us your venue.' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Request a conversation' })).toBeTruthy()
    expect(screen.getByText('Demo form')).toBeTruthy()
    expect(screen.getByText('Guest access by QR code or link, with no app download')).toBeTruthy()
    expect(screen.queryByText(/voice experiences/iu)).toBeNull()
    expect(metadata.title).toContain('Request a Torchiko demo')
  })
})
