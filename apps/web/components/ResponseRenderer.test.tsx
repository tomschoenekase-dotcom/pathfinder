import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResponseRenderer } from './ResponseRenderer'

describe('ResponseRenderer', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('preserves the existing text and place-card response experience', () => {
    render(
      <ResponseRenderer
        content="The East Gallery is upstairs."
        places={[
          {
            id: 'east-gallery',
            name: 'East Gallery',
            type: 'EXHIBIT',
            photoUrl: null,
            shortDescription: 'Rotating textiles.',
            areaName: 'Second floor',
            hours: null,
            distanceMeters: undefined,
            lat: null,
            lng: null,
          },
        ]}
      />,
    )

    expect(screen.getByText('The East Gallery is upstairs.')).toBeTruthy()
    expect(screen.getByRole('article', { name: 'East Gallery' })).toBeTruthy()
    expect(
      screen
        .getByText('The East Gallery is upstairs.')
        .closest('[data-response-format]')
        ?.getAttribute('data-response-format'),
    ).toBe('legacy')
  })

  it('renders structured callouts, actions, citations, and place blocks accessibly', () => {
    render(
      <ResponseRenderer
        content="Legacy fallback should not be duplicated."
        blocks={[
          { type: 'text', text: 'Plan your visit.' },
          {
            type: 'callout',
            tone: 'warning',
            title: 'Temporary closure',
            text: 'Use the west entrance.',
          },
          {
            type: 'actions',
            actions: [
              { label: 'Hours', href: 'https://museum.example/hours', style: 'primary' },
              { label: 'Unsafe', href: 'javascript:alert(1)', style: 'secondary' },
            ],
          },
          {
            type: 'citations',
            citations: [{ label: 'Visitor guide', detail: 'Access information' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('Plan your visit.')).toBeTruthy()
    expect(screen.getByText('Temporary closure')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Hours/ }).getAttribute('href')).toBe(
      'https://museum.example/hours',
    )
    expect(screen.queryByRole('link', { name: /Unsafe/ })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy()
    expect(screen.queryByText('Legacy fallback should not be duplicated.')).toBeNull()
  })

  it('treats citations-only blocks as supplements to legacy text and place cards', () => {
    const citedPlace = {
      id: 'elephant-house',
      name: 'Elephant House',
      type: 'EXHIBIT',
      photoUrl: null,
      shortDescription: null,
      areaName: null,
      hours: null,
      lat: null,
      lng: null,
    }
    render(
      <ResponseRenderer
        content="The Elephant House is open."
        places={[citedPlace]}
        blocks={[
          {
            type: 'citations',
            citations: [
              {
                label: 'Official visitor guide',
                href: 'https://example.org/visit',
                detail: 'Place: Elephant House',
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('The Elephant House is open.')).toBeTruthy()
    expect(screen.getByText(citedPlace.name)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Official visitor guide/ }).getAttribute('href')).toBe(
      'https://example.org/visit',
    )
  })

  it('renders choices as keyboard-native labeled controls and returns only their bounded value', () => {
    const onChoiceSelect = vi.fn()
    render(
      <ResponseRenderer
        content=""
        onChoiceSelect={onChoiceSelect}
        blocks={[
          {
            type: 'choices',
            label: 'Choose a topic',
            choices: [
              {
                id: 'hours',
                label: 'Hours',
                accessibleLabel: 'Ask about opening hours',
                value: 'What are today’s hours?',
              },
            ],
          },
        ]}
      />,
    )
    const choice = screen.getByRole('button', { name: 'Ask about opening hours' })
    expect(choice.getAttribute('type')).toBe('button')
    fireEvent.click(choice)
    expect(onChoiceSelect).toHaveBeenCalledWith('What are today’s hours?')
  })

  it('renders HTTPS gallery metadata, semantic event times, and a map link responsively', () => {
    render(
      <ResponseRenderer
        content=""
        blocks={[
          {
            type: 'gallery',
            label: 'Gallery highlights',
            images: [
              {
                src: 'https://cdn.example/east-gallery.jpg',
                alt: 'Sunlit east gallery with two sculptures',
                caption: 'East Gallery',
              },
            ],
          },
          {
            type: 'events',
            label: 'Today’s events',
            events: [
              {
                id: 'tour',
                title: 'Gallery tour',
                startsAt: '2030-01-01T10:00:00-06:00',
                endsAt: '2030-01-01T11:00:00-06:00',
                location: 'East Gallery',
              },
            ],
          },
          {
            type: 'location',
            name: 'East entrance',
            address: '100 Museum Way',
            mapHref: 'https://maps.example/east-entrance',
          },
        ]}
      />,
    )
    expect(
      screen
        .getByRole('img', { name: 'Sunlit east gallery with two sculptures' })
        .getAttribute('referrerpolicy'),
    ).toBe('no-referrer')
    const times = document.querySelectorAll('time')
    expect([...times].map((time) => time.getAttribute('datetime'))).toEqual([
      '2030-01-01T10:00:00-06:00',
      '2030-01-01T11:00:00-06:00',
    ])
    expect(screen.getByRole('link', { name: /Open map link/ }).getAttribute('href')).toBe(
      'https://maps.example/east-entrance',
    )
  })

  it('defensively omits unsafe rich media and map URLs even for unparsed data', () => {
    render(
      <ResponseRenderer
        content="Safe text remains excellent."
        blocks={[
          {
            type: 'image',
            image: { src: 'javascript:alert(1)', alt: 'Unsafe image' },
          },
          {
            type: 'location',
            name: 'Unsafe map',
            mapHref: 'http://maps.example/location',
          },
          { type: 'text', text: 'Safe text remains excellent.' },
        ]}
      />,
    )
    expect(screen.queryByRole('img', { name: 'Unsafe image' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Open map link/ })).toBeNull()
    expect(screen.getByText('Safe text remains excellent.')).toBeTruthy()
  })
})
