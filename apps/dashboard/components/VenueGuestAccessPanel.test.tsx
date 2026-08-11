/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { VenueGuestAccessPanel } from './VenueGuestAccessPanel'

describe('VenueGuestAccessPanel', () => {
  afterEach(cleanup)

  it('shows a contained configuration state without a placeholder or copy action', () => {
    render(
      <VenueGuestAccessPanel
        venueId="venue_1"
        venueName="Museum"
        guestChatUrl={null}
        isVenueActive
        activePlacesCount={2}
        enabledKnowledgeCount={0}
        guideMode="non_location"
        hasCompleteCenter={false}
      />,
    )

    expect(screen.getByText('Sharing unavailable')).toBeTruthy()
    expect(screen.getByText(/public web origin is not configured/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open guest chat' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy guest chat URL' })).toBeNull()
    expect(document.body.textContent).not.toContain('your-domain.com')
  })

  it('marks an active venue with active content as ready and exposes the exact URL', () => {
    const url = 'https://guide.example.com/museum/chat'
    render(
      <VenueGuestAccessPanel
        venueId="venue_1"
        venueName="Museum"
        guestChatUrl={url}
        isVenueActive
        activePlacesCount={2}
        enabledKnowledgeCount={0}
        guideMode="location_aware"
        hasCompleteCenter
      />,
    )

    expect(screen.getByText('Review link available')).toBeTruthy()
    expect(screen.getByText(/not launch approval/i)).toBeTruthy()
    expect(screen.getByText(url)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open guest chat' }).getAttribute('href')).toBe(url)
    expect(screen.getByRole('button', { name: 'Copy guest chat URL' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Create QR kit' }).getAttribute('href')).toBe(
      '/venues/venue_1/qr-kit',
    )
  })

  it.each([
    {
      isVenueActive: false,
      activePlacesCount: 2,
      enabledKnowledgeCount: 0,
      issue: 'Venue guest access is paused.',
    },
    {
      isVenueActive: true,
      activePlacesCount: 0,
      enabledKnowledgeCount: 0,
      issue: 'Add active public content: a guide item or Knowledge entry.',
    },
  ])('does not claim share readiness while a prerequisite is missing %#', (state) => {
    render(
      <VenueGuestAccessPanel
        venueId="venue_1"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        isVenueActive={state.isVenueActive}
        activePlacesCount={state.activePlacesCount}
        enabledKnowledgeCount={state.enabledKnowledgeCount}
        guideMode="non_location"
        hasCompleteCenter={false}
      />,
    )

    expect(screen.getByText('Preview only')).toBeTruthy()
    expect(screen.getByText(state.issue)).toBeTruthy()
    expect(screen.queryByText('Review link available')).toBeNull()
  })

  it('treats enabled Knowledge as active public content without requiring a Place', () => {
    render(
      <VenueGuestAccessPanel
        venueId="venue_1"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        isVenueActive
        activePlacesCount={0}
        enabledKnowledgeCount={1}
        guideMode="non_location"
        hasCompleteCenter={false}
      />,
    )

    expect(screen.getByText('Review link available')).toBeTruthy()
    expect(screen.queryByText(/add active public content/i)).toBeNull()
  })

  it('does not require a center for a location-aware Knowledge-only guide', () => {
    render(
      <VenueGuestAccessPanel
        venueId="venue_1"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        isVenueActive
        activePlacesCount={0}
        enabledKnowledgeCount={1}
        guideMode="location_aware"
        hasCompleteCenter={false}
      />,
    )

    expect(screen.getByText('Review link available')).toBeTruthy()
    expect(screen.queryByText(/complete venue center/i)).toBeNull()
  })

  it('flags an incomplete center only for the location-aware profile', () => {
    const { rerender } = render(
      <VenueGuestAccessPanel
        venueId="venue_1"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        isVenueActive
        activePlacesCount={2}
        enabledKnowledgeCount={0}
        guideMode="location_aware"
        hasCompleteCenter={false}
      />,
    )

    expect(
      screen.getByText('Set a complete venue center for location-aware ordering.'),
    ).toBeTruthy()
    expect(screen.getByText('Preview only')).toBeTruthy()

    rerender(
      <VenueGuestAccessPanel
        venueId="venue_1"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        isVenueActive
        activePlacesCount={2}
        enabledKnowledgeCount={0}
        guideMode="non_location"
        hasCompleteCenter={false}
      />,
    )

    expect(
      screen.queryByText('Set a complete venue center for location-aware ordering.'),
    ).toBeNull()
    expect(screen.getByText('Review link available')).toBeTruthy()
  })
})
