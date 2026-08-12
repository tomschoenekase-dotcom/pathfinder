/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AdminError from '../app/(admin)/admin/error'
import AdminLoading from '../app/(admin)/admin/loading'
import OperationsError from '../app/(admin)/admin/operations/error'
import OperationsLoading from '../app/(admin)/admin/operations/loading'
import ClientPortalLoading from '../app/(app)/loading'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('Packet 2 authenticated surface route states', () => {
  afterEach(cleanup)

  it('announces responsive Admin OS loading without exposing fake operational data', () => {
    render(<AdminLoading />)

    const status = screen.getByRole('status', { name: 'Loading PathFinder operations' })
    expect(status.textContent).toContain('Loading PathFinder operations')
    expect(status.querySelectorAll('.motion-reduce\\:animate-none').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/client-|incident-|failed job/iu)
  })

  it('focuses the Admin OS error, describes non-mutation, and offers an explicit retry', () => {
    const reset = vi.fn()
    render(<AdminError error={new Error('hidden detail')} reset={reset} />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('No client, job, incident, or agent state was changed.')
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'PathFinder OS is temporarily unavailable' }),
    )
    expect(alert.textContent).not.toContain('hidden detail')
    fireEvent.click(screen.getByRole('button', { name: 'Try loading again' }))
    expect(reset).toHaveBeenCalledOnce()
  })

  it('gives the Internal Workspace scoped loading and safe error contracts', () => {
    const reset = vi.fn()
    const { unmount } = render(<OperationsLoading />)
    expect(
      screen.getByRole('status', { name: 'Loading platform operations' }).getAttribute('aria-busy'),
    ).toBe('true')
    unmount()

    render(<OperationsError error={new Error('private stack')} reset={reset} />)
    expect(screen.getByRole('alert').textContent).toContain(
      'No retry, cancellation, or production action was attempted.',
    )
    expect(screen.getByRole('alert').textContent).not.toContain('private stack')
  })

  it('announces a responsive Client Portal skeleton without analytics or internal language', () => {
    render(<ClientPortalLoading />)

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Loading your PathFinder portal')
    expect(status.className).toContain('sm:px-6')
    expect(status.className).toContain('lg:px-10')
    expect(document.body.textContent).not.toMatch(/analytics|queue|worker|agent|package/iu)
  })
})
