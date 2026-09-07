/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

import {
  MediaTemporalReviewPanel,
  type MediaTemporalReviewAdapter,
} from './MediaTemporalReviewPanel'

const claim = {
  claimId: 'hours',
  targetKey: 'entrance:hours',
  targetItemHash: 'a'.repeat(64),
  claimType: 'TEMPORARY_SCHEDULE' as const,
  value: 'Open until six',
  valueHash: 'b'.repeat(64),
  authority: 'AUTHORIZED_STAFF' as const,
  consequential: true,
  effectiveFrom: '2026-09-07T00:00:00.000Z',
  effectiveUntil: '2026-09-08T00:00:00.000Z',
  source: {
    sourceId: 'schedule',
    sourceSha256: 'c'.repeat(64),
    sourceVersion: '11111111-1111-4111-8111-111111111111',
    capturedAt: null,
    observationIndex: 0,
    observationSha256: 'd'.repeat(64),
  },
}
const props = {
  scope: { tenantId: 'tenant', venueId: 'venue', projectId: 'project' },
  sourceGeneration: '11111111-1111-4111-8111-111111111111',
  expectedUpdatedAt: '2026-09-07T10:00:00.000Z',
  rationale: 'Every item has date-bound evidence.',
  claims: [claim],
  bindings: [
    { kind: 'knowledge' as const, itemIndex: 0, itemHash: 'a'.repeat(64), sourceIds: ['schedule'] },
  ],
  allHeld: true,
  blocked: false,
}
afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('compact temporal review receipt panel', () => {
  it('retries one retained UUID, reads bounded evidence, and creates an optional local question', async () => {
    const seen: Array<{ requestId: string; rationale: string }> = []
    const adapter: MediaTemporalReviewAdapter = {
      retain: vi.fn(async (input) => {
        seen.push({ requestId: input.requestId, rationale: input.rationale })
        if (seen.length === 1) throw new Error('acknowledgement lost')
        return {
          receiptId: '22222222-2222-4222-8222-222222222222',
          snapshotHash: 'e'.repeat(64),
          requestHash: 'f'.repeat(64),
          heldItems: [{ itemHash: 'a'.repeat(64), reasons: ['DATE_BOUND'] }],
          replayed: true,
        }
      }),
      readEvidence: vi.fn(async () => ({
        receiptId: '22222222-2222-4222-8222-222222222222',
        snapshotHash: 'e'.repeat(64),
        requestHash: 'f'.repeat(64),
        text: '{"kind":"MEDIA_TEMPORAL_REVIEW"}',
        offset: 0,
        nextOffset: null,
        totalCodeUnits: 32,
      })),
      clarify: vi.fn(async () => ({ questionId: 'question-1', replayed: false })),
    }
    const view = render(<MediaTemporalReviewPanel {...props} adapter={adapter} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retain evidence receipt' }))
    await screen.findByRole('alert')
    view.rerender(
      <MediaTemporalReviewPanel {...props} rationale="Edited after timeout" adapter={adapter} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry same evidence receipt' }))
    await screen.findByText('Read retained evidence')
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
    expect(screen.getByText('f'.repeat(64))).toBeTruthy()
    expect(screen.getByText('e'.repeat(64))).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Optional scoped Content identity'), {
      target: { value: 'content-agent' },
    })
    fireEvent.change(screen.getByLabelText('Held target to clarify'), {
      target: { value: 'entrance:hours' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create local clarification' }))
    await screen.findByText(/Local question created:/u)
    expect(adapter.clarify).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIdentityId: 'content-agent',
        targetKey: 'entrance:hours',
        expectedRequestHash: 'f'.repeat(64),
      }),
      expect.any(AbortSignal),
    )
  })

  it('requires a deliberate held target and pages evidence with exact receipt identity', async () => {
    const secondClaim = {
      ...claim,
      claimId: 'access',
      targetKey: 'entrance:access',
      targetItemHash: '9'.repeat(64),
    }
    const readEvidence = vi.fn(async ({ offset }: { offset: number }) => ({
      receiptId: '22222222-2222-4222-8222-222222222222',
      snapshotHash: 'e'.repeat(64),
      requestHash: 'f'.repeat(64),
      text: offset === 0 ? 'page one' : 'page two',
      offset,
      nextOffset: offset === 0 ? 8 : null,
      totalCodeUnits: 16,
    }))
    const adapter = {
      retain: vi.fn(async () => ({
        receiptId: '22222222-2222-4222-8222-222222222222',
        snapshotHash: 'e'.repeat(64),
        requestHash: 'f'.repeat(64),
        heldItems: [
          { itemHash: 'a'.repeat(64), reasons: ['DATE_BOUND'] },
          { itemHash: '9'.repeat(64), reasons: ['CONFLICT'] },
        ],
        replayed: false,
      })),
      readEvidence,
      clarify: vi.fn(async () => ({ questionId: 'question-2', replayed: false })),
    } as MediaTemporalReviewAdapter
    render(
      <MediaTemporalReviewPanel
        {...props}
        claims={[claim, secondClaim]}
        bindings={[
          ...props.bindings,
          { kind: 'place', itemIndex: 0, itemHash: '9'.repeat(64), sourceIds: ['schedule'] },
        ]}
        adapter={adapter}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retain evidence receipt' }))
    await screen.findByText('page one')
    expect(screen.getByRole('button', { name: 'Create local clarification' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Create local clarification' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next evidence' }))
    await screen.findByText('page two')
    fireEvent.click(screen.getByRole('button', { name: 'Previous evidence' }))
    await screen.findByText('page one')
    expect(readEvidence.mock.calls.map(([input]) => input.offset)).toEqual([0, 8, 0])
  })

  it('stays absent for a partial review and disables retention without a review note', () => {
    const adapter = {
      retain: vi.fn(),
      readEvidence: vi.fn(),
    } as unknown as MediaTemporalReviewAdapter
    const { rerender } = render(
      <MediaTemporalReviewPanel {...props} allHeld={false} adapter={adapter} />,
    )
    expect(screen.queryByText('Retain this held review')).toBeNull()
    rerender(<MediaTemporalReviewPanel {...props} rationale="" adapter={adapter} />)
    expect(
      (screen.getByRole('button', { name: 'Retain evidence receipt' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('ignores a delayed receipt acknowledgement after a synchronous scope change', async () => {
    const pending = deferred<Awaited<ReturnType<MediaTemporalReviewAdapter['retain']>>>()
    const adapter = {
      retain: vi.fn(() => pending.promise),
      readEvidence: vi.fn(),
    } as unknown as MediaTemporalReviewAdapter
    const view = render(<MediaTemporalReviewPanel {...props} adapter={adapter} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retain evidence receipt' }))
    view.rerender(
      <MediaTemporalReviewPanel
        {...props}
        scope={{ ...props.scope, projectId: 'other-project' }}
        adapter={adapter}
      />,
    )
    pending.resolve({
      receiptId: '22222222-2222-4222-8222-222222222222',
      snapshotHash: 'e'.repeat(64),
      requestHash: 'f'.repeat(64),
      heldItems: [{ itemHash: 'a'.repeat(64), reasons: ['DATE_BOUND'] }],
      replayed: false,
    })
    await Promise.resolve()
    expect(screen.queryByText('22222222-2222-4222-8222-222222222222')).toBeNull()
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Retain evidence receipt',
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(false)
  })

  it('clones nested claims and bindings before an unknown-ack retry', async () => {
    const retained: unknown[] = []
    const mutableClaims = [{ ...claim, source: { ...claim.source } }]
    const mutableBindings = props.bindings.map((binding) => ({
      ...binding,
      sourceIds: [...binding.sourceIds],
    }))
    const adapter = {
      retain: vi.fn(async (input) => {
        retained.push(structuredClone(input))
        throw new Error('unknown acknowledgement')
      }),
      readEvidence: vi.fn(),
    } as unknown as MediaTemporalReviewAdapter
    const view = render(
      <MediaTemporalReviewPanel
        {...props}
        claims={mutableClaims}
        bindings={mutableBindings}
        adapter={adapter}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retain evidence receipt' }))
    await screen.findByRole('alert')
    mutableClaims[0]!.value = 'Mutated caller value'
    mutableBindings[0]!.sourceIds[0] = 'mutated-source'
    view.rerender(
      <MediaTemporalReviewPanel
        {...props}
        claims={mutableClaims}
        bindings={mutableBindings}
        adapter={adapter}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry same evidence receipt' }))
    await screen.findByRole('alert')
    expect(retained).toHaveLength(2)
    expect(retained[1]).toEqual(retained[0])
  })

  it('keeps a confirmed receipt when initial evidence readback fails and retries only the read', async () => {
    let reads = 0
    const adapter = {
      retain: vi.fn(async () => ({
        receiptId: '22222222-2222-4222-8222-222222222222',
        snapshotHash: 'e'.repeat(64),
        requestHash: 'f'.repeat(64),
        heldItems: [{ itemHash: 'a'.repeat(64), reasons: ['DATE_BOUND'] }],
        replayed: false,
      })),
      readEvidence: vi.fn(async () => {
        reads += 1
        if (reads === 1) throw new Error('temporary read failure')
        return {
          receiptId: '22222222-2222-4222-8222-222222222222',
          snapshotHash: 'e'.repeat(64),
          requestHash: 'f'.repeat(64),
          text: 'verified evidence',
          offset: 0,
          nextOffset: null,
          totalCodeUnits: 17,
        }
      }),
    } as MediaTemporalReviewAdapter
    render(<MediaTemporalReviewPanel {...props} adapter={adapter} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retain evidence receipt' }))
    await screen.findByText(
      'The receipt was saved, but its evidence page could not be read. Try readback again.',
    )
    expect(screen.getByText('22222222-2222-4222-8222-222222222222')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry evidence readback' }))
    await screen.findByText('verified evidence')
    expect(adapter.retain).toHaveBeenCalledTimes(1)
    expect(adapter.readEvidence).toHaveBeenCalledTimes(2)
  })
})
