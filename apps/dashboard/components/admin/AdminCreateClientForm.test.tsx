/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminCreateClientForm } from './AdminCreateClientForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { createClientAndVenue: { mutate: mocks.create } } }),
}))

describe('AdminCreateClientForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('synchronously fences same-tick duplicate provider-backed creation', () => {
    mocks.create.mockImplementation(() => new Promise(() => undefined))
    render(<AdminCreateClientForm />)
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'Northstar' } })
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Lobby' } })
    const form = screen.getByRole('button', { name: /Create client/ }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(mocks.create).toHaveBeenCalledOnce()
  })
})
