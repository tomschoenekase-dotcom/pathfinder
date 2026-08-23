/* @vitest-environment jsdom */
import React from 'react'
import axe from 'axe-core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProspectCorrespondenceHistory } from './ProspectCorrespondenceHistory'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

const threads = [
  {
    id: 'thread-1',
    subject: 'Updated visitor hours',
    messages: [
      {
        id: 'message-1',
        direction: 'INBOUND',
        status: 'RECEIVED',
        fromAddress: 'curator@example.org',
        toAddresses: ['team@torchiko.com'],
        bodyPreview: 'We updated our visitor hours for September.',
        sourceReference: 'https://mail.google.com/mail/u/team%40torchiko.com/#all/message%2Fone',
        attachmentMetadata: [
          {
            providerAttachmentId: 'attachment-1',
            filename: 'visitor-map.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 2048,
            downloadPolicy: 'METADATA_ONLY' as const,
          },
        ],
        attachmentRetentionRequests: [],
        occurredAt: '2026-08-22T12:00:00Z',
      },
    ],
  },
]

describe('ProspectCorrespondenceHistory', () => {
  it('renders compact evidence and an exact Gmail source link', () => {
    render(<ProspectCorrespondenceHistory threads={threads} />)
    expect(screen.getByText('We updated our visitor hours for September.')).toBeTruthy()
    expect(
      screen.getByRole('link', { name: /Open source email in Gmail/u }).getAttribute('href'),
    ).toBe('https://mail.google.com/mail/u/team%40torchiko.com/#all/message%2Fone')
    expect(screen.getByText(/Gmail remains the canonical source/u)).toBeTruthy()
    expect(screen.getByText('visitor-map.pdf')).toBeTruthy()
    expect(screen.getByText(/metadata only/iu)).toBeTruthy()
    expect(screen.getByText(/not downloaded/iu)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /retention review/iu })).toBeNull()
  })

  it('fails closed when the source URL is unsafe', () => {
    render(
      <ProspectCorrespondenceHistory
        threads={[
          {
            ...threads[0]!,
            messages: [{ ...threads[0]!.messages[0]!, sourceReference: 'javascript:alert(1)' }],
          },
        ]}
      />,
    )
    expect(screen.queryByRole('link', { name: /Open source email/u })).toBeNull()
    expect(screen.getByText('Original source link unavailable.')).toBeTruthy()
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<ProspectCorrespondenceHistory threads={threads} />)
    expect((await axe.run(container)).violations).toEqual([])
  })
})
