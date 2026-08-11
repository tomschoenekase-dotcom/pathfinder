import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
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
})
