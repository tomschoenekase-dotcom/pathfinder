/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('../../../../components/admin/AdminCreateClientForm', () => ({
  AdminCreateClientForm: () => <div>Client form</div>,
}))

import AdminNewClientPage from './page'

describe('AdminNewClientPage', () => {
  afterEach(cleanup)

  it('returns operators to the client directory', () => {
    render(<AdminNewClientPage />)

    expect(screen.getByRole('link', { name: '← Clients' }).getAttribute('href')).toBe(
      '/admin/directory',
    )
  })
})
