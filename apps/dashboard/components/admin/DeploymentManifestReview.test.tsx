/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), fullPreview: vi.fn(), create: vi.fn() }))
vi.mock('../../lib/trpc', () => {
  const client = {
    admin: {
      reviewDeploymentManifest: { query: mocks.query },
      previewFullVenueDeploymentManifest: { query: mocks.fullPreview },
      createVenuePackageManifestArtifact: { mutate: mocks.create },
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
      materialization: {
        artifactKind: 'VENUE_DEPLOYMENT_MANIFEST_V2',
        manifestHash: 'a'.repeat(64),
        baseManifestHash: 'b'.repeat(64),
        status: 'MATERIALIZABLE',
        coverage: {
          IDENTITY: 'COMPLETE',
          BRANDING: 'COMPLETE',
          AI_CONFIGURATION: 'COMPLETE',
          CAPABILITIES: 'COMPLETE',
          CONTENT: 'COMPLETE',
          ASSETS: 'COMPLETE',
          EVALUATION: 'COMPLETE',
        },
        issues: [],
        legacyPayloadHash: 'c'.repeat(64),
      },
    })
    mocks.create.mockResolvedValue({ replayed: false, draft: null })
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
    expect(
      screen.getByText(
        /supported PATCH also atomically creates or replays its linked compatibility DRAFT/iu,
      ),
    ).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/never creates.*venue package/iu)
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
    expect(screen.getAllByText('COMPLETE')).toHaveLength(7)
  })

  it('truthfully records a supported PATCH artifact with its atomic linked DRAFT', async () => {
    mocks.create.mockResolvedValueOnce({ replayed: false, draft: { id: 'private-draft-id' } })
    render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)
    fireEvent.change(screen.getByLabelText('Manifest JSON'), {
      target: { value: '{"packageType":"PATCH"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }))
    expect(
      await screen.findByText(/atomically creates or replays its linked compatibility DRAFT/iu),
    ).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Record artifact and linked DRAFT' }))
    expect(
      await screen.findByText(/artifact and linked compatibility DRAFT created atomically/iu),
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain('private-draft-id')
    expect(screen.queryByText(/Nothing was approved or applied/iu)).toBeTruthy()
  })

  it('renders a bounded NOT_MATERIALIZABLE artifact gate with all coverage and no legacy handoff', async () => {
    const issues = Array.from({ length: 45 }, (_, index) => ({
      severity: 'ERROR' as const,
      code: `BLOCKED_${index}`,
      path: `content.${index}`,
      message: `Blocked issue ${index}`,
    }))
    mocks.query.mockResolvedValueOnce({
      scope: { tenantId: 't1', venueId: 'v1', venueName: 'Museum' },
      compatible: false,
      manifestHash: 'a'.repeat(64),
      issues,
      handoff: null,
      previewInput: null,
      draftInput: null,
      materialization: {
        artifactKind: 'VENUE_DEPLOYMENT_MANIFEST_V2',
        manifestHash: 'a'.repeat(64),
        baseManifestHash: null,
        status: 'NOT_MATERIALIZABLE',
        coverage: {
          IDENTITY: 'BLOCKED',
          BRANDING: 'BLOCKED',
          AI_CONFIGURATION: 'BLOCKED',
          CAPABILITIES: 'BLOCKED',
          CONTENT: 'BLOCKED',
          ASSETS: 'BLOCKED',
          EVALUATION: 'BLOCKED',
        },
        issues,
        legacyPayloadHash: null,
      },
    })
    render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)
    fireEvent.change(screen.getByLabelText('Manifest JSON'), {
      target: { value: '{"packageType":"FULL"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }))
    expect(await screen.findByText('Artifact is not materializable')).toBeTruthy()
    expect(screen.getByText('FULL')).toBeTruthy()
    expect(screen.getAllByText('BLOCKED')).toHaveLength(7)
    expect(screen.getByText(/Showing 20 of 45 issues.*25 remaining/iu)).toBeTruthy()
    expect(screen.queryByText('Blocked issue 22')).toBeNull()
    expect(screen.queryByText('Blocked issue 44')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show next 20 issues' }))
    expect(screen.getByText('Blocked issue 22')).toBeTruthy()
    expect(screen.queryByText('Blocked issue 44')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show next 5 issues' })).toBeTruthy()
    expect(screen.queryByText('Lifecycle handoff')).toBeNull()
    expect(screen.queryByText('Exact venuePackage.createDraft input')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Apply|^Create draft/iu })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Record immutable review artifact' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(await screen.findByText(/No venue package was created or applied/iu)).toBeTruthy()
  })

  it('fences same-tick review and ignores a late result after exact scope changes', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof mocks.query>>) => void
    mocks.query.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const view = render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)
    fireEvent.change(screen.getByLabelText('Manifest JSON'), { target: { value: '{}' } })
    const review = screen.getByRole('button', { name: 'Review manifest' })
    const oldManifestId = screen.getByLabelText<HTMLInputElement>('FULL manifest ID').value
    const oldIdempotencyKey = screen.getByLabelText<HTMLInputElement>('FULL idempotency key').value
    fireEvent.click(review)
    fireEvent.click(review)
    expect(mocks.query).toHaveBeenCalledOnce()
    view.rerender(<DeploymentManifestReview tenantId="t1" venueId="v2" />)
    expect(screen.getByLabelText<HTMLInputElement>('FULL manifest ID').value).not.toBe(
      oldManifestId,
    )
    expect(screen.getByLabelText<HTMLInputElement>('FULL idempotency key').value).not.toBe(
      oldIdempotencyKey,
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Manifest JSON').value).toBe('')
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Review manifest' }).disabled,
    ).toBe(true)
    await act(async () => resolve({} as never))
    expect(screen.queryByLabelText('Manifest conversion review')).toBeNull()
  })

  it('has no automated accessibility violations in the blocked artifact state', async () => {
    const { container } = render(<DeploymentManifestReview tenantId="t1" venueId="v1" />)
    fireEvent.change(screen.getByLabelText('Manifest JSON'), { target: { value: '{}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }))
    await screen.findByText(/PATCH artifact is materializable/iu)
    document.documentElement.lang = 'en'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map(({ id }) => id)).toEqual([])
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
