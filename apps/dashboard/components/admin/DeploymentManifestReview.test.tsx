/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../lib/trpc', () => {
  const client = { admin: { reviewDeploymentManifest: { query: mocks.query } } }
  return { useTRPCClient: () => client }
})
import { DeploymentManifestReview } from './DeploymentManifestReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('DeploymentManifestReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
  })
  afterEach(cleanup)
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
})
