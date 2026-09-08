/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { WebsiteSourceDiscoveryPanel } from './WebsiteSourceDiscoveryPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const observedAt = '2026-09-08T08:00:00.000Z'
const review = {
  receiptId: 'receipt-a',
  status: 'RECORDED' as const,
  sourceHost: 'example.com',
  inventory: {
    policyVersion: 1 as const,
    observedAt,
    omittedCount: 3,
    items: Array.from({ length: 21 }, (_, i) => ({
      url: `https://example.com/guide-${i}.pdf`,
      parentUrl: null,
      depth: 0,
      observedAt,
      disposition: 'UNSUPPORTED_DOCUMENT' as const,
    })),
  },
}

describe('WebsiteSourceDiscoveryPanel', () => {
  afterEach(cleanup)
  it('shows unsupported gaps and unknown authority/freshness without claiming extraction', () => {
    render(<WebsiteSourceDiscoveryPanel review={review} />)
    expect(screen.getByText(/21 references · 0 text pages/)).toBeTruthy()
    expect(screen.getByText(/ownership and topic coverage have not been verified/)).toBeTruthy()
    expect(screen.getByText(/not the source publication or update date/)).toBeTruthy()
    expect(screen.getByText(/3 additional reference observations/)).toBeTruthy()
    expect(screen.getAllByText('Document · adapter unavailable')).toHaveLength(20)
    expect(screen.getAllByText(/not downloaded/)).toHaveLength(20)
  })
  it('paginates the complete bounded inventory and resets for another receipt', () => {
    const rendered = render(<WebsiteSourceDiscoveryPanel review={review} />)
    fireEvent.click(screen.getByText(/Source inventory/))
    fireEvent.click(screen.getByRole('button', { name: 'Next sources' }))
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com/guide-20.pdf')
    expect(screen.getByText('Page 2 of 2')).toBeTruthy()
    rendered.rerender(
      <WebsiteSourceDiscoveryPanel review={{ ...review, receiptId: 'receipt-b' }} />,
    )
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
  })
  it.each(['NOT_RECORDED', 'INVALID'] as const)(
    'does not render links for %s inventory',
    (status) => {
      render(
        <WebsiteSourceDiscoveryPanel
          review={{ receiptId: 'a', status, sourceHost: null, inventory: null }}
        />,
      )
      expect(screen.getByRole('status')).toBeTruthy()
      expect(screen.queryByRole('link')).toBeNull()
    },
  )
})
