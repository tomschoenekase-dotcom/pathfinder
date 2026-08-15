// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ClientPortalError from './error'

describe('ClientPortalError', () => {
  it('offers a plain-language retry without exposing an internal error', () => {
    const reset = vi.fn()
    render(<ClientPortalError reset={reset} />)

    expect(screen.getByRole('alert').textContent).toContain('Your portal could not be loaded')
    expect(screen.getByRole('alert').textContent).not.toMatch(/stack|trpc|database/iu)
    fireEvent.click(screen.getByRole('button', { name: 'Try loading again' }))
    expect(reset).toHaveBeenCalledOnce()
  })
})
