/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
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
      uploadRequest: {
        kind: 'single',
        url: 'https://upload.invalid/signed',
        requiredHeaders: headers,
      },
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
    globalThis.localStorage.clear()
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
    await screen.findByText('Checks complete — awaiting review')

    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-a',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        sha256: 'a'.repeat(64),
        category: 'DOCUMENT',
      }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://upload.invalid/signed',
      expect.objectContaining({ method: 'PUT', headers, body: file, signal: expect.anything() }),
    )
    expect(verify).toHaveBeenCalledWith({
      venueId: 'venue-a',
      uploadId: 'upload-a',
      claimId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(screen.getByText(/nothing is published from this page/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /quarantin|checksum|object version|approved|applied/iu,
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('resumes a multipart file from storage-confirmed parts and verifies only after completion', async () => {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: vi.fn(async () => new ArrayBuffer(4)),
    })
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      value: { digest: vi.fn(async () => new ArrayBuffer(32)) },
    })
    const signMultipartPart = vi.fn().mockResolvedValue({
      url: 'https://upload.invalid/part-2',
      requiredHeaders: { 'x-amz-checksum-sha256': 'part-checksum' },
    })
    const completeMultipart = vi.fn().mockResolvedValue({ nextAction: 'VERIFY' })
    reserve.mockResolvedValueOnce({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'RESERVED',
      },
      replayed: true,
      nextAction: 'UPLOAD_BYTES',
      uploadRequest: {
        kind: 'multipart',
        partSize: 4,
        partCount: 2,
        completedParts: [{ partNumber: 1, etag: 'etag-1', checksumSha256: 'checksum-1', size: 4 }],
      },
    })
    render(
      <IntakeFileUpload
        venueId="venue-a"
        uploads={[]}
        reserve={reserve}
        verify={verify}
        signMultipartPart={signMultipartPart}
        completeMultipart={completeMultipart}
      />,
    )
    const file = new File(['evidence'], 'map.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('Checks complete — awaiting review')
    expect(signMultipartPart).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'upload-a', partNumber: 2 }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(completeMultipart).toHaveBeenCalledWith({ venueId: 'venue-a', uploadId: 'upload-a' })
    expect(verify.mock.invocationCallOrder[0]).toBeGreaterThan(
      completeMultipart.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('aborts and durably cancels an active multipart upload', async () => {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: vi.fn(async () => new ArrayBuffer(4)),
    })
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      value: { digest: vi.fn(async () => new ArrayBuffer(32)) },
    })
    reserve.mockResolvedValueOnce({
      upload: {
        id: 'upload-cancel',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'RESERVED',
      },
      replayed: false,
      nextAction: 'UPLOAD_BYTES',
      uploadRequest: {
        kind: 'multipart',
        partSize: 4,
        partCount: 2,
        completedParts: [],
      },
    })
    const signMultipartPart = vi.fn().mockResolvedValue({
      url: 'https://upload.invalid/part-1',
      requiredHeaders: { 'x-amz-checksum-sha256': 'part-checksum' },
    })
    const completeMultipart = vi.fn()
    const cancelMultipart = vi.fn().mockResolvedValue({ replayed: false })
    fetchMock.mockImplementationOnce(
      (_url, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    render(
      <IntakeFileUpload
        venueId="venue-a"
        uploads={[]}
        reserve={reserve}
        verify={verify}
        signMultipartPart={signMultipartPart}
        completeMultipart={completeMultipart}
        cancelMultipart={cancelMultipart}
      />,
    )
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files: [new File(['evidence'], 'map.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel upload' }))
    expect(await screen.findByText('Upload cancelled.')).toBeTruthy()
    expect(cancelMultipart).toHaveBeenCalledWith({
      venueId: 'venue-a',
      uploadId: 'upload-cancel',
    })
    expect(completeMultipart).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('retains request and claim identity for an unchanged ambiguous retry and fences a double click', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error('storage-signature-secret=raw-provider-detail connection lost'),
    )
    renderUpload()
    const uploadButton = screen.getByRole('button', { name: 'Upload' })
    fireEvent.click(uploadButton)
    fireEvent.click(uploadButton)
    await screen.findByText('Torchiko could not confirm this file. Please try again.')
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
      await screen.findByText('Torchiko could not confirm this file. Please try again.'),
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
    await screen.findByText('Checks complete — awaiting review')
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
    await screen.findByText('Torchiko could not confirm this file. Please try again.')
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
    await screen.findByText('Checks complete — awaiting review')
    expect(reserve.mock.calls[1]?.[0]?.requestId).toBe(firstRequestId)
    expect(verify.mock.calls[1]?.[0]?.claimId).toBe(firstClaimId)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reconciles immutable PUT precondition failures through verification', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 412 })
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('Checks complete — awaiting review')
    expect(verify).toHaveBeenCalledOnce()
  })

  it('shows the security check boundary without claiming that a prechecked file is safe', async () => {
    verify.mockResolvedValue({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'PRECHECK_PASSED',
      },
      retryable: true,
      nextAction: 'MALWARE_SCAN_PENDING',
      processingState: 'MALWARE_SCAN_PENDING',
    })
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await screen.findByText('Security check pending')
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/malware[- ]free|virus[- ]free|safe to open/iu)

    const firstRequestId = reserve.mock.calls[0]?.[0]?.requestId
    const firstClaimId = verify.mock.calls[0]?.[0]?.claimId
    reserve.mockResolvedValueOnce({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'PRECHECK_PASSED',
        rejectionCode: null,
      },
      replayed: true,
      nextAction: 'REVIEW_STATUS',
      uploadRequest: null,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(2))
    expect(reserve.mock.calls[1]?.[0]?.requestId).toBe(firstRequestId)
    expect(verify.mock.calls[1]?.[0]?.claimId).toBe(firstClaimId)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('makes a definitive rejection terminal and requires a newly selected file identity', async () => {
    verify.mockResolvedValueOnce({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'REJECTED',
        rejectionCode: 'UNSAFE_FILE',
      },
      retryable: false,
      nextAction: 'RESELECT_FILE',
    })
    renderUpload()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByText(/remove it and select the file again/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove map.pdf' }))

    const replacement = new File(['replacement'], 'map.pdf', { type: 'application/pdf' })
    identity.fingerprint.mockReturnValueOnce('map.pdf:11:new-hash')
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [replacement] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => expect(reserve).toHaveBeenCalledTimes(2))
    expect(reserve.mock.calls[1]?.[0]?.requestId).not.toBe(reserve.mock.calls[0]?.[0]?.requestId)
  })

  it('purges the visible queue and ignores a late result when venue scope changes', async () => {
    let resolveReserve: ((value: Awaited<ReturnType<typeof reserve>>) => void) | undefined
    reserve.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReserve = resolve
      }),
    )
    const committed = vi.fn()
    const { rerender } = render(
      <IntakeFileUpload
        venueId="venue-a"
        uploads={[]}
        reserve={reserve}
        verify={verify}
        onCommitted={committed}
      />,
    )
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files: [new File(['evidence'], 'map.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    rerender(
      <IntakeFileUpload
        venueId="venue-b"
        uploads={[]}
        reserve={reserve}
        verify={verify}
        onCommitted={committed}
      />,
    )
    expect(screen.queryByText('map.pdf')).toBeNull()
    resolveReserve?.({
      upload: {
        id: 'upload-a',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'AWAITING_REVIEW',
        rejectionCode: null,
      },
      replayed: true,
      nextAction: 'REVIEW_STATUS',
      uploadRequest: null,
    })
    await waitFor(() => expect(verify).not.toHaveBeenCalled())
    expect(committed).not.toHaveBeenCalled()
    expect(screen.queryByText(/checks complete/i)).toBeNull()
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

  it('treats drag-and-drop like browse selection, including automatic material typing', () => {
    const dropped = new File(['map'], 'floor-plan.pdf', {
      type: 'application/pdf',
      lastModified: 1_800_000_000_000,
    })
    const firstRender = render(
      <IntakeFileUpload venueId="venue-a" uploads={[]} reserve={reserve} verify={verify} />,
    )
    const dropField = screen.getByLabelText('Choose files').closest('label')
    expect(dropField).not.toBeNull()

    fireEvent.dragEnter(dropField!, { dataTransfer: { files: [dropped] } })
    expect(screen.getByText('Release to add these files')).toBeTruthy()
    fireEvent.drop(dropField!, { dataTransfer: { files: [dropped] } })

    expect(screen.getByText('floor-plan.pdf')).toBeTruthy()
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('DOCUMENT')
    expect(dropField?.getAttribute('data-activity')).toBe('queued')

    firstRender.unmount()
    render(<IntakeFileUpload venueId="venue-a" uploads={[]} reserve={reserve} verify={verify} />)
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [dropped] } })

    expect(screen.getByText('floor-plan.pdf')).toBeTruthy()
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('DOCUMENT')
  })

  it('identifies a duplicate selection in plain language without silently sending it', () => {
    render(<IntakeFileUpload venueId="venue-a" uploads={[]} reserve={reserve} verify={verify} />)
    const duplicate = new File(['same'], 'visitor-guide.pdf', {
      type: 'application/pdf',
      lastModified: 1_800_000_000_000,
    })
    const input = screen.getByLabelText('Choose files')

    fireEvent.change(input, { target: { files: [duplicate] } })
    fireEvent.change(input, { target: { files: [duplicate] } })

    expect(screen.getByRole('alert').textContent).toBe('This file is already in your upload list.')
    expect(reserve).not.toHaveBeenCalled()
  })

  it('announces multipart progress with a named, determinate progressbar', async () => {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: vi.fn(async () => new ArrayBuffer(4)),
    })
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      value: { digest: vi.fn(async () => new ArrayBuffer(32)) },
    })
    reserve.mockReset().mockResolvedValue({
      upload: {
        id: 'upload-progress',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'RESERVED',
      },
      replayed: true,
      nextAction: 'UPLOAD_BYTES',
      uploadRequest: {
        kind: 'multipart',
        partSize: 4,
        partCount: 2,
        completedParts: [{ partNumber: 1, etag: 'etag-1', checksumSha256: 'checksum-1', size: 4 }],
      },
    })
    const signMultipartPart = vi.fn().mockResolvedValue({
      url: 'https://upload.invalid/part-2',
      requiredHeaders: { 'x-amz-checksum-sha256': 'part-checksum' },
    })
    const completeMultipart = vi.fn().mockResolvedValue({ nextAction: 'VERIFY' })
    let finishUpload!: (value: { ok: boolean; status: number }) => void
    fetchMock.mockReset().mockImplementation(
      () =>
        new Promise<{ ok: boolean; status: number }>((resolve) => {
          finishUpload = resolve
        }),
    )
    render(
      <IntakeFileUpload
        venueId="venue-a"
        uploads={[]}
        reserve={reserve}
        verify={verify}
        signMultipartPart={signMultipartPart}
        completeMultipart={completeMultipart}
      />,
    )
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files: [new File(['evidence'], 'map.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    const progress = await screen.findByRole('progressbar', { name: 'Uploading map.pdf' })
    expect(screen.getByLabelText('Choose files').closest('label')?.dataset.activity).toBe('sending')
    expect(screen.getByRole('heading', { name: 'Sending to Torchiko' })).toBeTruthy()
    expect(progress.getAttribute('aria-valuemin')).toBe('0')
    expect(progress.getAttribute('aria-valuemax')).toBe('100')
    expect(progress.getAttribute('aria-valuenow')).toBe('50')
    const liveStatus = screen.getByRole('status')
    expect(liveStatus.getAttribute('aria-live')).toBe('polite')
    expect(liveStatus.textContent).toContain('Sending file · 50%')
    finishUpload({ ok: true, status: 200 })
    await screen.findByText('Checks complete — awaiting review')
    expect(screen.getByLabelText('Choose files').closest('label')?.dataset.activity).toBe('joined')
    expect(screen.getByRole('heading', { name: 'Handoff complete' })).toBeTruthy()
  })

  it('counts and filters submitted files by material type', () => {
    render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        uploads={[
          {
            id: 'photo-1',
            displayName: 'entrance.png',
            fileName: 'entrance.png',
            mimeType: 'image/png',
            category: 'PHOTO',
            byteSize: 8,
            status: 'PRECHECK_PASSED',
          },
          {
            id: 'video-1',
            displayName: 'tour.mp4',
            fileName: 'tour.mp4',
            mimeType: 'video/mp4',
            category: 'VIDEO_AUDIO',
            byteSize: 8,
            status: 'PRECHECK_PASSED',
          },
        ]}
      />,
    )

    expect(screen.queryByText('tour.mp4')).toBeNull()
    expect(screen.queryByText('entrance.png')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All shared files' }))
    expect(screen.getByText('tour.mp4')).toBeTruthy()
    expect(screen.getByText('entrance.png')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'All shared files' }))
    expect(screen.queryByText('tour.mp4')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Videos or audio 1/ }))
    expect(screen.getByText('tour.mp4')).toBeTruthy()
    expect(screen.queryByText('entrance.png')).toBeNull()
  })

  it('surfaces a persisted rejection with one safe replacement action and accessible recovery UI', async () => {
    const { container } = render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        uploads={[
          {
            id: 'accepted-1',
            displayName: 'visitor-guide.pdf',
            fileName: 'visitor-guide.pdf',
            mimeType: 'application/pdf',
            category: 'DOCUMENT',
            byteSize: 8,
            status: 'AWAITING_REVIEW',
          },
          {
            id: 'rejected-1',
            displayName: 'floor-plan.pdf',
            fileName: 'floor-plan.pdf',
            mimeType: 'application/pdf',
            category: 'FLOOR_PLAN',
            byteSize: 8,
            status: 'REJECTED',
            rejectionCode: 'UNSAFE_FILE',
          },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Choose a replacement file' })).toBeTruthy()
    expect(screen.getByText('This file did not pass the required safety checks.')).toBeTruthy()
    expect(screen.getByText(/your other submitted information is unchanged/iu)).toBeTruthy()
    const input = screen.getByLabelText('Choose files')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Choose a replacement' }))
    expect(click).toHaveBeenCalledOnce()

    document.documentElement.lang = 'en'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations).toEqual([])
  })

  it('keeps an intentional cancellation out of the required recovery queue', () => {
    render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        uploads={[
          {
            id: 'cancelled-1',
            displayName: 'cancelled-map.pdf',
            fileName: 'cancelled-map.pdf',
            mimeType: 'application/pdf',
            category: 'FLOOR_PLAN',
            byteSize: 8,
            status: 'REJECTED',
            rejectionCode: 'CLIENT_CANCELLED',
          },
        ]}
      />,
    )

    expect(screen.queryByRole('heading', { name: /Choose a replacement/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All shared files' }))
    expect(screen.getAllByText(/Upload cancelled/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Choose a replacement' })).toBeNull()
  })

  it('loads older rejected records into the exact recovery queue', async () => {
    const loadMore = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'rejected-older',
          displayName: 'older-map.pdf',
          fileName: 'older-map.pdf',
          mimeType: 'application/pdf',
          category: 'FLOOR_PLAN',
          byteSize: 8,
          status: 'REJECTED',
          rejectionCode: 'OBJECT_MISSING',
        },
      ],
      nextCursor: null,
    })
    render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        attentionCount={1}
        uploads={[]}
        nextCursor={{ createdAt: '2026-08-18T12:00:00.000Z', id: 'cursor-a' }}
        loadMore={loadMore}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Load older files needing attention' }))
    expect(await screen.findByText('older-map.pdf')).toBeTruthy()
    expect(screen.getByText('Torchiko could not finish receiving this file.')).toBeTruthy()
  })

  it('loads older submitted files into the selected material type', async () => {
    const loadMore = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'video-older',
          displayName: 'walkthrough.mp4',
          fileName: 'walkthrough.mp4',
          mimeType: 'video/mp4',
          category: 'VIDEO_AUDIO',
          byteSize: 8,
          status: 'PRECHECK_PASSED',
        },
      ],
      nextCursor: null,
    })
    render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        uploads={[]}
        categoryCounts={{ VIDEO_AUDIO: 1 }}
        nextCursor={{ createdAt: '2026-08-18T12:00:00.000Z', id: 'cursor-a' }}
        loadMore={loadMore}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Videos or audio 1/ }))
    expect(screen.queryByText('walkthrough.mp4')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }))

    expect(await screen.findByText('walkthrough.mp4')).toBeTruthy()
    expect(loadMore).toHaveBeenCalledWith({
      createdAt: '2026-08-18T12:00:00.000Z',
      id: 'cursor-a',
    })
  })

  it('can resume an authoritative security check for a saved prechecked upload', async () => {
    const onCommitted = vi.fn()
    verify.mockResolvedValueOnce({
      upload: {
        id: 'upload-pending',
        displayName: 'map.pdf',
        fileName: 'map.pdf',
        mimeType: 'application/pdf',
        byteSize: 8,
        status: 'AWAITING_REVIEW',
      },
      retryable: false,
      nextAction: 'PATHFINDER_REVIEW',
    })
    render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        onCommitted={onCommitted}
        uploads={[
          {
            id: 'upload-pending',
            displayName: 'map.pdf',
            fileName: 'map.pdf',
            mimeType: 'application/pdf',
            byteSize: 8,
            status: 'PRECHECK_PASSED',
            clientVerification: {
              kind: 'RESUME_CHECK',
              required: true,
              actionLabel: 'Resume security check',
              reason: 'The saved file passed its format check and still needs its security check.',
              retrySameSubmission: true,
            },
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Resume security check' }))
    await waitFor(() =>
      expect(verify).toHaveBeenCalledWith({
        venueId: 'venue-a',
        uploadId: 'upload-pending',
        claimId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'All shared files' }))
    expect(await screen.findByText('Checks complete — awaiting review')).toBeTruthy()
    expect(onCommitted).toHaveBeenCalledOnce()
  })

  it('can retry a saved file left in format verification without selecting it again', async () => {
    verify.mockResolvedValueOnce({
      upload: {
        id: 'upload-verifying',
        displayName: 'visitor-guide.pdf',
        fileName: 'visitor-guide.pdf',
        mimeType: 'application/pdf',
        byteSize: 5_000,
        status: 'PRECHECK_PASSED',
        clientVerification: {
          kind: 'WAIT_FOR_TORCHIKO',
          required: false,
          actionLabel: null,
          reason: 'The saved file is waiting for Torchiko to finish its security check.',
          retrySameSubmission: false,
        },
      },
      retryable: true,
      nextAction: 'MALWARE_SCAN_PENDING',
    })
    render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        uploads={[
          {
            id: 'upload-verifying',
            displayName: 'visitor-guide.pdf',
            fileName: 'visitor-guide.pdf',
            mimeType: 'application/pdf',
            byteSize: 5_000,
            status: 'VERIFYING',
            clientVerification: {
              kind: 'RESUME_CHECK',
              required: true,
              actionLabel: 'Resume file check',
              reason: 'The saved file check stopped before it finished.',
              retrySameSubmission: true,
            },
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Resume file check' }))
    await waitFor(() =>
      expect(verify).toHaveBeenCalledWith({
        venueId: 'venue-a',
        uploadId: 'upload-verifying',
        claimId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    )
    expect(await screen.findByText('No action needed')).toBeTruthy()
  })

  it('does not offer a retry while another verification lease is active', () => {
    render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        uploads={[
          {
            id: 'upload-active',
            displayName: 'active-check.pdf',
            fileName: 'active-check.pdf',
            mimeType: 'application/pdf',
            byteSize: 8,
            status: 'VERIFYING',
            clientVerification: {
              kind: 'IN_PROGRESS',
              required: false,
              actionLabel: null,
              reason: 'Torchiko is actively checking this saved file.',
              retrySameSubmission: false,
            },
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'All shared files' }))
    expect(screen.getAllByText(/File check in progress/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /file check/iu })).toBeNull()
  })

  it('has no automated accessibility violations in the pending-check state', async () => {
    const { container } = render(
      <IntakeFileUpload
        venueId="venue-a"
        reserve={reserve}
        verify={verify}
        uploads={[
          {
            id: 'upload-pending',
            displayName: 'map.pdf',
            fileName: 'map.pdf',
            mimeType: 'application/pdf',
            byteSize: 8,
            status: 'PRECHECK_PASSED',
          },
        ]}
      />,
    )
    document.documentElement.lang = 'en'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations).toEqual([])
  })
})
