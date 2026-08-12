/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  apply: vi.fn(),
  revert: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      approveNativeVenueDeployment: { mutate: mocks.approve },
      applyNativeVenueDeployment: { mutate: mocks.apply },
      revertNativeVenueDeployment: { mutate: mocks.revert },
    },
  }),
}))

import { NativeVenueDeploymentLifecycleControls } from './NativeVenueDeploymentLifecycleControls'

type Release = inferRouterOutputs<AppRouter>['admin']['getNativeVenueDeployment']
const timestamp = '2026-08-12T12:00:00.000Z'

function release(status: 'DRAFT' | 'APPROVED' | 'APPLIED' | 'REVERTED', id = crypto.randomUUID()) {
  const available =
    status === 'DRAFT'
      ? 'approve'
      : status === 'APPROVED'
        ? 'apply'
        : status === 'APPLIED'
          ? 'revert'
          : null
  return {
    id,
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    profile: 'NATIVE_CORE_V1',
    status,
    version: new Date(timestamp),
    createdAt: new Date(timestamp),
    updatedAt: new Date(timestamp),
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    coverage: [],
    materializable: true,
    unsupported: false,
    issues: [],
    issueCount: 0,
    nextIssueCursor: null,
    impactSummary: [],
    effectSummary: { expected: 0, recorded: 0, byKind: [] },
    commandCount: 0,
    allowedActions: {
      approve: {
        allowed: available === 'approve',
        reason: available === 'approve' ? null : 'Only a draft release can be approved.',
      },
      apply: {
        allowed: available === 'apply',
        reason: available === 'apply' ? null : 'Only an approved release can be applied.',
      },
      revert: {
        allowed: available === 'revert',
        reason: available === 'revert' ? null : 'Only the current applied release can be reverted.',
      },
      expectedUpdatedAt: timestamp,
    },
  } as unknown as Release
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('NativeVenueDeploymentLifecycleControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222',
    )
    mocks.approve.mockResolvedValue({ status: 'APPROVED', effectCount: null })
    mocks.apply.mockResolvedValue({ status: 'APPLIED', effectCount: 3 })
    mocks.revert.mockResolvedValue({ status: 'REVERTED', effectCount: 3 })
  })
  afterEach(cleanup)

  it('uses only the server-authorized action and exact release version', async () => {
    const current = release('APPROVED', '11111111-1111-4111-8111-111111111111')
    render(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={current}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply native release' }))
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1))
    expect(mocks.apply).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: current.id,
      commandId: '22222222-2222-4222-8222-222222222222',
      expectedUpdatedAt: timestamp,
    })
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.revert).not.toHaveBeenCalled()
  })

  it('fences a same-tick duplicate action', async () => {
    const pending = deferred<unknown>()
    mocks.approve.mockReturnValue(pending.promise)
    render(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={release('DRAFT')}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: 'Approve native release' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.approve).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ status: 'APPROVED', effectCount: null }))
  })

  it('retains the command identity for an ambiguous retry of the unchanged release', async () => {
    mocks.approve.mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({
      status: 'APPROVED',
      effectCount: null,
    })
    render(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={release('DRAFT')}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve native release' }))
    await screen.findByText('Action needs attention')
    fireEvent.click(screen.getByRole('button', { name: 'Approve native release' }))
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(2))
    expect(mocks.approve.mock.calls[0]?.[0].commandId).toBe(
      mocks.approve.mock.calls[1]?.[0].commandId,
    )
  })

  it('ignores a late result after the exact release version changes', async () => {
    const pending = deferred<unknown>()
    mocks.approve.mockReturnValue(pending.promise)
    const first = release('DRAFT', '11111111-1111-4111-8111-111111111111')
    const { rerender } = render(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={first}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve native release' }))
    const newer = {
      ...first,
      version: new Date('2026-08-12T12:01:00.000Z'),
      updatedAt: new Date('2026-08-12T12:01:00.000Z'),
      allowedActions: { ...first.allowedActions, expectedUpdatedAt: '2026-08-12T12:01:00.000Z' },
    } as unknown as Release
    rerender(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={newer}
      />,
    )
    await act(async () => pending.resolve({ status: 'APPROVED', effectCount: null }))
    expect(screen.queryByText('Action recorded')).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('shows the bounded current-head reason without exposing a revert control', () => {
    const stale = release('APPLIED')
    stale.allowedActions.revert = {
      allowed: false,
      reason: 'A later release is the current venue deployment.',
    }
    render(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={stale}
      />,
    )
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull()
    expect(screen.getByText('A later release is the current venue deployment.')).toBeTruthy()
  })

  it('does not invent a revert effect count and states the exact evidence condition', async () => {
    mocks.revert.mockResolvedValue({ status: 'REVERTED', effectCount: null })
    render(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={release('APPLIED')}
      />,
    )
    expect(screen.getByText(/only if the exact applied evidence is unchanged/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Revert native release' }))
    expect(await screen.findByText('Action recorded')).toBeTruthy()
    expect(screen.getByText(/recorded mutable state was restored/)).toBeTruthy()
    expect(screen.queryByText(/0 effects/)).toBeNull()
    expect(screen.queryByText(/Compatible later edits/)).toBeNull()
  })

  it('has no automated accessibility violations in an actionable state', async () => {
    const { container } = render(
      <NativeVenueDeploymentLifecycleControls
        tenantId="tenant-1"
        venueId="venue-1"
        initialRelease={release('DRAFT')}
      />,
    )
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
