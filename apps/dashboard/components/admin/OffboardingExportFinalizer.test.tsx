// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

const mocks = vi.hoisted(() => ({ review: vi.fn(), finalize: vi.fn(), refresh: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      reviewOffboardingPlanExports: { mutate: mocks.review },
      finalizeOffboardingExportArtifact: { mutate: mocks.finalize },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { OffboardingExportFinalizer } from './OffboardingExportFinalizer'

type Projection = inferRouterOutputs<AppRouter>['admin']['getOffboardingExportFinalization']

const reviewed: Projection = {
  planId: 'plan-1',
  status: 'REVIEWED' as const,
  expectedUpdatedAt: '2026-08-12T12:00:00.000Z',
  remainingArtifacts: 2,
  exportActions: {
    review: { allowed: false, reason: 'This plan is no longer awaiting export review.' },
    finalize: { allowed: true, reason: 'Generate one remaining non-deleting export artifact.' },
  },
  targets: [
    {
      venueId: 'venue-1',
      remainingExportKinds: ['CONFIGURATION', 'AUDIT_HISTORY'],
    },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('OffboardingExportFinalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('35a7173c-b42b-485b-8885-81355585489e')
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reviews only the exact server-authorized matrix and locks stale actions', async () => {
    mocks.review.mockResolvedValue({
      planId: 'plan-1',
      status: 'REVIEWED',
      expectedUpdatedAt: '2026-08-12T12:01:00.000Z',
      replayed: false,
    })
    const requested = {
      ...reviewed,
      status: 'REQUESTED' as const,
      exportActions: {
        review: { allowed: true, reason: 'Review the declared non-deleting export matrix.' },
        finalize: { allowed: false, reason: 'Finalize requires review.' },
      },
    }
    render(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={requested}
        venueNames={{ 'venue-1': 'Museum' }}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: 'Review export matrix' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.review).toHaveBeenCalledOnce())
    expect(mocks.review).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      planId: 'plan-1',
      operationId: '35a7173c-b42b-485b-8885-81355585489e',
      expectedUpdatedAt: '2026-08-12T12:00:00.000Z',
    })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect((await screen.findByRole('status')).textContent).toMatch(/No artifact was generated/iu)
  })

  it('finalizes the selected remaining kind and retains an ambiguous operation identity', async () => {
    mocks.finalize
      .mockRejectedValueOnce(new Error('s3://private-bucket/hash-secret'))
      .mockResolvedValueOnce({
        planId: 'plan-1',
        venueId: 'venue-1',
        kind: 'CONFIGURATION',
        status: 'STORED',
        artifactRecorded: false,
        replayed: true,
        planStatus: 'REVIEWED',
        remainingArtifacts: 2,
        planUpdatedAt: '2026-08-12T12:00:00.000Z',
      })
      .mockResolvedValueOnce({
        planId: 'plan-1',
        venueId: 'venue-1',
        kind: 'CONFIGURATION',
        status: 'SETTLED',
        artifactRecorded: true,
        replayed: true,
        planStatus: 'REVIEWED',
        remainingArtifacts: 1,
        planUpdatedAt: '2026-08-12T12:00:00.000Z',
      })
    render(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={reviewed}
        venueNames={{ 'venue-1': 'Museum' }}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: 'Generate and store artifact' })
    fireEvent.click(button)
    expect(await screen.findByText(/result could not be confirmed/iu)).toBeTruthy()
    expect(screen.queryByText(/private-bucket|hash-secret/iu)).toBeNull()
    fireEvent.click(button)
    await waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/artifact was stored and its metadata recorded/iu)).toBeNull()
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(3))
    expect(mocks.finalize.mock.calls[0]?.[0]).toEqual(mocks.finalize.mock.calls[1]?.[0])
    expect(mocks.finalize.mock.calls[1]?.[0]).toEqual(mocks.finalize.mock.calls[2]?.[0])
    expect(mocks.finalize).toHaveBeenLastCalledWith({
      tenantId: 'tenant-1',
      planId: 'plan-1',
      venueId: 'venue-1',
      kind: 'CONFIGURATION',
      operationId: '35a7173c-b42b-485b-8885-81355585489e',
      expectedPlanUpdatedAt: '2026-08-12T12:00:00.000Z',
    })
    expect((await screen.findByRole('status')).textContent).toMatch(
      /1 requested artifact remains/iu,
    )
  })

  it('retains an ambiguous operation identity across another selection and back', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('35a7173c-b42b-485b-8885-81355585489e')
      .mockReturnValueOnce('80a57ba8-67f0-429b-a591-442727a13ddd')
    mocks.finalize
      .mockRejectedValueOnce(new Error('settlement response unavailable'))
      .mockResolvedValueOnce({
        planId: 'plan-1',
        venueId: 'venue-1',
        kind: 'CONFIGURATION',
        status: 'SETTLED',
        artifactRecorded: true,
        replayed: true,
        planStatus: 'REVIEWED',
        remainingArtifacts: 1,
        planUpdatedAt: '2026-08-12T12:00:00.000Z',
      })
    render(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={reviewed}
        venueNames={{ 'venue-1': 'Museum' }}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate and store artifact' }))
    expect(await screen.findByText(/result could not be confirmed/iu)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Requested export'), {
      target: { value: 'AUDIT_HISTORY' },
    })
    fireEvent.change(screen.getByLabelText('Requested export'), {
      target: { value: 'CONFIGURATION' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate and store artifact' }))
    await waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(2))
    expect(mocks.finalize.mock.calls[1]?.[0].operationId).toBe(
      mocks.finalize.mock.calls[0]?.[0].operationId,
    )
    expect(crypto.randomUUID).toHaveBeenCalledOnce()
  })

  it('purges a definitive conflict identity and locks the stale projection', async () => {
    mocks.finalize.mockRejectedValue(
      Object.assign(new Error('internal object key'), { data: { code: 'CONFLICT' } }),
    )
    render(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={reviewed}
        venueNames={{ 'venue-1': 'Museum' }}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: 'Generate and store artifact' })
    fireEvent.click(button)
    expect(await screen.findByText(/plan changed or is no longer available/iu)).toBeTruthy()
    expect(screen.queryByText(/internal object key/iu)).toBeNull()
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('ignores a late result after exact plan version and remaining matrix change', async () => {
    const pending = deferred<{
      planId: string
      venueId: string
      kind: 'CONFIGURATION'
      status: 'SETTLED'
      artifactRecorded: true
      replayed: false
      planStatus: 'EXPORT_READY'
      remainingArtifacts: 0
      planUpdatedAt: string
    }>()
    mocks.finalize.mockReturnValue(pending.promise)
    const { rerender } = render(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={reviewed}
        venueNames={{ 'venue-1': 'Museum' }}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate and store artifact' }))
    rerender(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={{
          ...reviewed,
          expectedUpdatedAt: '2026-08-12T12:02:00.000Z',
          remainingArtifacts: 1,
          targets: [{ venueId: 'venue-1', remainingExportKinds: ['AUDIT_HISTORY'] }],
        }}
        venueNames={{ 'venue-1': 'Museum' }}
      />,
    )
    await act(async () =>
      pending.resolve({
        planId: 'plan-1',
        venueId: 'venue-1',
        kind: 'CONFIGURATION',
        status: 'SETTLED',
        artifactRecorded: true,
        replayed: false,
        planStatus: 'EXPORT_READY',
        remainingArtifacts: 0,
        planUpdatedAt: '2026-08-12T12:02:00.000Z',
      }),
    )
    expect(screen.queryByText(/All requested export artifact metadata/iu)).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Requested export') as HTMLSelectElement).value).toBe(
      'AUDIT_HISTORY',
    )
  })

  it('does not submit a stale tuple after a same-tick venue or kind selection change', () => {
    const multipleTargets: Projection = {
      ...reviewed,
      remainingArtifacts: 3,
      targets: [
        ...reviewed.targets,
        { venueId: 'venue-2', remainingExportKinds: ['CONTENT_HISTORY'] },
      ],
    }
    render(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={multipleTargets}
        venueNames={{ 'venue-1': 'Museum', 'venue-2': 'Gallery' }}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: 'Generate and store artifact' })
    act(() => {
      fireEvent.change(screen.getByLabelText('Requested export'), {
        target: { value: 'AUDIT_HISTORY' },
      })
      fireEvent.click(button)
    })
    expect(mocks.finalize).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    act(() => {
      fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'venue-2' } })
      fireEvent.click(button)
    })
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('renders truthful boundaries and passes axe without sensitive evidence', async () => {
    const { container } = render(
      <OffboardingExportFinalizer
        tenantId="tenant-1"
        projection={reviewed}
        venueNames={{ 'venue-1': 'Museum' }}
      />,
    )
    expect(
      screen.getByText(/does not revoke access, delete data, enforce retention/iu),
    ).toBeTruthy()
    expect(container.textContent).not.toMatch(/artifactReference|contentHash|objectKey|SHA-256/iu)
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
