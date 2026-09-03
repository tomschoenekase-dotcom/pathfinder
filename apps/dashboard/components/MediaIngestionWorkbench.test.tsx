/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  beginUpload: vi.fn(),
  completeUpload: vi.fn(),
  create: vi.fn(),
  fingerprintMediaSource: vi.fn(),
  reconcileUpload: vi.fn(),
  refresh: vi.fn(),
  signPart: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    mediaIngestion: {
      beginUpload: { mutate: mocks.beginUpload },
      completeUpload: { mutate: mocks.completeUpload },
      create: { mutate: mocks.create },
      reconcileUpload: { mutate: mocks.reconcileUpload },
      signPart: { mutate: mocks.signPart },
    },
  }),
}))

vi.mock('../lib/media-source-identity', () => ({
  MAX_MEDIA_SOURCE_BYTES: 5 * 1024 * 1024 * 1024,
  MEDIA_SOURCE_FINGERPRINT_ALGORITHM: 'pathfinder-sha256-part-manifest-v1',
  fingerprintMediaSource: mocks.fingerprintMediaSource,
}))

import { MediaIngestionWorkbench } from './admin/MediaIngestionWorkbench'

describe('media ingestion finalization recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fingerprintMediaSource.mockResolvedValue({
      algorithm: 'pathfinder-sha256-part-manifest-v1',
      digest: 'a'.repeat(64),
    })
    mocks.create.mockResolvedValue({ id: 'project_new' })
    mocks.beginUpload.mockResolvedValue({ partSize: 16 * 1024 * 1024, parts: [] })
    mocks.signPart.mockResolvedValue({ url: 'https://storage.test/part' })
    mocks.completeUpload.mockResolvedValue({ ok: true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ etag: 'etag_1' }),
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('cancels source checking before creating project state', async () => {
    mocks.fingerprintMediaSource.mockImplementationOnce(
      (_source: Blob, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('Media source fingerprinting was cancelled.', 'AbortError')),
          )
        }),
    )
    render(
      <MediaIngestionWorkbench
        tenantId="tenant_1"
        venueId="venue_1"
        venueName="Museum"
        initialProjects={[]}
      />,
    )
    const archive = new File([new Uint8Array([1])], 'visit.zip', {
      type: 'application/zip',
      lastModified: 123,
    })
    fireEvent.change(screen.getByLabelText(/Source ZIP/), { target: { files: [archive] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload and analyze' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel transfer' }))

    await waitFor(() => expect(mocks.fingerprintMediaSource).toHaveBeenCalledOnce())
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.beginUpload).not.toHaveBeenCalled()
  })

  it('does not finalize when cancellation wins after the last part response', async () => {
    let resolvePut: ((response: unknown) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePut = resolve
          }),
      ),
    )
    render(
      <MediaIngestionWorkbench
        tenantId="tenant_1"
        venueId="venue_1"
        venueName="Museum"
        initialProjects={[]}
      />,
    )
    const archive = new File([new Uint8Array([1])], 'visit.zip', {
      type: 'application/zip',
      lastModified: 123,
    })
    fireEvent.change(screen.getByLabelText(/Source ZIP/), { target: { files: [archive] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload and analyze' }))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }))
    resolvePut?.({ ok: true, status: 200, headers: new Headers({ etag: 'etag_1' }) })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Upload and analyze' })).toBeTruthy(),
    )
    expect(mocks.completeUpload).not.toHaveBeenCalled()
  })

  it('rejects empty and oversized archives before fingerprinting', async () => {
    render(
      <MediaIngestionWorkbench
        tenantId="tenant_1"
        venueId="venue_1"
        venueName="Museum"
        initialProjects={[]}
      />,
    )
    const input = screen.getByLabelText(/Source ZIP/)
    fireEvent.change(input, {
      target: {
        files: [new File([], 'empty.zip', { type: 'application/zip', lastModified: 123 })],
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload and analyze' }))
    expect(await screen.findByText(/between 1 byte and 5 GB/)).toBeTruthy()

    fireEvent.change(input, {
      target: {
        files: [
          {
            name: 'huge.zip',
            type: 'application/zip',
            lastModified: 123,
            size: 5 * 1024 * 1024 * 1024 + 1,
          },
        ],
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload and analyze' }))
    expect(await screen.findByText(/between 1 byte and 5 GB/)).toBeTruthy()
    expect(mocks.fingerprintMediaSource).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('fingerprints a new archive before creating storage-backed project state', async () => {
    render(
      <MediaIngestionWorkbench
        tenantId="tenant_1"
        venueId="venue_1"
        venueName="Museum"
        initialProjects={[]}
      />,
    )
    const archive = new File([new Uint8Array([1, 2, 3])], 'visit.zip', {
      type: 'application/zip',
      lastModified: 123,
    })
    fireEvent.change(screen.getByLabelText(/Source ZIP/), { target: { files: [archive] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload and analyze' }))

    await waitFor(() => expect(mocks.completeUpload).toHaveBeenCalledOnce())
    expect(mocks.fingerprintMediaSource).toHaveBeenCalledWith(
      archive,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    )
    expect(mocks.fingerprintMediaSource.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0] ?? 0,
    )
    expect(mocks.beginUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIdentity: {
          algorithm: 'pathfinder-sha256-part-manifest-v1',
          digest: 'a'.repeat(64),
        },
      }),
    )
  })

  it('requires explicit consent before requesting complete-video analysis', async () => {
    render(
      <MediaIngestionWorkbench
        tenantId="tenant_1"
        venueId="venue_1"
        venueName="Museum"
        initialProjects={[]}
      />,
    )
    const consent = screen.getByRole('checkbox', {
      name: /Analyze complete videos with Google Gemini/,
    }) as HTMLInputElement
    expect(consent.checked).toBe(false)
    expect(
      screen.getByText(
        /Torchiko sends supported photos, sampled video frames, optional audio, and up to 12,000 characters of operator context to OpenAI/,
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /Sends each client video, its filename, and up to 12,000 characters of this project's operator context to Google/,
      ),
    ).toBeTruthy()
    expect(screen.getByText(/uses the OpenAI processing described above/)).toBeTruthy()

    fireEvent.click(consent)
    const archive = new File([new Uint8Array([1, 2, 3])], 'visit.zip', {
      type: 'application/zip',
      lastModified: 123,
    })
    fireEvent.change(screen.getByLabelText(/Source ZIP/), { target: { files: [archive] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload and analyze' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ useGeminiVideoUnderstanding: true }),
      }),
    )
  })

  it('has no automated accessibility violations with video-provider disclosure visible', async () => {
    render(
      <main>
        <MediaIngestionWorkbench
          tenantId="tenant_1"
          venueId="venue_1"
          venueName="Museum"
          initialProjects={[]}
        />
      </main>,
    )

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })

  it('retains metadata-only resume only for a persisted legacy upload', async () => {
    render(
      <MediaIngestionWorkbench
        tenantId="tenant_1"
        venueId="venue_1"
        venueName="Museum"
        initialProjects={[
          {
            id: 'project_legacy',
            name: 'Legacy archive',
            mode: 'BALANCED',
            status: 'UPLOADING',
            stage: 'upload',
            progress: 10,
            sourceFileName: 'legacy.zip',
            sourceBytes: 3,
            sourceLastModified: 123,
            sourceFingerprintAlgorithm: null,
            uploadAttemptId: '11111111-1111-4111-8111-111111111111',
            actualCostCents: 0,
            estimatedCostCents: null,
            createdAt: new Date('2026-08-08T12:00:00.000Z'),
          },
        ]}
      />,
    )
    const input = screen.getByText('Resume upload').closest('label')?.querySelector('input')
    expect(input).toBeTruthy()
    const archive = new File([new Uint8Array([1, 2, 3])], 'legacy.zip', {
      type: 'application/zip',
      lastModified: 123,
    })
    fireEvent.change(input as HTMLInputElement, { target: { files: [archive] } })

    await waitFor(() => expect(mocks.completeUpload).toHaveBeenCalledOnce())
    expect(mocks.fingerprintMediaSource).not.toHaveBeenCalled()
    expect(mocks.beginUpload).toHaveBeenCalledWith(
      expect.not.objectContaining({ sourceIdentity: expect.anything() }),
    )
  })

  it('offers only exact-attempt reconciliation while an upload is finalizing', async () => {
    let resolveReconciliation: (() => void) | undefined
    mocks.reconcileUpload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReconciliation = resolve
        }),
    )

    render(
      <MediaIngestionWorkbench
        tenantId="tenant_1"
        venueId="venue_1"
        venueName="Museum"
        initialProjects={[
          {
            id: 'project_1',
            name: 'Visit archive',
            mode: 'BALANCED',
            status: 'UPLOADING',
            stage: 'finalizing',
            progress: 99,
            sourceFileName: 'visit.zip',
            sourceBytes: 10,
            sourceLastModified: 123,
            sourceFingerprintAlgorithm: 'pathfinder-sha256-part-manifest-v1',
            uploadAttemptId: '11111111-1111-4111-8111-111111111111',
            actualCostCents: 0,
            estimatedCostCents: null,
            createdAt: new Date('2026-08-08T12:00:00.000Z'),
          },
        ]}
      />,
    )

    expect(screen.queryByText('Resume upload')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Abort upload' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry finalization' }))

    await waitFor(() =>
      expect(mocks.reconcileUpload).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: '11111111-1111-4111-8111-111111111111',
      }),
    )
    expect(
      (screen.getByRole('button', { name: 'Checking finalization…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    resolveReconciliation?.()
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
  })
})
