import { describe, expect, it, vi } from 'vitest'
import {
  assertSavedGuideSelection,
  bindNativeWriterAssessment,
  resolveSelectedWritingReference,
  selectedWritingGuideCurrent,
  viewOrImmutableImportReceipt,
} from './prospect-sales-workflow'
import type { SalesWorkflowView } from './prospect-sales-contract'
import { salesPrepareInput } from './prospect-sales-contract'
import { ProspectSalesError } from '@pathfinder/db'
import { TORCHIKO_SAVED_WRITING_GUIDE_SOURCE } from '@pathfinder/config/local-crm-sales-components'

const receipt = {
  id: 'writer-import-old',
  evidence: {
    draftId: 'draft-old',
    meaningReviewId: 'meaning-old',
  },
}

describe('immutable import response after uncertain HTTP outcome', () => {
  it('returns historical receipt without pretending a current CRM projection exists', async () => {
    const result = await viewOrImmutableImportReceipt(
      'SYN-venue',
      'a'.repeat(64),
      receipt,
      true,
      async () => {
        throw new Error('current source exceeds bounded view')
      },
    )
    expect(result).toEqual({
      schema: 'torchiko.native-writer-import-receipt-only/1',
      venueId: 'SYN-venue',
      originalSnapshotHash: 'a'.repeat(64),
      writerImportReceipt: {
        id: receipt.id,
        draftId: 'draft-old',
        meaningReviewId: 'meaning-old',
        replayed: true,
      },
      currentViewAvailable: false,
      currentViewFailure: 'READ_FAILED',
      SEND_AUTHORIZED: false,
      senderAvailable: false,
    })
    expect('snapshotHash' in result).toBe(false)
  })
  it('labels a fresh committed import distinctly from a replay when current view loads', async () => {
    const current = {
      venueId: 'SYN-venue',
      snapshotHash: 'b'.repeat(64),
      SEND_AUTHORIZED: false,
      senderAvailable: false,
    } as SalesWorkflowView
    const result = await viewOrImmutableImportReceipt(
      'SYN-venue',
      'a'.repeat(64),
      receipt,
      false,
      async () => current,
    )
    expect(result).toMatchObject({
      snapshotHash: 'b'.repeat(64),
      writerImportReceipt: { id: receipt.id, replayed: false },
    })
  })
  it('does not turn a malformed immutable receipt into a successful recovery', async () => {
    await expect(
      viewOrImmutableImportReceipt(
        'SYN-venue',
        'a'.repeat(64),
        { id: 'writer-import-broken', evidence: { draftId: '' } },
        true,
        async () => {
          throw new Error('current view unavailable')
        },
      ),
    ).rejects.toThrow('WRITER_RECEIPT_INCOMPLETE')
  })
  it.each([
    ['NOT_FOUND', 'RECORD_NOT_FOUND'],
    ['CONFLICT', 'STATE_CONFLICT'],
    ['FORBIDDEN', 'ACCESS_OR_POLICY_HOLD'],
    ['SUPPRESSED', 'ACCESS_OR_POLICY_HOLD'],
  ] as const)(
    'preserves the receipt while identifying a current %s failure',
    async (code, expected) => {
      const result = await viewOrImmutableImportReceipt(
        'SYN-venue',
        'a'.repeat(64),
        receipt,
        true,
        async () => {
          throw new ProspectSalesError(code, 'Private source detail must not leak')
        },
      )
      expect(result).toMatchObject({
        currentViewFailure: expected,
        currentViewAvailable: false,
        writerImportReceipt: { id: receipt.id },
      })
      expect(JSON.stringify(result)).not.toContain('Private source detail')
      expect('snapshotHash' in result).toBe(false)
    },
  )
})

describe('selected reply thread during imported assessment', () => {
  it('runs the actual import assessment binding against the exact selected thread', async () => {
    const run = vi.fn(async () => ({ SEND_AUTHORIZED: false }))
    const assess = bindNativeWriterAssessment(
      'native-thread-selected',
      'authenticated-admin',
      run as never,
    )
    const native = {
      snapshotHash: 'a'.repeat(64),
      threads: [{ id: 'native-thread-unrelated' }, { id: 'native-thread-selected' }],
    } as never
    const review = { bindingHash: 'b'.repeat(64) }
    await assess({
      native,
      draft: { subject: 'Re: One room', body: 'We can discuss one room.' },
      review,
      answerText: 'Discuss one room',
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'meaning',
        selectedThreadId: 'native-thread-selected',
        native,
        review,
      }),
      'authenticated-admin',
    )
  })
})

describe('explicit authenticated saved-guide composition', () => {
  const current = {
    label: 'Torchiko sales writing reference v0.2',
    sourceRef: TORCHIKO_SAVED_WRITING_GUIDE_SOURCE,
    text: 'Exact owner-selected guidance',
    sha256: 'a'.repeat(64),
  }
  const selected = salesPrepareInput.parse({
    venueId: 'venue',
    expectedSnapshotHash: 'b'.repeat(64),
    savedWritingGuide: 'torchiko-v0.2',
    expectedWritingGuideSha256: current.sha256,
  })
  it('binds only the expected exact guide after explicit selection', async () => {
    const read = vi.fn(async () => current)
    expect(await resolveSelectedWritingReference(selected, 'authenticated-admin', read)).toEqual(
      current,
    )
    expect(read).toHaveBeenCalledTimes(1)
    await expect(
      resolveSelectedWritingReference(
        { ...selected, expectedWritingGuideSha256: 'c'.repeat(64) },
        'authenticated-admin',
        read,
      ),
    ).rejects.toThrow('STALE_SELECTED_WRITING_GUIDE')
  })
  it('rejects fixture use, ambiguous references and a hash without selection', () => {
    expect(() => assertSavedGuideSelection(selected, 'local')).toThrow('authenticated route')
    expect(() =>
      assertSavedGuideSelection({ ...selected, writingReference: current }, 'authenticated-admin'),
    ).toThrow('either')
    expect(() =>
      assertSavedGuideSelection(
        salesPrepareInput.parse({
          venueId: 'venue',
          expectedSnapshotHash: 'b'.repeat(64),
          writingReference: current,
        }),
        'authenticated-admin',
      ),
    ).toThrow('either')
    expect(() =>
      assertSavedGuideSelection(
        salesPrepareInput.parse({
          venueId: 'venue',
          expectedSnapshotHash: 'b'.repeat(64),
          expectedWritingGuideSha256: current.sha256,
        }),
        'authenticated-admin',
      ),
    ).toThrow('either')
  })
  it('marks only the named saved guide stale when its current bytes change or vanish', async () => {
    expect(
      await selectedWritingGuideCurrent(current, 'authenticated-admin', async () => ({
        ...current,
        sha256: 'd'.repeat(64),
      })),
    ).toBe(false)
    expect(
      await selectedWritingGuideCurrent(current, 'authenticated-admin', async () => {
        throw new Error('private source path')
      }),
    ).toBe(false)
    expect(
      await selectedWritingGuideCurrent(
        { ...current, sourceRef: 'explicit-owner-reference' },
        'authenticated-admin',
        async () => {
          throw new Error('not called')
        },
      ),
    ).toBe(true)
  })
  it('also checks the named local guide without granting authenticated or send authority', async () => {
    expect(await selectedWritingGuideCurrent(current, 'local', async () => current)).toBe(true)
    expect(
      await selectedWritingGuideCurrent(current, 'local', async () => ({
        ...current,
        sha256: 'e'.repeat(64),
      })),
    ).toBe(false)
    expect(
      await selectedWritingGuideCurrent(current, 'local', async () => {
        throw new Error('owner unavailable')
      }),
    ).toBe(false)
    expect(
      await selectedWritingGuideCurrent(
        { ...current, sourceRef: 'explicit-inline' },
        'local',
        async () => {
          throw new Error('not called')
        },
      ),
    ).toBe(true)
  })
})
