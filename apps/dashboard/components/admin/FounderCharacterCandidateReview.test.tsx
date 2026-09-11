/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FounderCharacterCandidateReview,
  type FounderCharacterCandidate,
} from './FounderCharacterCandidateReview'

afterEach(cleanup)

const candidate: FounderCharacterCandidate = {
  id: 'brief-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  characterId: 'char-1',
  displayName: 'Neutral guide',
  version: 2,
  revision: 3,
  artifactFingerprint: 'a'.repeat(64),
  brief: 'A calm visitor guide.',
  rationale: 'Keeps the silhouette readable at small sizes.',
  provenance: 'Imported neutral source · verified artifact',
  previewHref: `/api/admin/character-candidate-preview?tenantId=tenant-1&venueId=venue-1&briefId=brief-1&expectedVersion=2&expectedRevision=3&expectedArtifactFingerprint=${'a'.repeat(64)}`,
  current: true,
}

describe('FounderCharacterCandidateReview', () => {
  it('does not conflate scope identifiers containing separators', () => {
    const scoped = (id: string, tenantId: string) => ({
      ...candidate,
      id,
      tenantId,
      previewHref: `/api/admin/character-candidate-preview?${new URLSearchParams({
        tenantId,
        venueId: candidate.venueId,
        briefId: id,
        expectedVersion: String(candidate.version),
        expectedRevision: String(candidate.revision),
        expectedArtifactFingerprint: candidate.artifactFingerprint,
      })}`,
    })
    const onDecision = vi.fn()
    const view = render(
      <FounderCharacterCandidateReview
        candidates={[scoped('brief:a', 'tenant')]}
        onDecision={onDecision}
      />,
    )
    fireEvent.load(screen.getByRole('img'))
    expect(screen.getByRole('button', { name: 'Accept candidate' }).hasAttribute('disabled')).toBe(
      false,
    )
    view.rerender(
      <FounderCharacterCandidateReview
        candidates={[scoped('brief', 'a:tenant')]}
        onDecision={onDecision}
      />,
    )
    expect(screen.getByRole('button', { name: 'Accept candidate' }).hasAttribute('disabled')).toBe(
      true,
    )
  })
  it('keeps accept unavailable until the same-origin preview loads and sends the exact snapshot', async () => {
    const onDecision = vi.fn().mockResolvedValue({ decision: 'ACCEPT', jobId: 'job-1' })
    render(<FounderCharacterCandidateReview candidates={[candidate]} onDecision={onDecision} />)
    expect(screen.getByRole('button', { name: 'Accept candidate' }).hasAttribute('disabled')).toBe(
      true,
    )
    fireEvent.load(screen.getByRole('img'))
    fireEvent.click(screen.getByRole('button', { name: 'Accept candidate' }))
    await waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          briefId: 'brief-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedVersion: 2,
          expectedRevision: 3,
          expectedArtifactFingerprint: 'a'.repeat(64),
          decision: 'ACCEPT',
          operationId: expect.any(String),
        }),
      ),
    )
  })

  it('rejects unsafe previews and requires revision text', async () => {
    const onDecision = vi.fn().mockResolvedValue({ decision: 'REJECT', jobId: null })
    render(
      <FounderCharacterCandidateReview
        candidates={[{ ...candidate, previewHref: 'https://evil.test/asset.svg' }]}
        onDecision={onDecision}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Request revision' }))
    expect(screen.getByRole('status').textContent).toContain('Describe the change')
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'REJECT' })),
    )
  })

  it('shows an empty state', () => {
    render(<FounderCharacterCandidateReview candidates={[]} onDecision={vi.fn()} />)
    expect(screen.getByText('No candidates are ready for founder review.')).toBeTruthy()
  })

  it('uses a new operation for changed decision payloads and disables stale candidates', async () => {
    const onDecision = vi
      .fn()
      .mockRejectedValueOnce(new Error('retry'))
      .mockRejectedValueOnce(new Error('retry again'))
      .mockResolvedValue({ decision: 'REVISE', jobId: null })
    const { rerender } = render(
      <FounderCharacterCandidateReview candidates={[candidate]} onDecision={onDecision} />,
    )
    fireEvent.load(screen.getByRole('img'))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Retry'))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(2))
    const firstCall = onDecision.mock.calls.at(0)
    const secondCall = onDecision.mock.calls.at(1)
    if (!firstCall || !secondCall) throw new Error('Expected two recorded decisions')
    const firstOperation = firstCall[0].operationId
    const secondOperation = secondCall[0].operationId
    expect(secondOperation).toBe(firstOperation)
    fireEvent.change(screen.getByLabelText(/Revision request/), {
      target: { value: 'Use softer eyes.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Request revision' }))
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(3))
    const thirdCall = onDecision.mock.calls.at(2)
    if (!thirdCall) throw new Error('Expected revised decision')
    expect(thirdCall[0].operationId).not.toBe(firstOperation)
    rerender(
      <FounderCharacterCandidateReview
        candidates={[{ ...candidate, current: false }]}
        onDecision={onDecision}
      />,
    )
    expect(screen.getByText('This candidate is stale. Refresh before deciding.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(true)
  })

  it('does not carry a loaded preview across an exact snapshot revision', () => {
    const onDecision = vi.fn().mockResolvedValue({ decision: 'ACCEPT', jobId: null })
    const { rerender } = render(
      <FounderCharacterCandidateReview candidates={[candidate]} onDecision={onDecision} />,
    )
    fireEvent.load(screen.getByRole('img'))
    expect(screen.getByRole('button', { name: 'Accept candidate' }).hasAttribute('disabled')).toBe(
      false,
    )
    const changed = {
      ...candidate,
      revision: candidate.revision + 1,
      artifactFingerprint: 'b'.repeat(64),
      previewHref: `/api/admin/character-candidate-preview?tenantId=tenant-1&venueId=venue-1&briefId=brief-1&expectedVersion=2&expectedRevision=4&expectedArtifactFingerprint=${'b'.repeat(64)}`,
    }
    rerender(<FounderCharacterCandidateReview candidates={[changed]} onDecision={onDecision} />)
    expect(screen.getByRole('button', { name: 'Accept candidate' }).hasAttribute('disabled')).toBe(
      true,
    )
    fireEvent.load(screen.getByRole('img'))
    expect(screen.getByRole('button', { name: 'Accept candidate' }).hasAttribute('disabled')).toBe(
      false,
    )
  })
})
