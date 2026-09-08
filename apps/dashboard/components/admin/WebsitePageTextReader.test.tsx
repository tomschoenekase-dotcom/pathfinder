/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const listQuery = vi.fn()
const readQuery = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listWebsitePageText: { query: listQuery },
      readWebsitePageText: { query: readQuery },
    },
  }),
}))

import { WebsitePageTextReader } from './WebsitePageTextReader'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const receiptId = '968c2e1a-8ece-47ad-98dc-e4bde64872ca'
const metadata = {
  sourceUrl: 'https://example.com/venue',
  exactByteHash: 'a'.repeat(64),
  capturedAt: '2026-09-08T12:00:00.000Z',
  extractionProfile: 'static-html-v1' as const,
  normalizedTextHash: 'b'.repeat(64),
  retainedTextHash: 'c'.repeat(64),
  fullCodePointCount: 5_000,
  retainedCodePointCount: 4_000,
  truncated: true,
}
const secondMetadata = {
  ...metadata,
  sourceUrl: 'https://example.com/contact',
  exactByteHash: 'd'.repeat(64),
  retainedTextHash: 'e'.repeat(64),
  truncated: false,
  fullCodePointCount: 120,
  retainedCodePointCount: 120,
}

const props = { tenantId: 'tenant-a', venueId: 'venue-a', runId: 'run-a', receiptId }

describe('WebsitePageTextReader', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('loads only on explicit open and renders escaped bounded source text', async () => {
    listQuery.mockResolvedValue({
      status: 'RECORDED',
      receiptId,
      sourceId: 'source-a',
      pages: [metadata],
    })
    readQuery.mockResolvedValue({
      status: 'RECORDED',
      receiptId,
      ...metadata,
      page: {
        offset: 0,
        limit: 2_000,
        text: '<script>alert("never execute")</script>\nVenue & Hall',
        matchOffsets: [],
      },
      nextCursor: 'next-a',
    })
    render(<WebsitePageTextReader {...props} />)
    expect(listQuery).not.toHaveBeenCalled()
    expect(screen.getByText(/not an approved fact/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    expect(await screen.findByRole('button', { name: 'Read selected page' })).toBeTruthy()
    expect(screen.getByText(/truncated at collection/)).toBeTruthy()
    expect(screen.getByText('Static HTML body')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Read selected page' }))

    expect(await screen.findByText(/<script>alert\("never execute"\)<\/script>/)).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(readQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: metadata.sourceUrl,
        expectedExactByteHash: metadata.exactByteHash,
        expectedRetainedTextHash: metadata.retainedTextHash,
        pageSize: 2_000,
      }),
      { signal: expect.any(AbortSignal) },
    )
  })

  it('identifies retained PDF embedded text and its actual page count without OCR authority', async () => {
    const pdfMetadata = {
      ...metadata,
      sourceUrl: 'https://example.com/guide.pdf',
      extractionProfile: 'pdfjs-document-v1' as const,
      pdfPageCount: 17,
    }
    listQuery.mockResolvedValue({
      status: 'RECORDED',
      receiptId,
      sourceId: 'source-a',
      pages: [pdfMetadata],
    })
    render(<WebsitePageTextReader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    expect(await screen.findByText('PDF embedded text · 17 pages')).toBeTruthy()
    expect(screen.getByText(/not OCR or map interpretation/)).toBeTruthy()
    expect(screen.getByText(/not an approved fact/)).toBeTruthy()
  })

  it('restarts exact search and follows its bound continuation', async () => {
    listQuery.mockResolvedValue({
      status: 'RECORDED',
      receiptId,
      sourceId: 'source-a',
      pages: [metadata],
    })
    readQuery
      .mockResolvedValueOnce({
        status: 'RECORDED',
        receiptId,
        ...metadata,
        page: { offset: 10, limit: 2_000, text: 'Grand Hall grand hall', matchOffsets: [0] },
        nextCursor: 'search-next',
      })
      .mockResolvedValueOnce({
        status: 'RECORDED',
        receiptId,
        ...metadata,
        page: { offset: 30, limit: 2_000, text: 'Grand Hall', matchOffsets: [0] },
        nextCursor: null,
      })
    render(<WebsitePageTextReader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    await screen.findByRole('button', { name: 'Read selected page' })
    fireEvent.change(screen.getByLabelText('Find exact text (case-sensitive)'), {
      target: { value: 'Grand Hall' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Find and restart' }))
    expect(await screen.findByText(/1 exact match in this segment/)).toBeTruthy()
    expect(readQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'Grand Hall' }),
      expect.anything(),
    )
    expect(readQuery.mock.calls[0]?.[0]).not.toHaveProperty('cursor')
    fireEvent.change(screen.getByLabelText('Find exact text (case-sensitive)'), {
      target: { value: 'draft changed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next segment' }))
    await waitFor(() =>
      expect(readQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'Grand Hall', cursor: 'search-next' }),
        expect.anything(),
      ),
    )
    expect(await screen.findByText('Segment 2')).toBeTruthy()
  })

  it('aborts the active request and clears retained data when scope changes', async () => {
    let signal: AbortSignal | undefined
    let resolveListing: ((value: unknown) => void) | undefined
    listQuery.mockImplementationOnce((_input, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise((resolve) => {
        resolveListing = resolve
      })
    })
    const rendered = render(<WebsitePageTextReader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    await waitFor(() => expect(signal).toBeDefined())
    rendered.rerender(<WebsitePageTextReader {...props} runId="run-b" />)
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      resolveListing?.({ status: 'RECORDED', receiptId, sourceId: 'stale', pages: [metadata] })
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Open retained website text' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Read selected page' })).toBeNull()
  })

  it('does not collide when colon-containing scope parts form the same joined text', async () => {
    let signal: AbortSignal | undefined
    let resolveListing: ((value: unknown) => void) | undefined
    listQuery.mockImplementationOnce((_input, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise((resolve) => {
        resolveListing = resolve
      })
    })
    const rendered = render(<WebsitePageTextReader {...props} tenantId="a:b" venueId="c" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    await waitFor(() => expect(signal).toBeDefined())
    rendered.rerender(<WebsitePageTextReader {...props} tenantId="a" venueId="b:c" />)
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      resolveListing?.({ status: 'RECORDED', receiptId, sourceId: 'stale', pages: [metadata] })
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: 'Read selected page' })).toBeNull()
  })

  it('fences a late read when the selected source changes', async () => {
    let resolveRead: ((value: unknown) => void) | undefined
    listQuery.mockResolvedValue({
      status: 'RECORDED',
      receiptId,
      sourceId: 'source-a',
      pages: [metadata, secondMetadata],
    })
    readQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    render(<WebsitePageTextReader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    await screen.findByRole('button', { name: 'Read selected page' })
    fireEvent.click(screen.getByRole('button', { name: 'Read selected page' }))
    fireEvent.change(screen.getByLabelText('Retained page'), {
      target: { value: secondMetadata.sourceUrl },
    })
    await act(async () => {
      resolveRead?.({
        status: 'RECORDED',
        receiptId,
        ...metadata,
        page: { offset: 0, limit: 2_000, text: 'SOURCE A PRIVATE TEXT', matchOffsets: [] },
        nextCursor: null,
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('SOURCE A PRIVATE TEXT')).toBeNull()
    expect((screen.getByLabelText('Retained page') as HTMLSelectElement).value).toBe(
      secondMetadata.sourceUrl,
    )
  })

  it('offers an exact retry after a redacted listing failure', async () => {
    listQuery
      .mockRejectedValueOnce(new Error('postgres://private-provider'))
      .mockResolvedValueOnce({
        status: 'RECORDED',
        receiptId,
        sourceId: 'source-a',
        pages: [metadata],
      })
    render(<WebsitePageTextReader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/i)
    expect(document.body.textContent).not.toContain('postgres://private-provider')
    fireEvent.click(screen.getByRole('button', { name: 'Reload retained text' }))
    expect(await screen.findByRole('button', { name: 'Read selected page' })).toBeTruthy()
    expect(listQuery).toHaveBeenCalledTimes(2)
  })

  it('states the legacy empty condition without exposing page controls', async () => {
    listQuery.mockResolvedValue({
      status: 'NOT_RECORDED',
      receiptId,
      sourceId: 'source-a',
      pages: [],
    })
    render(<WebsitePageTextReader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open retained website text' }))
    expect(await screen.findByText(/legacy research receipt/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Read selected page' })).toBeNull()
  })
})
