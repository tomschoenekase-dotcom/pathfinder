/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProspectReplyContentControl } from './ProspectReplyContentControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const mocks = vi.hoisted(() => ({ read: vi.fn(), retain: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      readProspectReplyContent: { mutate: mocks.read },
      retainProspectReplyContent: { mutate: mocks.retain },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
const selection = { messageId: 'm1', threadId: 't1', organizationId: 'o1' }
const preview = {
  expected: {
    canonicalMessageId: 'm1',
    canonicalThreadId: 't1',
    organizationId: 'o1',
    providerAccountId: 'a1',
    providerMessageId: 'pm1',
    providerThreadId: 'pt1',
    sourceReference: 'https://mail.google.com/mail/u/0/#inbox/pm1',
    rawBodySha256: 'a'.repeat(64),
  },
  replyText: 'Please show the visitor guide. 🌿',
  omittedQuotedText: false,
  projectionScope: 'FULL_BODY',
}
describe('explicit selected reply content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockResolvedValue(preview)
    mocks.retain.mockResolvedValue({ expiresAt: '2026-09-23T00:00:00Z' })
  })
  afterEach(cleanup)
  it('never fetches or retains automatically and binds both actions to the selected source', async () => {
    render(<ProspectReplyContentControl {...selection} />)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.retain).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Read this reply from Gmail' }))
    expect(await screen.findByText(preview.replyText)).toBeTruthy()
    expect(mocks.read).toHaveBeenCalledWith(selection)
    expect(mocks.retain).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Keep this one body for reply preparation'), {
      target: { value: '7' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retain only this message' }))
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
    expect(mocks.retain).toHaveBeenCalledWith({ expected: preview.expected, retentionDays: 7 })
    expect(screen.queryByText(preview.replyText)).toBeNull()
  })
  it('preserves the exact retention binding across a lost response', async () => {
    mocks.retain.mockRejectedValueOnce(new Error('Response lost'))
    render(<ProspectReplyContentControl {...selection} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read this reply from Gmail' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retain only this message' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('retry the same retention request'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retain only this message' }))
    await waitFor(() => expect(mocks.retain).toHaveBeenCalledTimes(2))
    expect(mocks.retain.mock.calls[1]).toEqual(mocks.retain.mock.calls[0])
  })
  it('drops a delayed previous-record body after navigation', async () => {
    let resolve!: (value: typeof preview) => void
    mocks.read.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const page = render(<ProspectReplyContentControl {...selection} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read this reply from Gmail' }))
    page.rerender(<ProspectReplyContentControl messageId="m2" threadId="t2" organizationId="o2" />)
    resolve(preview)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.queryByText(preview.replyText)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retain only this message' })).toBeNull()
  })
})
