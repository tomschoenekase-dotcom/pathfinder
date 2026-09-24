/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SalesActionResponse,
  SalesWorkflowView,
} from '@pathfinder/api/prospect-sales-contract'
import { ProspectSalesReviewPanel } from './ProspectSalesReviewPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

function view(): SalesWorkflowView {
  return {
    venueId: 'venue',
    organizationId: 'org',
    name: 'Synthetic fixture',
    snapshotHash: 'a'.repeat(64),
    sourceCount: 1,
    sourceState: 'EXACT_NATIVE_SOURCE_CROSSWALK',
    contacts: [
      {
        id: 'candidate',
        name: null,
        email: 'candidate@example.invalid',
        readiness: 'UNKNOWN',
        permission: 'UNKNOWN',
      },
    ],
    gate: {
      decision: 'ENOUGH_EVIDENCE',
      canPrepare: true,
      questions: [],
      humanQuestions: [],
      notices: [],
    },
    routing: {
      kind: 'email',
      value: 'candidate@example.invalid',
      publicSnapshotStatus: 'SNAPSHOT_ONLY',
      nativeContactId: 'candidate',
      readiness: 'UNKNOWN',
      permission: 'UNKNOWN',
    },
    suppression: { blocked: false, reasons: [] },
    outreachState: 'PREPARATION_READY',
    correspondenceState: 'NO_THREAD',
    correspondence: null,
    threadCandidates: [],
    preparation: {
      id: 'prep',
      stale: false,
      why: 'Explore a small guide idea without commitments',
      expectedDraftId: null,
      writerMarkdown: 'Bounded source-backed writing context',
      approvedCount: 0,
      selectedCount: 0,
      wltIdentity: 'wlt-hash',
    },
    draft: null,
    revisions: [],
    blocker: null,
    SEND_AUTHORIZED: false,
    senderAvailable: false,
  }
}
function mount(value = view()) {
  const transport = {
    load: vi.fn().mockResolvedValue(value),
    act: vi.fn().mockResolvedValue(value),
  }
  const rendered = render(<ProspectSalesReviewPanel venueId="venue" transport={transport} local />)
  return { transport, ...rendered }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
async function chooseWriterResult() {
  const hash = 'a'.repeat(64)
  const result = {
    schema: 'torchiko.native-writer-result/1',
    taskId: `writer-task_${hash}`,
    binding: {
      venueId: 'venue',
      organizationId: 'org',
      preparationId: 'prep',
      nativeSnapshotHash: hash,
      preparationHash: hash,
      componentCodeHash: hash,
      fileSetHash: hash,
      selectionId: null,
      routeHash: hash,
      routeKind: 'email',
      recipient: 'candidate@example.invalid',
      formUrl: null,
      threadHash: hash,
      libraryHash: hash,
      wltHash: hash,
      expectedDraftId: null,
      expectedVenueDraftId: null,
      expectedMeaningReviewId: null,
      expectedReadReviewId: null,
    },
    generatedBy: { kind: 'model', identity: 'Synthetic UI model' },
    subject: 'Hello',
    body: 'Hello',
    annotations: ['subject', 'body'].map((section) => ({
      annotation_id: section,
      section,
      start: 0,
      end: 5,
      quote: 'Hello',
      category: 'NONFACTUAL',
      claim_ids: [],
      reason: 'Ordinary greeting only',
      answers: [],
    })),
    languageUses: [],
    assessment: null,
  }
  fireEvent.change(screen.getByLabelText('AI result JSON file'), {
    target: { files: [{ size: 1500, text: async () => JSON.stringify(result) }] },
  })
  return screen.findByRole('button', { name: 'Import exact AI candidate' })
}
describe('compact native preparation and review UX', () => {
  it('selects the complete saved guide only on an explicit action and binds its displayed hash', async () => {
    const current = view()
    const transport = {
      load: vi.fn().mockResolvedValue(current),
      act: vi.fn().mockResolvedValue(current),
    }
    const savedGuide = { state: 'available', sha256: 'b'.repeat(64) }
    render(
      <ProspectSalesReviewPanel venueId="venue" transport={transport} savedGuide={savedGuide} />,
    )
    const prepare = await screen.findByRole('button', { name: 'Prepare with saved Torchiko guide' })
    expect(transport.act).not.toHaveBeenCalled()
    fireEvent.click(prepare)
    await waitFor(() =>
      expect(transport.act).toHaveBeenCalledWith({
        action: 'prepare',
        input: {
          venueId: 'venue',
          expectedSnapshotHash: current.snapshotHash,
          savedWritingGuide: 'torchiko-v0.2',
          expectedWritingGuideSha256: savedGuide.sha256,
        },
      }),
    )
  })

  it('reuses a named guide preparation through its exact prior hash without resending private text', async () => {
    const current = view()
    current.preparation!.writingReference = {
      label: 'Saved guide',
      sourceRef: 'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md',
      sha256: 'c'.repeat(64),
      text: 'Private guide text',
    }
    const transport = {
      load: vi.fn().mockResolvedValue(current),
      act: vi.fn().mockResolvedValue(current),
    }
    render(
      <ProspectSalesReviewPanel
        venueId="venue"
        transport={transport}
        savedGuide={{ state: 'available', sha256: 'd'.repeat(64) }}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare writing context' }))
    await waitFor(() =>
      expect(transport.act).toHaveBeenCalledWith({
        action: 'prepare',
        input: {
          venueId: 'venue',
          expectedSnapshotHash: current.snapshotHash,
          savedWritingGuide: 'torchiko-v0.2',
          expectedWritingGuideSha256: 'c'.repeat(64),
        },
      }),
    )
    expect(JSON.stringify(transport.act.mock.calls)).not.toContain('Private guide text')
  })

  it('retains the previous preparation when the selected guide changed and does not retry automatically', async () => {
    const current = view()
    const transport = {
      load: vi.fn().mockResolvedValue(current),
      act: vi.fn().mockRejectedValue(new Error('Saved writing guide changed; refresh readiness.')),
    }
    render(
      <ProspectSalesReviewPanel
        venueId="venue"
        transport={transport}
        savedGuide={{ state: 'available', sha256: 'b'.repeat(64) }}
      />,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Prepare with saved Torchiko guide' }),
    )
    expect(await screen.findByText(/Saved writing guide changed; refresh readiness\./)).toBeTruthy()
    expect(screen.getByText(/Native preparation: prep/)).toBeTruthy()
    expect(transport.act).toHaveBeenCalledTimes(1)
  })

  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  afterEach(cleanup)
  it('shows actual unknown routing, zero approved language and no sender', async () => {
    mount()
    expect(await screen.findByText('ENOUGH EVIDENCE')).toBeTruthy()
    expect(screen.getByText('UNKNOWN / UNKNOWN')).toBeTruthy()
    expect(screen.getByText(/Approved Language: 0 active, 0 selected/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^send/i })).toBeNull()
    expect(screen.getByText('No sender is available in this workflow.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save review revision' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('saves exact editor bytes with the current native/source/revision identities', async () => {
    const { transport } = mount()
    await screen.findByText('ENOUGH EVIDENCE')
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Subject' } })
    fireEvent.change(screen.getByLabelText('Message body'), {
      target: { value: 'Exact body\n\nThanks' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save review revision' }))
    await waitFor(() =>
      expect(transport.act).toHaveBeenCalledWith({
        action: 'save',
        input: {
          venueId: 'venue',
          preparationId: 'prep',
          expectedSnapshotHash: 'a'.repeat(64),
          expectedDraftId: null,
          subject: 'Subject',
          body: 'Exact body\n\nThanks',
        },
      }),
    )
  })
  it('does not review unsaved text or relabel a prior revision under a new context', async () => {
    const initial = view()
    initial.draft = {
      id: 'draft',
      version: 1,
      subject: 'Subject',
      body: 'Existing body',
      contentHash: 'b'.repeat(64),
      state: 'DRAFT_REVIEW',
      preparationId: 'prep',
      previousDraftId: null,
      warnings: [],
    }
    mount(initial)
    await screen.findByText('ENOUGH EVIDENCE')
    const review = screen.getByRole('button', {
      name: 'Mark exact revision reviewed',
    }) as HTMLButtonElement
    expect(review.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'Changed body' } })
    expect(review.disabled).toBe(true)
    expect(screen.getByText(/editor does not match/)).toBeTruthy()
  })
  it('keeps native holds visibly above any preparation action', async () => {
    const initial = view()
    initial.suppression = { blocked: true, reasons: ['Native candidate is suppressed'] }
    initial.gate = { ...initial.gate, decision: 'HUMAN_INPUT_REQUIRED', canPrepare: false }
    const { transport } = mount(initial)
    await screen.findByText('Held / suppressed — preparation blocked')
    for (const name of [
      'Prepare writing context',
      'Save review revision',
      'Mark exact revision reviewed',
    ])
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    expect(transport.act).not.toHaveBeenCalled()
  })
  it('shows exact bounded research questions without a crawl button', async () => {
    const initial = view()
    initial.preparation = null
    initial.gate = {
      decision: 'RESEARCH_REQUIRED',
      canPrepare: false,
      questions: [
        {
          id: 'q1',
          question: 'Which official contact route is appropriate for this venue?',
          why: 'The candidate is unverified.',
        },
      ],
      humanQuestions: [],
      notices: [],
    }
    mount(initial)
    expect(
      await screen.findByText('Which official contact route is appropriate for this venue?'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /crawl|research now/i })).toBeNull()
  })
  it('labels synthetic inbound and requires an intended answer before reply preparation', async () => {
    const initial = view()
    initial.correspondence = {
      threadId: 'SYN-thread',
      relationship: 'asked_question',
      action: 'PREPARE_REPLY',
      synthetic: true,
      latestInbound: {
        id: 'SYN-in',
        subject: 'A guide idea',
        body: 'Could we start with one room?',
      },
      points: [],
      issues: [],
    }
    const { transport } = mount(initial)
    await screen.findByText('SYNTHETIC correspondence. No venue sent these fixture messages.')
    const prepare = screen.getByRole('button', {
      name: 'Prepare writing context',
    }) as HTMLButtonElement
    expect(prepare.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Intended response to the latest inbound point/), {
      target: { value: 'We could discuss one room, using the material the venue chooses.' },
    })
    fireEvent.click(prepare)
    await waitFor(() =>
      expect(transport.act).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'prepare',
          input: expect.objectContaining({ answerText: expect.stringContaining('one room') }),
        }),
      ),
    )
  })
  it('keeps an answer only for its current venue and conversation scope', async () => {
    const first = view()
    first.venueId = 'a'
    first.correspondence = {
      threadId: 'thread',
      relationship: 'asked_question',
      action: 'PREPARE_REPLY',
      synthetic: true,
      latestInbound: { id: 'inbound', subject: 'Question', body: 'Could this work?' },
      points: [],
      issues: [],
    }
    const second = { ...first, venueId: 'b' }
    const transport = {
      load: vi.fn((venueId: string) => Promise.resolve(venueId === 'a' ? first : second)),
      act: vi.fn(),
    }
    const rendered = render(<ProspectSalesReviewPanel venueId="a" transport={transport} local />)
    const answer = await screen.findByLabelText(/Intended response to the latest inbound point/)
    fireEvent.change(answer, { target: { value: 'This response is only for the first venue.' } })

    fireEvent.click(screen.getByRole('button', { name: 'Reload native state' }))
    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(2))
    expect(
      (
        screen.getByLabelText(
          /Intended response to the latest inbound point/,
        ) as HTMLTextAreaElement
      ).value,
    ).toContain('only for the first venue')

    rendered.rerender(<ProspectSalesReviewPanel venueId="b" transport={transport} local />)
    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(3))
    expect(
      (
        screen.getByLabelText(
          /Intended response to the latest inbound point/,
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('')
  })
  it('keeps stale snapshot conflicts visible and provides a real reload action', async () => {
    const { transport } = mount()
    await screen.findByText('ENOUGH EVIDENCE')
    transport.act.mockRejectedValue(new Error('STALE_NATIVE_SNAPSHOT'))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare writing context' }))
    expect((await screen.findByRole('alert')).textContent).toContain('STALE_NATIVE_SNAPSHOT')
    fireEvent.click(screen.getByRole('button', { name: 'Reload native state' }))
    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(2))
  })
  it('labels the bounded fresh-state reason when an import receipt is the only available evidence', async () => {
    const { transport } = mount()
    await screen.findByText('ENOUGH EVIDENCE')
    transport.act.mockResolvedValueOnce({
      schema: 'torchiko.native-writer-import-receipt-only/1',
      venueId: 'venue',
      originalSnapshotHash: 'a'.repeat(64),
      writerImportReceipt: {
        id: 'receipt',
        draftId: 'draft',
        meaningReviewId: null,
        replayed: false,
      },
      currentViewAvailable: false,
      currentViewFailure: 'STATE_CONFLICT',
      SEND_AUTHORIZED: false,
      senderAvailable: false,
    } satisfies SalesActionResponse)

    fireEvent.click(await chooseWriterResult())
    expect(
      await screen.findByText(/The current CRM state changed or conflicts with this result/),
    ).toBeTruthy()
    expect(screen.getByText(/AI result was saved as receipt/)).toBeTruthy()
  })
  it('keeps an exact result retryable when a nominally successful import lacks its receipt', async () => {
    const { transport } = mount()
    await screen.findByText('ENOUGH EVIDENCE')
    fireEvent.click(await chooseWriterResult())
    expect((await screen.findByRole('alert')).textContent).toContain('immutable draft receipt')
    expect(screen.queryByText(/Exact result receipt confirmed/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Import exact AI candidate' })).toBeTruthy()
    expect(transport.act).toHaveBeenCalledTimes(1)
  })
  it('requires an explicit temporary, tab-only recovery choice before overwriting unsaved editor text', async () => {
    const { transport } = mount()
    await screen.findByText('ENOUGH EVIDENCE')
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Unsaved subject' } })
    fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'Unsaved body' } })

    expect(window.sessionStorage.length).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Reload native state' }))
    expect(await screen.findByText('Unsaved subject or message body detected.')).toBeTruthy()
    expect(transport.load).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.length).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Keep temporary recovery and reload' }))
    await waitFor(() => expect(transport.load).toHaveBeenCalledTimes(2))
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(1)
    expect(await screen.findByText('An unsaved temporary copy is available.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore temporary copy' }))
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Unsaved subject')
    expect((screen.getByLabelText('Message body') as HTMLTextAreaElement).value).toBe(
      'Unsaved body',
    )
    expect(window.sessionStorage.length).toBe(0)
  })
  it('warns before browser navigation without silently copying CRM text', async () => {
    mount()
    await screen.findByText('ENOUGH EVIDENCE')
    fireEvent.change(screen.getByLabelText('Message body'), { target: { value: 'Still unsaved' } })

    const beforeUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeUnload)
    expect(beforeUnload.defaultPrevented).toBe(true)
    expect(window.sessionStorage.length).toBe(0)
  })
  it('ignores a delayed load for venue A after the operator switches to venue B', async () => {
    const delayedA = deferred<SalesWorkflowView>()
    const first = view()
    first.venueId = 'a'
    first.preparation!.why = 'A-only preparation'
    const second = view()
    second.venueId = 'b'
    second.preparation!.why = 'B-only preparation'
    const transport = {
      load: vi.fn((venueId: string) =>
        venueId === 'a' ? delayedA.promise : Promise.resolve(second),
      ),
      act: vi.fn(),
    }
    const rendered = render(<ProspectSalesReviewPanel venueId="a" transport={transport} local />)
    await waitFor(() => expect(transport.load).toHaveBeenCalledWith('a'))

    rendered.rerender(<ProspectSalesReviewPanel venueId="b" transport={transport} local />)
    expect(await screen.findByText(/B-only preparation/)).toBeTruthy()
    delayedA.resolve(first)
    await Promise.resolve()

    expect(screen.getByText(/B-only preparation/)).toBeTruthy()
    expect(screen.queryByText(/A-only preparation/)).toBeNull()
  })
  it('does not submit old venue identities while the next venue is still loading', async () => {
    const delayedB = deferred<SalesWorkflowView>()
    const first = view()
    first.venueId = 'a'
    const second = view()
    second.venueId = 'b'
    const transport = {
      load: vi.fn((venueId: string) =>
        venueId === 'a' ? Promise.resolve(first) : delayedB.promise,
      ),
      act: vi.fn(),
    }
    const rendered = render(<ProspectSalesReviewPanel venueId="a" transport={transport} local />)
    expect(await screen.findByText('ENOUGH EVIDENCE')).toBeTruthy()

    rendered.rerender(<ProspectSalesReviewPanel venueId="b" transport={transport} local />)
    const prepare = screen.getByRole('button', {
      name: 'Prepare writing context',
    }) as HTMLButtonElement
    expect(prepare.disabled).toBe(true)
    fireEvent.click(prepare)
    expect(transport.act).not.toHaveBeenCalled()

    delayedB.resolve(second)
    await waitFor(() => expect(prepare.disabled).toBe(false))
  })
  it('ignores a delayed action response for venue A after switching to venue B', async () => {
    const delayedAction = deferred<SalesWorkflowView>()
    const first = view()
    first.venueId = 'a'
    first.preparation!.why = 'A-only preparation'
    const second = view()
    second.venueId = 'b'
    second.preparation!.why = 'B-only preparation'
    const transport = {
      load: vi.fn((venueId: string) => Promise.resolve(venueId === 'a' ? first : second)),
      act: vi.fn(() => delayedAction.promise),
    }
    const rendered = render(<ProspectSalesReviewPanel venueId="a" transport={transport} local />)
    expect(await screen.findByText(/A-only preparation/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Prepare writing context' }))
    await waitFor(() => expect(transport.act).toHaveBeenCalledTimes(1))
    rendered.rerender(<ProspectSalesReviewPanel venueId="b" transport={transport} local />)
    expect(await screen.findByText(/B-only preparation/)).toBeTruthy()
    delayedAction.resolve(first)
    await Promise.resolve()

    expect(screen.getByText(/B-only preparation/)).toBeTruthy()
    expect(screen.queryByText(/A-only preparation/)).toBeNull()
  })
  it('never hydrates a previous venue from a delayed writer export', async () => {
    const delayedExport = deferred<SalesWorkflowView>()
    const first = view()
    first.venueId = 'a'
    first.preparation!.why = 'A export preparation'
    // Only the presence is needed to enable download; this task must never be exported.
    first.writerTask = { taskId: 'navigation-only-test' } as NonNullable<
      SalesWorkflowView['writerTask']
    >
    const second = view()
    second.venueId = 'b'
    second.preparation!.why = 'B current preparation'
    const transport = {
      load: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockReturnValueOnce(delayedExport.promise)
        .mockResolvedValueOnce(second),
      act: vi.fn(),
    }
    const page = render(<ProspectSalesReviewPanel venueId="a" transport={transport} local />)
    await screen.findByText(/A export preparation/)
    fireEvent.click(screen.getByRole('button', { name: 'Download current writer task' }))
    page.rerender(<ProspectSalesReviewPanel venueId="b" transport={transport} local />)
    await screen.findByText(/B current preparation/)
    await act(async () => {
      delayedExport.resolve(first)
    })
    expect(screen.getByText(/B current preparation/)).toBeTruthy()
    expect(screen.queryByText(/A export preparation/)).toBeNull()
  })
  it('has no automated accessibility violations in the ready surface', async () => {
    const { container } = mount()
    await screen.findByText('ENOUGH EVIDENCE')
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })
})
