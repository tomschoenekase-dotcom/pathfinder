/* @vitest-environment jsdom */
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('../../lib/intake-file-identity', async (load) => {
  const actual = await load<typeof import('../../lib/intake-file-identity')>()
  return {
    ...actual,
    // jsdom cannot stream-hash files; the transfer protocol is what these tests exercise.
    identifyIntakeFile: vi.fn(async (file: File) => {
      const hex = Array.from(`${file.name}:${file.size}`, (c) => c.charCodeAt(0).toString(16))
        .join('')
        .padEnd(64, '0')
        .slice(0, 64)
      return { sha256Hex: hex, sha256Base64: 'fixture' }
    }),
  }
})
import type { IntakeTransferApi } from '../../lib/intake-file-transfer'
import {
  attachmentsBlockSending,
  ComposerAttachments,
  readyAttachmentIds,
  type ComposerAttachment,
} from './ComposerAttachments'

function Harness({
  api,
  onItems,
}: {
  api: IntakeTransferApi
  onItems: (items: ComposerAttachment[]) => void
}) {
  const [items, setItems] = useState<ComposerAttachment[]>([])
  onItems(items)
  return (
    <ComposerAttachments
      venueId="venue-1"
      items={items}
      onChange={(update) => setItems(update)}
      disabled={false}
      api={api}
      eligible={[{ intakeUploadId: 'earlier-1', fileName: 'map.pdf', byteSize: 2048 }]}
    />
  )
}

function transfer(status: string, verified = 'AWAITING_REVIEW'): IntakeTransferApi {
  return {
    reserve: vi.fn(async () => ({ upload: { id: 'upload-1', status }, uploadRequest: null })),
    verify: vi.fn(async () => ({
      upload: { id: 'upload-1', status: verified },
      nextAction: 'WAIT',
    })),
    signMultipartPart: vi.fn(),
    completeMultipart: vi.fn(),
  }
}

const photo = () => new File([new Uint8Array([9, 8, 7])], 'sign.png', { type: 'image/png' })

describe('reply attachments', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('uploads a new photo from the composer and attaches it only once verified', async () => {
    let latest: ComposerAttachment[] = []
    render(<Harness api={transfer('AWAITING_REVIEW')} onItems={(items) => (latest = items)} />)
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [photo()] } })
    expect(attachmentsBlockSending(latest)).toBe(true)
    expect(await screen.findByText(/ready to send/u)).toBeTruthy()
    expect(readyAttachmentIds(latest)).toEqual(['upload-1'])
    expect(attachmentsBlockSending(latest)).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Remove sign.png' }))
    expect(readyAttachmentIds(latest)).toEqual([])
  })

  it('holds a photo still in its safety check back from the message', async () => {
    let latest: ComposerAttachment[] = []
    render(
      <Harness
        api={transfer('VERIFYING', 'PRECHECK_PASSED')}
        onItems={(items) => (latest = items)}
      />,
    )
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [photo()] } })
    expect(await screen.findByRole('button', { name: /Check again/u })).toBeTruthy()
    expect(readyAttachmentIds(latest)).toEqual([])
    expect(attachmentsBlockSending(latest)).toBe(true)
  })

  it('keeps a failed upload visible with a retry, and still offers files sent earlier', async () => {
    const api = transfer('AWAITING_REVIEW')
    vi.mocked(api.reserve).mockRejectedValueOnce(new Error('offline'))
    let latest: ComposerAttachment[] = []
    render(<Harness api={api} onItems={(items) => (latest = items)} />)
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [photo()] } })
    fireEvent.click(await screen.findByRole('button', { name: /Retry/u }))
    expect(await screen.findByText(/ready to send/u)).toBeTruthy()
    expect(vi.mocked(api.reserve).mock.calls[1]![0].requestId).toBe(
      vi.mocked(api.reserve).mock.calls[0]![0].requestId,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use a file you already sent' }))
    fireEvent.change(screen.getByLabelText('Choose a file you already sent'), {
      target: { value: 'earlier-1' },
    })
    expect(readyAttachmentIds(latest)).toEqual(['upload-1', 'earlier-1'])
  })
})
