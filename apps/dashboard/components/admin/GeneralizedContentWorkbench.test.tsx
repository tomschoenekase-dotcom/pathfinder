// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
  revise: vi.fn(),
  retire: vi.fn(),
  publish: vi.fn(),
  withdraw: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      previewUniversalContent: { query: mocks.preview },
      createUniversalContent: { mutate: mocks.create },
      addUniversalContentRevision: { mutate: mocks.revise },
      retireUniversalContent: { mutate: mocks.retire },
      publishUniversalContent: { mutate: mocks.publish },
      withdrawUniversalContent: { mutate: mocks.withdraw },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { GeneralizedContentWorkbench } from './GeneralizedContentWorkbench'

describe('GeneralizedContentWorkbench', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.preview.mockResolvedValue({
      preview: { lifecycle: 'EFFECTIVE', audience: 'OPERATOR' },
    })
  })

  it('shows the honest default-off state and disables durable writes', () => {
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled={false}
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    expect(screen.getByText('Default-off flag disabled')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Create module' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText(/PUBLIC revisions remain private drafts/i)).toBeTruthy()
  })

  it('validates through the server contract and reports the no-publication preview', async () => {
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Typed payload JSON'), {
      target: { value: '{"kind":"SERVICE","name":"Coat check"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }))
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce())
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    )
    expect(screen.getByRole('status').textContent).toMatch(
      /guest and client publication remain off/i,
    )
  })

  it('uses the displayed latest version as the revision CAS', async () => {
    mocks.revise.mockResolvedValue({ version: 4 })
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[
          {
            id: 'module-1',
            revisionId: 'revision-3',
            kind: 'POLICY',
            version: 3,
            audience: 'OPERATOR',
            effectiveFrom: null,
            effectiveUntil: null,
            payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
            publishedRevisionId: null,
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'module-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Append revision' }))
    await waitFor(() => expect(mocks.revise).toHaveBeenCalledOnce())
    expect(mocks.revise).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'module-1', expectedLatestVersion: 3 }),
    )
  })

  it('re-enables the workbench after a confirmed retirement revision', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('2026-08-12T18:00:00.000Z')
    mocks.retire.mockResolvedValue({ version: 4 })
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[
          {
            id: 'module-1',
            revisionId: 'revision-3',
            kind: 'POLICY',
            version: 3,
            audience: 'OPERATOR',
            effectiveFrom: null,
            effectiveUntil: null,
            payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
            publishedRevisionId: null,
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'module-1' } })
    const retireButton = screen.getByRole('button', { name: 'Append retirement revision' })
    fireEvent.click(retireButton)
    await waitFor(() => expect(mocks.retire).toHaveBeenCalledOnce())
    await waitFor(() => expect((retireButton as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByRole('status').textContent).toMatch(/retirement boundary recorded/i)
  })

  it('retains the exact publication request key across an ambiguous unchanged retry', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('35a7173c-b42b-485b-8885-81355585489e')
    mocks.publish
      .mockRejectedValueOnce(new Error('Unknown result'))
      .mockResolvedValueOnce({ action: 'PUBLISH' })
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[
          {
            id: 'module-1',
            revisionId: 'revision-3',
            kind: 'POLICY',
            version: 3,
            audience: 'PUBLIC',
            effectiveFrom: null,
            effectiveUntil: null,
            payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
            publishedRevisionId: null,
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'module-1' } })
    const button = screen.getByRole('button', { name: 'Publish this version to guests' })
    fireEvent.click(button)
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    fireEvent.click(button)
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2))
    expect(mocks.publish.mock.calls[0]?.[0].requestId).toBe(
      mocks.publish.mock.calls[1]?.[0].requestId,
    )
  })
})
