/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  apply: vi.fn(),
  revert: vi.fn(),
  get: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      approveVenuePackage: { mutate: mocks.approve },
      applyVenuePackage: { mutate: mocks.apply },
      revertVenuePackage: { mutate: mocks.revert },
      getVenuePackageForReview: { query: mocks.get },
    },
  }),
}))

import { VenuePackageLifecycleControls } from './VenuePackageLifecycleControls'

type PackageReview = inferRouterOutputs<AppRouter>['admin']['getVenuePackageForReview']

const updatedAt = new Date('2026-08-12T12:00:00.000Z')
const review = {
  id: 'package-1',
  schemaVersion: 1,
  payloadHash: 'a'.repeat(64),
  baseDigest: 'b'.repeat(64),
  status: 'DRAFT',
  approvedAt: null,
  appliedAt: null,
  revertedAt: null,
  createdAt: updatedAt,
  updatedAt,
  payload: { schemaVersion: 1, places: [], knowledgeEntries: [] },
  validationReport: {
    errors: [],
    warnings: [],
    semanticDuplicateScan: {
      status: 'COMPLETE',
      similarityThreshold: 0.9,
      scopes: {
        places: {
          embeddingProfile: 'openai:text-embedding-3-small:1536',
          inputCount: 0,
          scannedInputCount: 0,
          existingCount: 0,
          scannedExistingCount: 0,
        },
        knowledgeEntries: {
          embeddingProfile: 'openai:text-embedding-3-small:1536',
          inputCount: 0,
          scannedInputCount: 0,
          existingCount: 0,
          scannedExistingCount: 0,
        },
      },
    },
  },
  previewPlan: {
    schemaVersion: 1,
    payloadHash: 'a'.repeat(64),
    baseDigest: 'b'.repeat(64),
    warningDigest: 'c'.repeat(64),
    mode: 'ADDITIVE_V1',
    report: {
      errors: [],
      warnings: [],
      semanticDuplicateScan: {
        status: 'COMPLETE',
        similarityThreshold: 0.9,
        scopes: {
          places: {
            embeddingProfile: 'openai:text-embedding-3-small:1536',
            inputCount: 0,
            scannedInputCount: 0,
            existingCount: 0,
            scannedExistingCount: 0,
          },
          knowledgeEntries: {
            embeddingProfile: 'openai:text-embedding-3-small:1536',
            inputCount: 0,
            scannedInputCount: 0,
            existingCount: 0,
            scannedExistingCount: 0,
          },
        },
      },
    },
    changes: {
      places: { add: [], change: [], remove: [], unchanged: 0 },
      knowledgeEntries: { add: [], change: [], remove: [], unchanged: 0 },
    },
  },
} as unknown as PackageReview

function codedError(code: string) {
  return Object.assign(new Error('changed'), { data: { code } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderControls(initialPackage: PackageReview = review) {
  return render(
    <VenuePackageLifecycleControls
      tenantId="tenant-1"
      venueId="venue-1"
      initialPackage={initialPackage}
    />,
  )
}

describe('Internal Workspace VenuePackage lifecycle controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockResolvedValue(review)
  })
  afterEach(cleanup)

  it('requires explicit review and sends exact approval evidence and scope', async () => {
    const approved = { ...review, status: 'APPROVED' } as PackageReview
    mocks.approve.mockResolvedValue(approved)
    mocks.get.mockResolvedValue(approved)
    renderControls()
    const approve = screen.getByRole('button', { name: 'Approve reviewed package' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    fireEvent.click(approve)
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledOnce())
    expect(mocks.approve).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      id: 'package-1',
      expectedUpdatedAt: updatedAt,
      commandKey: expect.any(String),
      acknowledgedWarningDigest: 'c'.repeat(64),
      acknowledgedPayloadHash: 'a'.repeat(64),
    })
    expect(mocks.get).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      packageId: 'package-1',
    })
    expect(await screen.findByRole('button', { name: 'Apply approved package' })).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('requires warning acknowledgement for a draft with warnings', () => {
    renderControls({
      ...review,
      validationReport: {
        ...review.validationReport,
        warnings: [{ path: 'places.0', code: 'DUPLICATE', message: 'Review this item.' }],
      },
    } as PackageReview)
    expect(screen.getByRole('listitem').textContent).toContain('Review this item.')
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    expect(
      (screen.getByRole('button', { name: 'Approve reviewed package' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByLabelText(/reviewed all 1 warning/i))
    expect(
      (screen.getByRole('button', { name: 'Approve reviewed package' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('requires progressive disclosure of every warning before acknowledgement', async () => {
    const warnings = Array.from({ length: 23 }, (_, index) => ({
      path: `places.${index}`,
      code: 'DUPLICATE',
      message: `Warning detail ${index + 1}`,
    }))
    const { container } = renderControls({
      ...review,
      validationReport: { ...review.validationReport, warnings },
    } as PackageReview)
    expect(screen.getAllByRole('listitem')).toHaveLength(20)
    expect(screen.queryByLabelText(/reviewed all 23 warnings/i)).toBeNull()
    expect(screen.getByText(/showing 20 of 23 warnings/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all 23 warnings' }))
    const renderedWarnings = screen.getAllByRole('listitem')
    expect(renderedWarnings).toHaveLength(23)
    warnings.forEach((warning, index) => {
      expect(renderedWarnings[index]?.textContent).toContain(warning.message)
    })
    expect(screen.getByLabelText(/reviewed all 23 warnings/i)).toBeTruthy()
    document.documentElement.lang = 'en'
    document.title = 'Venue package warnings'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations.map(({ id }) => id)).toEqual([])
  })

  it('refreshes a conflict and requires a second explicit review', async () => {
    const refreshed = { ...review, updatedAt: new Date('2026-08-12T12:05:00.000Z') }
    mocks.approve.mockRejectedValue(codedError('CONFLICT'))
    mocks.get.mockResolvedValue(refreshed)
    renderControls()
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed package' }))
    expect(await screen.findByText(/current revision was refreshed/i)).toBeTruthy()
    expect(mocks.get).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      packageId: 'package-1',
    })
    expect(
      (screen.getByRole('button', { name: 'Approve reviewed package' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the refreshed revision' }))
    expect(screen.getByLabelText(/intend to approve it/i)).toBeTruthy()
  })

  it.each(['PRECONDITION_FAILED', 'BAD_REQUEST'])(
    'refreshes %s evidence failures and rotates the command key after re-review',
    async (code) => {
      const approved = { ...review, status: 'APPROVED' } as PackageReview
      mocks.approve.mockRejectedValueOnce(codedError(code)).mockResolvedValueOnce(approved)
      mocks.get.mockResolvedValueOnce(review).mockResolvedValueOnce(approved)
      renderControls()
      fireEvent.click(screen.getByLabelText(/intend to approve it/i))
      fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed package' }))
      expect(await screen.findByText(/review evidence is no longer acceptable/i)).toBeTruthy()
      const firstKey = mocks.approve.mock.calls[0]?.[0].commandKey
      fireEvent.click(screen.getByRole('button', { name: 'I reviewed the refreshed revision' }))
      fireEvent.click(screen.getByLabelText(/intend to approve it/i))
      fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed package' }))
      await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(2))
      expect(mocks.approve.mock.calls[1]?.[0].commandKey).not.toBe(firstKey)
    },
  )

  it('retains the command key for an unchanged ambiguous retry', async () => {
    mocks.approve.mockRejectedValue(new Error('Connection interrupted'))
    renderControls()
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    const approve = screen.getByRole('button', { name: 'Approve reviewed package' })
    fireEvent.click(approve)
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(1))
    const firstKey = mocks.approve.mock.calls[0]?.[0].commandKey
    fireEvent.click(approve)
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(2))
    expect(mocks.approve.mock.calls[1]?.[0].commandKey).toBe(firstKey)
  })

  it('fences same-tick duplicate lifecycle submissions', async () => {
    const pending = deferred<PackageReview>()
    mocks.approve.mockReturnValue(pending.promise)
    renderControls()
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    const approve = screen.getByRole('button', { name: 'Approve reviewed package' })
    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(mocks.approve).toHaveBeenCalledOnce()
    pending.resolve({ ...review, status: 'APPROVED' } as PackageReview)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce())
  })

  it('uses only the status-authorized action and confirms reversion', async () => {
    renderControls({ ...review, status: 'APPLIED' } as PackageReview)
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /apply approved/i })).toBeNull()
    fireEvent.click(screen.getByLabelText(/reverse this package’s recorded effects/i))
    fireEvent.click(screen.getByRole('button', { name: 'Revert applied package' }))
    await waitFor(() => expect(mocks.revert).toHaveBeenCalledOnce())
  })

  it('offers apply only for APPROVED and sends the immutable revision identity', async () => {
    mocks.apply.mockResolvedValue({ ...review, status: 'APPLIED' })
    renderControls({ ...review, status: 'APPROVED' } as PackageReview)
    expect(screen.queryByRole('button', { name: /approve reviewed/i })).toBeNull()
    fireEvent.click(screen.getByLabelText(/apply every recorded change atomically/i))
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledOnce())
    expect(mocks.apply).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      id: 'package-1',
      expectedUpdatedAt: updatedAt,
      commandKey: expect.any(String),
    })
  })

  it('renders REVERTED as terminal without a mutation control', () => {
    renderControls({ ...review, status: 'REVERTED' } as PackageReview)
    expect(screen.getByText(/no further lifecycle action is available/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /package/i })).toBeNull()
  })

  it('terminalizes the selection when the exact package is not found', async () => {
    mocks.approve.mockRejectedValue(codedError('NOT_FOUND'))
    renderControls()
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed package' }))
    expect(await screen.findByText(/no lifecycle controls are available/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve reviewed package' })).toBeNull()
  })

  it('ignores a late result after the selected package scope changes', async () => {
    const pending = deferred<PackageReview>()
    mocks.approve.mockReturnValue(pending.promise)
    const { rerender } = renderControls()
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed package' }))
    const replacement = { ...review, id: 'package-2', status: 'REVERTED' } as PackageReview
    rerender(
      <VenuePackageLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialPackage={replacement}
      />,
    )
    pending.resolve({ ...review, status: 'APPROVED' } as PackageReview)
    await waitFor(() =>
      expect(screen.getByText(/no further lifecycle action is available/i)).toBeTruthy(),
    )
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('does not carry an old confirmation into a replacement package scope', () => {
    const { rerender } = renderControls()
    fireEvent.click(screen.getByLabelText(/intend to approve it/i))
    rerender(
      <VenuePackageLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialPackage={{ ...review, id: 'package-2', status: 'APPROVED' } as PackageReview}
      />,
    )
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: 'Apply approved package' })
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('has no automated accessibility violations in the actionable state', async () => {
    const { container } = renderControls()
    document.documentElement.lang = 'en'
    document.title = 'Venue package lifecycle'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations.map(({ id }) => id)).toEqual([])
  })
})
