/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), fullPreview: vi.fn() }))
vi.mock('../../lib/trpc', () => {
  const client = {
    admin: {
      reviewDeploymentManifest: { query: mocks.query },
      previewFullVenueDeploymentManifest: { query: mocks.fullPreview },
    },
  }
  return { useTRPCClient: () => client }
})
import { DeploymentManifestReview } from './DeploymentManifestReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('DeploymentManifestReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
    mocks.query.mockResolvedValue({
      scope: { tenantId: 't1', venueId: 'v1', venueName: 'Museum' },
      compatible: true,
      manifestHash: 'a'.repeat(64),
      issues: [
        {
          severity: 'WARNING',
          code: 'BASE_HASH_DELEGATED',
          path: 'baseManifestHash',
          message: 'Preview remains authoritative.',
        },
      ],
      handoff: {
        previewProcedure: 'venuePackage.preview',
        draftProcedure: 'venuePackage.createDraft',
        approvalProcedure: 'venuePackage.approve',
        applyProcedure: 'venuePackage.applyPackage',
        rollbackProcedure: 'venuePackage.revertPackage',
      },
      previewInput: { venueId: 'v1', payload: { schemaVersion: 3 } },
      draftInput: { venueId: 'v1', payload: { schemaVersion: 3 }, draftKey: 'key' },
    })
    mocks.fullPreview.mockResolvedValue({
      scope: { tenantId: 't1', venueId: 'v1', venueName: 'Museum' },
      manifest: {
        schemaVersion: 2,
        packageType: 'FULL',
        manifestId: '11111111-1111-4111-8111-111111111111',
        venueRef: 'v1',
      },
      canonicalJson: '{"packageType":"FULL"}',
      manifestHash: 'b'.repeat(64),
      readiness: {
        status: 'NOT_READY',
        readyForApply: false,
        omissions: [
          {
            code: 'GENERALIZED_CONTENT_PUBLICATION_UNAVAILABLE',
            section: 'CONTENT',
            message: 'Generalized modules are omitted.',
          },
        ],
      },
      download: {
        filename: 'venue-deployment-manifest-museum.v2.full.json',
        mediaType: 'application/json',
        byteLength: 22,
      },
    })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  it('submits only bounded review text and renders exact handoff shapes without mutation controls', async () => {
    render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)
    const text = '{"schemaVersion":2}'
    const input = screen.getByLabelText('Manifest JSON') as HTMLTextAreaElement
    expect(input.maxLength).toBe(250000)
    fireEvent.change(input, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }))
    await waitFor(() =>
      expect(mocks.query).toHaveBeenCalledWith({
        tenantId: 't1',
        venueId: 'v1',
        manifestJson: text,
      }),
    )
    expect(await screen.findByText('Exact venuePackage.preview input')).toBeTruthy()
    expect(screen.getByText('Exact venuePackage.createDraft input')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /create|approve|apply/i })).toBeNull()
  })
  it('preserves input and reports a truthful review failure', async () => {
    mocks.query.mockRejectedValue(new Error('down'))
    render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)
    const input = screen.getByLabelText('Manifest JSON') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '{bad}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(input.value).toBe('{bad}')
  })

  it('generates a caller-enveloped FULL preview with explicit omissions and no apply control', async () => {
    render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate FULL preview' }))
    await waitFor(() =>
      expect(mocks.fullPreview).toHaveBeenCalledWith({
        tenantId: 't1',
        venueId: 'v1',
        manifestId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      }),
    )
    expect(await screen.findByText('Not ready to apply')).toBeTruthy()
    expect(screen.getByText('GENERALIZED_CONTENT_PUBLICATION_UNAVAILABLE')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download reviewed JSON' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Apply/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Create draft/i })).toBeNull()
  })

  it('clears a reviewed artifact when its envelope changes or a later request fails', async () => {
    mocks.fullPreview
      .mockResolvedValueOnce({
        scope: { tenantId: 't1', venueId: 'v1', venueName: 'Museum' },
        manifest: { packageType: 'FULL' },
        canonicalJson: '{"packageType":"FULL"}',
        manifestHash: 'b'.repeat(64),
        readiness: { status: 'NOT_READY', readyForApply: false, omissions: [] },
        download: {
          filename: 'venue-deployment-manifest-museum.v2.full.json',
          mediaType: 'application/json',
          byteLength: 22,
        },
      })
      .mockRejectedValueOnce(new Error('projection unavailable'))
    render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate FULL preview' }))
    expect(await screen.findByRole('button', { name: 'Download reviewed JSON' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('FULL manifest ID'), {
      target: { value: '33333333-3333-4333-8333-333333333333' },
    })
    expect(screen.queryByRole('button', { name: 'Download reviewed JSON' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Generate FULL preview' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download reviewed JSON' })).toBeNull()
  })

  it('downloads exactly the canonical JSON with reviewed metadata and revokes the object URL', async () => {
    const canonicalJson = '{"packageType":"FULL","schemaVersion":2}'
    mocks.fullPreview.mockResolvedValueOnce({
      scope: { tenantId: 't1', venueId: 'v1', venueName: 'Museum' },
      manifest: { packageType: 'FULL', schemaVersion: 2 },
      canonicalJson,
      manifestHash: 'c'.repeat(64),
      readiness: { status: 'NOT_READY', readyForApply: false, omissions: [] },
      download: {
        filename: 'venue-deployment-manifest-museum.v2.full.json',
        mediaType: 'application/json',
        byteLength: canonicalJson.length,
      },
    })
    const artifact = { canonicalJson, type: 'application/json' }
    const blob = vi.spyOn(globalThis, 'Blob').mockImplementation(((
      parts: BlobPart[],
      options?: BlobPropertyBag,
    ) => {
      expect(parts).toEqual([canonicalJson])
      expect(options).toEqual({ type: 'application/json' })
      return artifact
    }) as never)
    const createObjectURL = vi.fn().mockReturnValue('blob:reviewed-manifest')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate FULL preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download reviewed JSON' }))

    expect(blob).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledWith(artifact)
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement | undefined
    expect(anchor).toBeDefined()
    if (!anchor) throw new Error('Expected one reviewed manifest download anchor.')
    expect(anchor.download).toBe('venue-deployment-manifest-museum.v2.full.json')
    expect(anchor.href).toContain('blob:reviewed-manifest')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:reviewed-manifest')
  })
})
