/* @vitest-environment jsdom */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../components/admin/AdminCreateClientForm', () => ({
  AdminCreateClientForm: () => <p>Client form</p>,
}))

import AdminNewClientPage from './page'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('AdminNewClientPage', () => {
  it('keeps the phone return action touch-sized', () => {
    render(<AdminNewClientPage />)

    const link = screen.getByRole('link', { name: '← Clients' })
    expect(link.getAttribute('href')).toBe('/admin')
    expect(link.className).toContain('min-h-11')
  })
})
