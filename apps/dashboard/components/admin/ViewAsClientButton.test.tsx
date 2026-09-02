/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ViewAsClientButton } from './ViewAsClientButton'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('ViewAsClientButton', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the operator in place and announces a rejected audited transition', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 503 }))
    render(<ViewAsClientButton tenantId="tenant_1" tenantName="Northstar" />)

    fireEvent.click(screen.getByRole('button', { name: 'View as Northstar ->' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Admin view could not be changed. Please try again.',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/impersonate',
      expect.objectContaining({ body: JSON.stringify({ tenantId: 'tenant_1' }) }),
    )
    expect(
      (screen.getByRole('button', { name: 'View as Northstar ->' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})
