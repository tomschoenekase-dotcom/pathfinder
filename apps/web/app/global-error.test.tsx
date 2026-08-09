/* @vitest-environment jsdom */

import React, { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }))

import { GlobalErrorContent } from './global-error'

describe('GlobalErrorContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('reports each error occurrence once even under Strict Mode', async () => {
    const firstError = Object.assign(new Error('private first failure'), {
      digest: 'private-first-digest',
    })
    const reset = vi.fn()
    const { rerender } = render(
      <StrictMode>
        <GlobalErrorContent error={firstError} reset={reset} />
      </StrictMode>,
    )

    await waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce())
    expect(mocks.captureException).toHaveBeenLastCalledWith(firstError)

    rerender(
      <StrictMode>
        <GlobalErrorContent error={firstError} reset={reset} />
      </StrictMode>,
    )
    expect(mocks.captureException).toHaveBeenCalledOnce()

    const repeatedError = Object.assign(new Error('private repeated failure'), {
      digest: 'private-repeated-digest',
    })
    rerender(
      <StrictMode>
        <GlobalErrorContent error={repeatedError} reset={reset} />
      </StrictMode>,
    )
    await waitFor(() => expect(mocks.captureException).toHaveBeenCalledTimes(2))
    expect(mocks.captureException).toHaveBeenLastCalledWith(repeatedError)
  })

  it('keeps details private and offers a focused, contained recovery control', async () => {
    const error = Object.assign(new Error('venue museum-secret failed for visitor 123'), {
      digest: 'private-digest-456',
      stack: 'private-stack-location',
    })
    const reset = vi.fn()

    render(<GlobalErrorContent error={error} reset={reset} />)

    const heading = screen.getByRole('heading', { name: 'Something went wrong' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('main').getAttribute('aria-labelledby')).toBe('global-error-heading')
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.body.textContent).not.toContain('museum-secret')
    expect(document.body.textContent).not.toContain('visitor 123')
    expect(document.body.textContent).not.toContain('private-digest-456')
    expect(document.body.textContent).not.toContain('private-stack-location')

    const retry = screen.getByRole('button', { name: 'Try again' })
    expect(retry.getAttribute('type')).toBe('button')
    expect(retry.className).toContain('min-h-11')
    expect(retry.style.minHeight).toBe('44px')
    expect(screen.getByRole('main').style.minHeight).toBe('100vh')
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(reset).toHaveBeenCalledTimes(2)
  })

  it('keeps recovery available when optional monitoring throws', async () => {
    mocks.captureException.mockImplementationOnce(() => {
      throw new Error('monitoring unavailable')
    })
    const reset = vi.fn()

    render(<GlobalErrorContent error={new Error('private application failure')} reset={reset} />)

    const retry = await screen.findByRole('button', { name: 'Try again' })
    fireEvent.click(retry)
    expect(reset).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).not.toBeNull()
  })
})
