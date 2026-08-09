/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { PlaceCard } from './PlaceCard'

describe('PlaceCard', () => {
  afterEach(cleanup)

  it('reveals descriptive details through a keyboard-operable control', () => {
    const onCardClick = vi.fn()
    render(
      <PlaceCard
        id="place_1"
        name="Visitor policy"
        type="POLICY"
        photoUrl={null}
        shortDescription="Bags are checked at entry."
        areaName="Main entrance"
        hours="Daily, 9 AM-5 PM"
        distanceMeters={undefined}
        lat={null}
        lng={null}
        onCardClick={onCardClick}
      />,
    )

    expect(screen.getByRole('article', { name: 'Visitor policy' })).toBeTruthy()
    expect(screen.queryByText('Bags are checked at entry.')).toBeNull()
    const details = screen.getByRole('button', { name: 'Show details for Visitor policy' })
    expect(details.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(details)
    expect(screen.getByText('Bags are checked at entry.')).toBeTruthy()
    expect(screen.getByText('Main entrance')).toBeTruthy()
    expect(screen.getByText('Daily, 9 AM-5 PM')).toBeTruthy()
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(onCardClick).toHaveBeenCalledWith('place_1')
  })

  it('shows directions only for a valid coordinate pair and protects image referrers', () => {
    const { rerender } = render(
      <PlaceCard
        id="place_1"
        name="Elephant House"
        type="EXHIBIT"
        photoUrl="https://images.example.com/elephants.jpg"
        shortDescription={null}
        areaName={null}
        hours={null}
        distanceMeters={125}
        lat={40.7}
        lng={-74}
      />,
    )

    expect(screen.getByRole('link', { name: 'Get directions to Elephant House' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Elephant House' }).getAttribute('referrerpolicy')).toBe(
      'no-referrer',
    )

    rerender(
      <PlaceCard
        id="place_1"
        name="Elephant House"
        type="EXHIBIT"
        photoUrl={null}
        shortDescription={null}
        areaName={null}
        hours={null}
        distanceMeters={undefined}
        lat={40.7}
        lng={null}
      />,
    )
    expect(screen.queryByRole('link', { name: 'Get directions to Elephant House' })).toBeNull()
  })
})
