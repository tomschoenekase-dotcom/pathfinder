/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const identity = vi.hoisted(() => ({
  identify: vi.fn(),
  fingerprint: vi.fn(),
}))
vi.mock('../lib/intake-file-identity', async (load) => {
  const actual = await load<typeof import('../lib/intake-file-identity')>()
  return {
    ...actual,
    identifyIntakeFile: identity.identify,
    intakeFileFingerprint: identity.fingerprint,
  }
})

import { IntakeFileUpload } from './IntakeFileUpload'

const headers = {
  'content-type': 'application/pdf',
  'if-none-match': '*',
  'x-amz-checksum-sha256': 'base64-checksum',
  'x-amz-meta-pf-intake-upload-generation': 'generation-a',
}

describe('quarantined intake file upload', () => {
  const reserve = vi.fn()
  const verify = vi.fn()
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    identity.identify.mockResolvedValue({
      sha256Hex: 'a'.repeat(64),
      sha256Base64: 'base64-checksum',
    })
    identity.fingerprint.mockImplementation((file: File) => `${file.name}:${file.size}:hash`)
    reserve.mockResolvedValue({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'RESERVED',
        rejectionCode: null,
      },
      replayed: false,
      nextAction: 'UPLOAD_BYTES',
      uploadRequest: { url: 'https://upload.invalid/signed', requiredHeaders: headers },
    })
    verify.mockResolvedValue({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'AWAITING_REVIEW',
      },
      retryable: false,
      nextAction: 'PATHFINDER_REVIEW',
    })
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function renderUpload() {
    render(<IntakeFileUpload venueId="venue-a" uploads={[]} reserve={reserve} verify={verify} />)
    const file = new File(['evidence'], 'map.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } })
    return file
  }

  it('uses the exact signed PUT headers and reports transport verification without safety claims', async () => {
    const file = renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('Received')

    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-a',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        sha256: 'a'.repeat(64),
      }),
    )
    expect(fetchMock).toHaveBeenCalledWith('https://upload.invalid/signed', {
      method: 'PUT',
      headers,
      body: file,
    })
    expect(verify).toHaveBeenCalledWith({
      venueId: 'venue-a',
      uploadId: 'upload-a',
      claimId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(screen.getByText(/team still reviews it before use/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /quarantin|checksum|object version|approved|applied/iu,
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('retains request and claim identity for an unchanged ambiguous retry and fences a double click', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error('storage-signature-secret=raw-provider-detail connection lost'),
    )
    renderUpload()
    const uploadButton = screen.getByRole('button', { name: 'Upload' })
    fireEvent.click(uploadButton)
    fireEvent.click(uploadButton)
    await screen.findByText('PathFinder could not confirm this file. Please try again.')
    expect(document.body.textContent).not.toMatch(/storage-signature-secret|raw-provider-detail/iu)
    expect(reserve).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(reserve).toHaveBeenCalledTimes(2))
    expect(reserve.mock.calls[1]?.[0]?.requestId).toBe(reserve.mock.calls[0]?.[0]?.requestId)
    expect(verify).toHaveBeenCalledOnce()
  })

  it('never renders raw reservation or provider error details', async () => {
    reserve.mockRejectedValueOnce(
      new Error('signed-object-key=private/raw-map.pdf provider request failed'),
    )
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    expect(
      await screen.findByText('PathFinder could not confirm this file. Please try again.'),
    ).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /signed-object-key|private\/raw-map|provider request/iu,
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('reconciles an ambiguous uploaded attempt when reserve replays without another PUT', async () => {
    reserve.mockResolvedValueOnce({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'VERIFYING',
        rejectionCode: null,
      },
      replayed: true,
      nextAction: 'REVIEW_STATUS',
      uploadRequest: null,
    })
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('Received')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(verify).toHaveBeenCalledWith({
      venueId: 'venue-a',
      uploadId: 'upload-a',
      claimId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })

  it('retains the same request and verification claim after ambiguous finalization', async () => {
    verify.mockRejectedValueOnce(
      new Error('internal-verification-claim=secret verification response lost'),
    )
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('PathFinder could not confirm this file. Please try again.')
    expect(document.body.textContent).not.toMatch(/internal-verification-claim|secret/iu)
    const firstRequestId = reserve.mock.calls[0]?.[0]?.requestId
    const firstClaimId = verify.mock.calls[0]?.[0]?.claimId
    reserve.mockResolvedValueOnce({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'VERIFYING',
        rejectionCode: null,
      },
      replayed: true,
      nextAction: 'REVIEW_STATUS',
      uploadRequest: null,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Received')
    expect(reserve.mock.calls[1]?.[0]?.requestId).toBe(firstRequestId)
    expect(verify.mock.calls[1]?.[0]?.claimId).toBe(firstClaimId)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reconciles immutable PUT precondition failures through verification', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 412 })
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('Received')
    expect(verify).toHaveBeenCalledOnce()
  })

  it('supports multiple selection, accessible removal, and rejects more than twenty files', () => {
    render(<IntakeFileUpload venueId="venue-a" uploads={[]} reserve={reserve} verify={verify} />)
    const input = screen.getByLabelText('Choose files')
    const files = [
      new File(['a'], 'one.pdf', { type: 'application/pdf' }),
      new File(['b'], 'two.png', { type: 'image/png' }),
    ]
    fireEvent.change(input, { target: { files } })
    expect(screen.getByRole('button', { name: 'Remove one.pdf' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove one.pdf' }))
    expect(screen.queryByText('one.pdf')).toBeNull()

    const tooMany = Array.from(
      { length: 21 },
      (_, index) => new File(['x'], `${index}.pdf`, { type: 'application/pdf' }),
    )
    fireEvent.change(input, { target: { files: tooMany } })
    expect(screen.getByRole('alert').textContent).toMatch(/at most 20/)
  })
})
