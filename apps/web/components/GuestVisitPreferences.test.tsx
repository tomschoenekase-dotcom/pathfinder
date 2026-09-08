/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { GuestVisitPreferences } from './GuestVisitPreferences'

afterEach(cleanup)

const context = {
  visitedPlaceIds: ['place-1', 'place-2'],
  interests: ['trains'],
  remainingMinutes: 30,
}

describe('GuestVisitPreferences', () => {
  it('shows explicit visit count, validates fields, and saves a bounded update', () => {
    const onChange = vi.fn(() => true)
    render(<GuestVisitPreferences context={context} onChange={onChange} onFreshVisit={vi.fn()} />)
    fireEvent.click(screen.getByText('Your visit'))
    expect(screen.getByText('Explicitly visited places:')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Interests/), { target: { value: 'a, b, c, d, e, f' } })
    fireEvent.change(screen.getByLabelText(/Time left/), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    expect(screen.getByRole('alert').textContent).toContain('up to 5 interests')
    expect(screen.getByRole('alert').textContent).toContain('whole number from 1 to 600')
    fireEvent.change(screen.getByLabelText(/Interests/), {
      target: { value: 'trains, local history' },
    })
    fireEvent.change(screen.getByLabelText(/Time left/), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    expect(onChange).toHaveBeenCalledWith({
      visitedPlaceIds: ['place-1', 'place-2'],
      interests: ['trains', 'local history'],
      remainingMinutes: 45,
    })
  })

  it('marks only explicitly checked visible places and preserves unseen IDs', () => {
    const onChange = vi.fn(() => true)
    render(
      <GuestVisitPreferences
        context={{ visitedPlaceIds: ['unseen-place'], interests: [], remainingMinutes: null }}
        places={[
          { id: 'visible-1', name: 'North Gallery' },
          { id: 'visible-1', name: 'Duplicate' },
        ]}
        onChange={onChange}
        onFreshVisit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('Your visit'))
    expect(screen.getByLabelText('North Gallery')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('North Gallery'))
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    expect(onChange).toHaveBeenCalledWith({
      visitedPlaceIds: ['unseen-place', 'visible-1'],
      interests: [],
      remainingMinutes: null,
    })
  })

  it('shows an accessible limit error when a twenty-first place is selected', () => {
    const places = Array.from({ length: 21 }, (_, index) => ({
      id: `place-${index}`,
      name: `Place ${index}`,
    }))
    render(
      <GuestVisitPreferences
        context={{
          visitedPlaceIds: Array.from({ length: 20 }, (_, index) => `visited-${index}`),
          interests: [],
          remainingMinutes: null,
        }}
        places={places}
        onChange={() => true}
        onFreshVisit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('Your visit'))
    fireEvent.click(screen.getByLabelText('Place 0'))
    expect(screen.getByRole('alert').textContent).toContain('up to 20 visited places')
  })

  it('resets unsaved drafts when context changes and invokes fresh visit', () => {
    const onFreshVisit = vi.fn()
    const { rerender } = render(
      <GuestVisitPreferences context={context} onChange={() => true} onFreshVisit={onFreshVisit} />,
    )
    fireEvent.click(screen.getByText('Your visit'))
    fireEvent.change(screen.getByLabelText(/Interests/), { target: { value: 'unsaved' } })
    rerender(
      <GuestVisitPreferences
        context={{ visitedPlaceIds: [], interests: ['new interest'], remainingMinutes: null }}
        onChange={() => true}
        onFreshVisit={onFreshVisit}
      />,
    )
    expect((screen.getByLabelText(/Interests/) as HTMLInputElement).value).toBe('new interest')
    fireEvent.click(screen.getByRole('button', { name: 'Start a fresh visit' }))
    expect(onFreshVisit).toHaveBeenCalledOnce()
  })

  it('disables every control while disabled', () => {
    render(
      <GuestVisitPreferences
        context={context}
        onChange={() => true}
        onFreshVisit={vi.fn()}
        disabled
      />,
    )
    fireEvent.click(screen.getByText('Your visit'))
    expect((screen.getByLabelText(/Interests/) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(/Time left/) as HTMLInputElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save preferences' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Start a fresh visit' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
