/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const query = vi.fn()
  const client = { intake: { getV1Processing: { query } } }
  return { query, client, currentClient: client }
})

vi.mock('../lib/trpc', () => ({ useTRPCClient: () => mocks.currentClient }))

import { IntakeV1ProcessingStatus } from './IntakeV1ProcessingStatus'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

function read(
  members: Array<{
    memberId: string
    processingKind: string | null
    status: string
    reasonCode?: string | null
    sourceReview?: {
      status: string
      reasonCode: string | null
    } | null
  }>,
) {
  return {
    submissionId: 'submission-1',
    revision: 2,
    members: members.map((member, ordinal) => ({
      ordinal,
      displayName: `Material ${ordinal + 1}`,
      sourceLabel: 'Shared information',
      reasonCode: null,
      ...member,
    })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

describe('IntakeV1ProcessingStatus', () => {
  beforeEach(() => {
    mocks.currentClient = mocks.client
    mocks.query.mockResolvedValue(read([]))
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders truthful bounded member states without implying a package or publication', async () => {
    mocks.query.mockResolvedValueOnce(
      read([
        { memberId: 'pending', processingKind: 'WEBSITE_RESEARCH', status: 'PENDING' },
        {
          memberId: 'recovery',
          processingKind: 'WEBSITE_RESEARCH',
          status: 'PENDING',
          reasonCode: 'PROCESSING_RECOVERY_PENDING',
        },
        { memberId: 'disabled', processingKind: 'WEBSITE_RESEARCH', status: 'POLICY_DISABLED' },
        {
          memberId: 'file-disabled',
          processingKind: 'FILE_EXTRACTION',
          status: 'POLICY_DISABLED',
          reasonCode: 'FILE_EXTRACTION_DISABLED',
        },
        {
          memberId: 'file',
          processingKind: 'EXTRACTION_UNSUPPORTED',
          status: 'HELD',
          reasonCode: 'EXTRACTION_NOT_EXECUTABLE',
        },
        { memberId: 'ready', processingKind: 'REVIEW_READY', status: 'COMPLETED' },
        { memberId: 'research', processingKind: 'WEBSITE_RESEARCH', status: 'COMPLETED' },
        { memberId: 'historical', processingKind: null, status: 'NOT_SCHEDULED' },
      ]),
    )
    render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )

    expect(await screen.findByText('Waiting to process')).toBeTruthy()
    expect(screen.getByText('Waiting to resume')).toBeTruthy()
    expect(screen.getByText('Waiting for research to be enabled')).toBeTruthy()
    expect(screen.getByText('Waiting for file processing to be enabled')).toBeTruthy()
    expect(screen.getByText('File needs review')).toBeTruthy()
    expect(screen.getByText('Ready for review')).toBeTruthy()
    expect(screen.getByText('Research saved')).toBeTruthy()
    expect(screen.getByText('Not scheduled for this earlier version')).toBeTruthy()
    expect(screen.getByText(/does not mean a visitor package was built/i)).toBeTruthy()
    expect(screen.queryByText(/ready guide/i)).toBeNull()
    expect(mocks.query).toHaveBeenCalledWith(
      { venueId: 'venue-1', submissionId: 'submission-1', revision: 2 },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('separates material processing from the source review stage', async () => {
    mocks.query.mockResolvedValueOnce(
      read([
        {
          memberId: 'waiting-review',
          processingKind: 'REVIEW_READY',
          status: 'COMPLETED',
          sourceReview: { status: 'WAITING', reasonCode: null },
        },
        {
          memberId: 'prepared-review',
          processingKind: 'REVIEW_READY',
          status: 'COMPLETED',
          sourceReview: { status: 'READY_FOR_REVIEW', reasonCode: null },
        },
        {
          memberId: 'no-review-stage',
          processingKind: 'WEBSITE_RESEARCH',
          status: 'COMPLETED',
          sourceReview: null,
        },
      ]),
    )
    render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )

    expect(await screen.findByText('Waiting for Torchiko review')).toBeTruthy()
    expect(screen.getByText('Prepared for Torchiko review')).toBeTruthy()
    expect(screen.getAllByText('Material processing')).toHaveLength(2)
    expect(screen.getAllByText('File preparation')).toHaveLength(2)
    expect(screen.getAllByText('Source review')).toHaveLength(2)
    expect(screen.queryByText(/published guide|guide is ready/i)).toBeNull()
  })

  it('keeps a long filename and waiting review status wrappable on phones', async () => {
    const longName = `${'Annual visitor accessibility and exhibit information '.repeat(6)}.pdf`
    mocks.query.mockResolvedValueOnce({
      ...read([
        {
          memberId: 'long-file',
          processingKind: 'REVIEW_READY',
          status: 'COMPLETED',
          sourceReview: { status: 'WAITING', reasonCode: null },
        },
      ]),
      members: [
        {
          ...read([
            {
              memberId: 'long-file',
              processingKind: 'REVIEW_READY',
              status: 'COMPLETED',
              sourceReview: { status: 'WAITING', reasonCode: null },
            },
          ]).members[0],
          displayName: longName,
        },
      ],
    })
    render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )

    expect((await screen.findByText(longName)).className).toContain('break-words')
    const waiting = screen.getByText('Waiting for Torchiko review')
    expect(waiting.className).toContain('break-words')
    expect(waiting.className).not.toContain('shrink-0')
  })

  it('refreshes only on demand and recovers from a failed read', async () => {
    mocks.query
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        read([{ memberId: 'ready', processingKind: 'REVIEW_READY', status: 'COMPLETED' }]),
      )
    render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be refreshed/i)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    const refresh = screen.getByRole('button', { name: 'Refresh status' })
    expect(refresh.className).toContain('min-h-11')
    fireEvent.click(refresh)
    expect(await screen.findByText('Ready for review')).toBeTruthy()
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it('drops a stale response after the venue and client change', async () => {
    const old = deferred<ReturnType<typeof read>>()
    mocks.query.mockReturnValueOnce(old.promise)
    const rendered = render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1))
    const oldSignal = mocks.query.mock.calls[0]?.[1]?.signal as AbortSignal
    const replacementQuery = vi.fn().mockResolvedValue({
      ...read([{ memberId: 'replacement', processingKind: 'REVIEW_READY', status: 'COMPLETED' }]),
      submissionId: 'submission-2',
      revision: 3,
    })
    mocks.currentClient = { intake: { getV1Processing: { query: replacementQuery } } }
    rendered.rerender(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-2"
        submissionId="submission-2"
        revision={3}
      />,
    )
    expect(oldSignal.aborted).toBe(true)
    expect(await screen.findByText('Ready for review')).toBeTruthy()
    old.resolve(
      read([{ memberId: 'stale', processingKind: 'WEBSITE_RESEARCH', status: 'PENDING' }]),
    )
    await waitFor(() => expect(screen.queryByText('Waiting to process')).toBeNull())
    expect(replacementQuery).toHaveBeenCalledWith(
      { venueId: 'venue-2', submissionId: 'submission-2', revision: 3 },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('aborts a stalled processing read at the bounded deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    mocks.query.mockImplementationOnce((_input, options) => {
      signal = options.signal
      return new Promise(() => undefined)
    })
    render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001)
    })
    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toMatch(/could not be refreshed/i)
    vi.useRealTimers()
  })

  it('drops a stale response when only the trusted owner changes on the same client', async () => {
    const old = deferred<ReturnType<typeof read>>()
    mocks.query
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        read([{ memberId: 'new-owner', processingKind: 'REVIEW_READY', status: 'COMPLETED' }]),
      )
    const rendered = render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )
    rendered.rerender(
      <IntakeV1ProcessingStatus
        ownerId="user-2"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )
    expect(await screen.findByText('Ready for review')).toBeTruthy()
    old.resolve(
      read([{ memberId: 'old-owner', processingKind: 'WEBSITE_RESEARCH', status: 'PENDING' }]),
    )
    await waitFor(() => expect(screen.queryByText('Waiting to process')).toBeNull())
  })

  it('rejects a response whose returned submission scope does not match the request', async () => {
    mocks.query.mockResolvedValueOnce({ ...read([]), submissionId: 'different-submission' })
    render(
      <IntakeV1ProcessingStatus
        ownerId="user-1"
        venueId="venue-1"
        submissionId="submission-1"
        revision={2}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be refreshed/i)
    expect(screen.queryByText('No material is recorded in this version.')).toBeNull()
  })
})
