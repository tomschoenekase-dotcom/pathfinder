/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  reconcileUpload: vi.fn(),
  refresh: vi.fn(),
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
      reconcileUpload: { mutate: mocks.reconcileUpload },
    },
  }),
}))

import { MediaIngestionWorkbench } from './admin/MediaIngestionWorkbench'

describe('media ingestion finalization recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
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
