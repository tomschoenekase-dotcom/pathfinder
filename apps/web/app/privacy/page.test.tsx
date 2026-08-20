import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import PrivacyPage, { metadata } from './page'

describe('privacy route', () => {
  it('renders an accessible blocking notice without inventing policy terms', () => {
    render(<PrivacyPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy information' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Approved policy pending' })).toBeTruthy()
    expect(screen.getByText(/status notice, not a privacy policy/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Return to Torchiko' }).getAttribute('href')).toBe('/')
    expect(metadata.title).toContain('Privacy information')
  })
})
