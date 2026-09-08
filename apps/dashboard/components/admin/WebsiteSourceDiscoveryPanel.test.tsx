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
    expect(screen.getByText(/21 references · 0 collected text sources/)).toBeTruthy()
    expect(screen.getByText(/ownership and topic coverage have not been verified/)).toBeTruthy()
    expect(screen.getByText(/not the source publication or update date/)).toBeTruthy()
    expect(screen.getByText(/3 additional reference observations/)).toBeTruthy()
    expect(screen.getByText(/historical policy did not extract PDF text/)).toBeTruthy()
    expect(screen.getAllByText('Document format not supported')).toHaveLength(20)
    expect(screen.getAllByText(/not downloaded/)).toHaveLength(20)
  })
  it('distinguishes collected PDF text, bounded PDF failures, and an unfetched time limit', () => {
    const exactByteHash = 'a'.repeat(64)
    const failureCodes = [
      ['PDF_PASSWORD_REQUIRED', 'Password required'],
      ['PDF_NO_EXTRACTABLE_TEXT', 'No extractable text'],
      ['PDF_TOO_MANY_PAGES', 'Page-count limit exceeded'],
      ['PDF_EXTRACTION_TIMEOUT', 'Extraction timed out'],
      ['PDF_TOO_LARGE', 'PDF size limit exceeded'],
      ['PDF_PARSE_FAILED', 'PDF could not be parsed'],
      ['UNSAFE_TEXT_CONTROL', 'Unsafe text control detected'],
      ['TEXT_TOO_LARGE', 'Extracted text limit exceeded'],
      ['PDF_EXTRACTION_CANCELLED', 'Extraction cancelled'],
    ] as const
    render(
      <WebsiteSourceDiscoveryPanel
        review={{
          ...review,
          inventory: {
            policyVersion: 2,
            observedAt,
            omittedCount: 0,
            items: [
              {
                url: 'https://example.com/',
                parentUrl: null,
                depth: 0,
                observedAt,
                disposition: 'FETCHED_TEXT',
                contentType: 'text/html',
                byteSize: 10,
                exactByteHash,
              },
              {
                url: 'https://example.com/guide.pdf',
                parentUrl: 'https://example.com/',
                depth: 1,
                observedAt,
                disposition: 'PDF_TEXT_EXTRACTED',
                contentType: 'application/pdf',
                byteSize: 20,
                exactByteHash,
              },
              ...failureCodes.map(([extractionFailureCode], index) => ({
                url: `https://example.com/failure-${index}.pdf`,
                parentUrl: 'https://example.com/',
                depth: 1,
                observedAt,
                disposition: 'PDF_EXTRACTION_FAILED' as const,
                contentType: 'application/pdf',
                byteSize: 20,
                exactByteHash,
                extractionFailureCode,
              })),
              {
                url: 'https://example.com/deferred',
                parentUrl: 'https://example.com/',
                depth: 1,
                observedAt,
                disposition: 'TIME_LIMIT' as const,
              },
            ],
          },
        }}
      />,
    )
    expect(screen.getByText(/12 references · 2 collected text sources/)).toBeTruthy()
    expect(screen.getByText(/1 web page and 1 PDF/)).toBeTruthy()
    expect(screen.getByText(/not OCR/)).toBeTruthy()
    expect(screen.getByText('PDF text collected')).toBeTruthy()
    for (const [, label] of failureCodes) expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText('Crawl time limit reached')).toBeTruthy()
    expect(screen.getByText(/Depth 1 · not downloaded/)).toBeTruthy()
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
