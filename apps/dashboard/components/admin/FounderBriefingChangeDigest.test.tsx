/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'

import { FounderBriefingChangeDigest } from './FounderBriefingChangeDigest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('FounderBriefingChangeDigest', () => {
  afterEach(cleanup)

  it('renders priority changes as compact evidence links', () => {
    render(
      <FounderBriefingChangeDigest
        digest={{
          limit: 5,
          visibleCount: 2,
          mayHaveMore: true,
          items: [
            {
              kind: 'CRITICAL_RISK',
              urgency: 'CRITICAL',
              title: 'Visitor chat is unavailable',
              detail: 'Inspect affected guest turns.',
              occurredAt: new Date('2026-08-22T12:00:00.000Z'),
              action: { label: 'Review risk', href: '/admin/clients/t1/venues/v1/chatlogs' },
              source: { objectId: 'event_1' },
            },
            {
              kind: 'DECISION',
              urgency: 'HIGH',
              title: 'Which price is current?',
              detail: 'Two durable sources conflict.',
              occurredAt: new Date('2026-08-22T12:30:00.000Z'),
              action: { label: 'Answer question', href: '/admin/operations#needs-you-heading' },
              source: { objectId: 'question_1' },
            },
          ],
        }}
      />,
    )

    expect(screen.getByRole('heading', { name: 'What changed' })).toBeTruthy()
    expect(screen.getByText('2 visible in this bounded snapshot')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review risk' }).getAttribute('href')).toBe(
      '/admin/clients/t1/venues/v1/chatlogs',
    )
    expect(screen.getByRole('link', { name: 'Answer question' }).getAttribute('href')).toBe(
      '/admin/operations#needs-you-heading',
    )
    expect(screen.getByText(/Showing up to 5 priority changes/)).toBeTruthy()
  })

  it('states the bounded empty delta without claiming global awareness', () => {
    render(
      <FounderBriefingChangeDigest
        digest={{ limit: 5, visibleCount: 0, mayHaveMore: false, items: [] }}
      />,
    )

    expect(screen.getByText(/No new activity is visible/)).toBeTruthy()
    expect(screen.queryByText(/all company activity/i)).toBeNull()
  })

  it('has no detectable structural accessibility violations', async () => {
    const { container } = render(
      <main>
        <FounderBriefingChangeDigest
          digest={{
            limit: 5,
            visibleCount: 1,
            mayHaveMore: false,
            items: [
              {
                kind: 'CUSTOMER',
                urgency: 'NORMAL',
                title: 'Update weekend hours',
                detail: 'Content correction · in review',
                occurredAt: new Date('2026-08-22T12:00:00.000Z'),
                action: { label: 'Review customer item', href: '/admin/clients/t1' },
                source: { objectId: 'support_1' },
              },
            ],
          }}
        />
      </main>,
    )
    document.documentElement.lang = 'en'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations.map((violation) => violation.id)).toEqual([])
  })
})
