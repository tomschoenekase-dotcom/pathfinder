/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const calls = {
    latest: vi.fn(),
    get: vi.fn(),
    sources: vi.fn(),
    uploads: vi.fn(),
    submit: vi.fn(),
    amend: vi.fn(),
    prepare: vi.fn(),
    draftMounted: vi.fn(),
    draftUnmounted: vi.fn(),
    processing: vi.fn(),
    refresh: vi.fn(),
  }
  const client = {
    intake: {
      getLatestV1: { query: calls.latest },
      getV1: { query: calls.get },
      listV1Candidates: { query: calls.sources },
      listV1UploadCandidates: { query: calls.uploads },
      submitV1: { mutate: calls.submit },
      amendV1: { mutate: calls.amend },
    },
  }
  return { ...calls, client, currentClient: client }
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../lib/trpc', () => ({ useTRPCClient: () => mocks.currentClient }))
vi.mock('./IntakeProposalWorkspace', async () => {
  const ReactModule = await import('react')
  return {
    IntakeProposalWorkspace: ReactModule.forwardRef(
      (
        props: { suspendEditing?: boolean },
        ref: React.ForwardedRef<{ prepareV1Drafts(): Promise<unknown> }>,
      ) => {
        ReactModule.useImperativeHandle(ref, () => ({ prepareV1Drafts: mocks.prepare }))
        ReactModule.useEffect(() => {
          mocks.draftMounted()
          return () => mocks.draftUnmounted()
        }, [])
        return <div data-testid="drafts" data-suspended={String(Boolean(props.suspendEditing))} />
      },
    ),
  }
})
vi.mock('./IntakeV1ProcessingStatus', () => ({
  IntakeV1ProcessingStatus: (props: unknown) => {
    mocks.processing(props)
    return <div data-testid="processing-status" />
  },
}))

import { IntakeV1SubmissionWorkspace } from './IntakeV1SubmissionWorkspace'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const sourcePage = {
  items: [
    {
      id: 'run-1',
      displayName: 'Museum website',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      createdAt: new Date(),
    },
  ],
  nextCursor: null,
}
const uploadPage = {
  items: [
    {
      id: 'upload-1',
      displayName: 'Visitor guide.pdf',
      status: 'AWAITING_REVIEW',
      intakeRunId: null,
      createdAt: new Date(),
    },
  ],
  nextCursor: null,
}

function receipt(revision = 1): {
  id: string
  status: string
  revision: number
  revisionSemantics: string
  nextRevisionCursor: null
  revisions: Array<{
    revision: number
    manifestHash: string
    criticalMissing: never[]
    createdAt: Date
    members: Array<{
      ordinal: number
      kind: 'INTAKE_RUN' | 'INTAKE_UPLOAD'
      immutableHash: string
      intakeRunId: string | null
      intakeUploadId: string | null
      linkedIntakeRunId: string | null
      displayName: string | null
      sourceKind: string | null
    }>
  }>
} {
  return {
    id: 'submission-1',
    status: 'AWAITING_CANONICAL_REVIEW',
    revision,
    revisionSemantics: 'FULL_REPLACEMENT',
    nextRevisionCursor: null,
    revisions: [
      {
        revision,
        manifestHash: 'a'.repeat(64),
        criticalMissing: [],
        createdAt: new Date(),
        members: [
          {
            ordinal: 0,
            kind: 'INTAKE_RUN',
            immutableHash: 'b'.repeat(64),
            intakeRunId: 'prior-run',
            intakeUploadId: null,
            linkedIntakeRunId: null,
            displayName: 'Earlier staff answers',
            sourceKind: 'INTERVIEW',
          },
        ],
      },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('IntakeV1SubmissionWorkspace', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mocks.currentClient = mocks.client
    mocks.latest.mockResolvedValue(null)
    mocks.get.mockResolvedValue({
      ...receipt(),
      revisions: [{ ...receipt().revisions[0], members: [] }],
    })
    mocks.sources.mockResolvedValue(sourcePage)
    mocks.uploads.mockResolvedValue(uploadPage)
    mocks.prepare.mockResolvedValue([{ sourceKind: 'NOTES', expectedRevision: 7 }])
    mocks.submit.mockResolvedValue({
      submissionId: 'submission-1',
      revision: 1,
      status: 'AWAITING_CANONICAL_REVIEW',
      replayed: false,
      criticalMissing: [],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    vi.clearAllMocks()
  })

  it('freezes drafts, shared sources, and uploads into the exact first submission payload', async () => {
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    await screen.findByRole('heading', { name: 'Choose what goes into this version.' })
    expect(screen.getByTestId('drafts').dataset.suspended).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Submit this version' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({
      venueId: 'venue-1',
      selection: {
        partialAcknowledged: false,
        drafts: { NOTES: { include: true, expectedRevision: 7 } },
        intakeRunIds: ['run-1'],
        intakeUploadIds: ['upload-1'],
      },
    })
    expect(mocks.amend).not.toHaveBeenCalled()
  })

  it('retains every current member in a full-replacement amendment outside candidate pages', async () => {
    mocks.latest.mockResolvedValue(receipt(4))
    mocks.get.mockResolvedValue(receipt(5))
    mocks.amend.mockResolvedValue({
      submissionId: 'submission-1',
      revision: 5,
      criticalMissing: [],
      replayed: false,
    })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await screen.findByText('Version 4 received')
    fireEvent.click(screen.getByRole('button', { name: 'Review an update' }))
    expect(await screen.findByText('Earlier staff answers')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Submit this update' }))
    await waitFor(() => expect(mocks.amend).toHaveBeenCalledTimes(1))
    expect(mocks.amend.mock.calls[0]![0]).toMatchObject({
      submissionId: 'submission-1',
      expectedCurrentRevision: 4,
      selection: { intakeRunIds: expect.arrayContaining(['prior-run']) },
    })
  })

  it('keeps a listed upload mutually exclusive with its linked intake run', async () => {
    mocks.uploads.mockResolvedValue({
      ...uploadPage,
      items: [{ ...uploadPage.items[0], intakeRunId: 'run-1' }],
    })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    await screen.findByText('Visitor guide.pdf')
    const source = screen.getByLabelText(/Museum website/) as HTMLInputElement
    const upload = screen.getByLabelText(/Visitor guide.pdf/) as HTMLInputElement
    expect(source.checked).toBe(true)
    expect(upload.checked).toBe(false)
    fireEvent.click(upload)
    expect(upload.checked).toBe(true)
    expect(source.checked).toBe(false)
  })

  it('keeps an off-page carried upload mutually exclusive with its linked intake run', async () => {
    const current = receipt(4)
    current.revisions[0]!.members = [
      {
        ordinal: 0,
        kind: 'INTAKE_UPLOAD',
        immutableHash: 'c'.repeat(64),
        intakeRunId: null,
        intakeUploadId: 'off-page-upload',
        linkedIntakeRunId: 'run-1',
        displayName: 'Earlier floor plan.pdf',
        sourceKind: null,
      },
    ]
    mocks.latest.mockResolvedValue(current)
    mocks.uploads.mockResolvedValue({ items: [], nextCursor: null })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await screen.findByText('Version 4 received')
    fireEvent.click(screen.getByRole('button', { name: 'Review an update' }))
    const upload = (await screen.findByLabelText(/Earlier floor plan.pdf/)) as HTMLInputElement
    const source = screen.getByLabelText(/Museum website/) as HTMLInputElement
    expect(upload.checked).toBe(true)
    expect(source.checked).toBe(false)
    fireEvent.click(source)
    expect(source.checked).toBe(true)
    expect(upload.checked).toBe(false)
  })

  it('requires an explicit partial acknowledgment and renews the operation identity', async () => {
    mocks.submit.mockRejectedValueOnce({ data: { code: 'BAD_REQUEST' } }).mockResolvedValueOnce({
      submissionId: 'submission-1',
      revision: 1,
      criticalMissing: [],
      replayed: false,
    })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    await screen.findByRole('button', { name: 'Submit this version' })
    fireEvent.click(screen.getByRole('button', { name: 'Submit this version' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled())
    const first = mocks.submit.mock.calls[0]![0].selection.operationId
    fireEvent.click(screen.getByLabelText(/Send what is complete/))
    fireEvent.click(screen.getByRole('button', { name: 'Submit this version' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
    expect(mocks.submit.mock.calls[1]![0].selection).toMatchObject({ partialAcknowledged: true })
    expect(mocks.submit.mock.calls[1]![0].selection.operationId).not.toBe(first)
  })

  it('retries an ambiguous result with the same operation identity and fences duplicate clicks', async () => {
    const pending = deferred<never>()
    mocks.submit.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      submissionId: 'submission-1',
      revision: 1,
      criticalMissing: [],
      replayed: true,
    })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    const submit = await screen.findByRole('button', { name: 'Submit this version' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    const operationId = mocks.submit.mock.calls[0]![0].selection.operationId
    pending.reject(new Error('network ended'))
    const retry = await screen.findByRole('button', { name: 'Check this submission again' })
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
    expect(mocks.submit.mock.calls[1]![0].selection.operationId).toBe(operationId)
  })

  it('times out a pending first submission and ignores its late completion before exact retry', async () => {
    const pending = deferred<{
      submissionId: string
      revision: number
      criticalMissing: never[]
      replayed: boolean
    }>()
    mocks.submit.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      submissionId: 'submission-1',
      revision: 1,
      criticalMissing: [],
      replayed: true,
    })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    const submit = await screen.findByRole('button', { name: 'Submit this version' })
    vi.useFakeTimers()
    fireEvent.click(submit)
    await act(() => vi.advanceTimersByTimeAsync(15_000))

    const operationId = mocks.submit.mock.calls[0]![0].selection.operationId
    expect(screen.getByRole('button', { name: 'Check this submission again' })).toBeTruthy()
    await act(async () => {
      pending.resolve({
        submissionId: 'submission-late',
        revision: 99,
        criticalMissing: [],
        replayed: false,
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Version 99 received')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check this submission again' })).toBeTruthy()

    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Check this submission again' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
    expect(mocks.submit.mock.calls[1]![0].selection.operationId).toBe(operationId)
  })

  it('times out an amendment and retains its exact operation, selection, and base for retry', async () => {
    const pending = deferred<{
      submissionId: string
      revision: number
      criticalMissing: never[]
      replayed: boolean
    }>()
    mocks.latest.mockResolvedValue(receipt(4))
    mocks.get.mockResolvedValue(receipt(5))
    mocks.amend.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      submissionId: 'submission-1',
      revision: 5,
      criticalMissing: [],
      replayed: true,
    })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await screen.findByText('Version 4 received')
    fireEvent.click(screen.getByRole('button', { name: 'Review an update' }))
    const submit = await screen.findByRole('button', { name: 'Submit this update' })
    vi.useFakeTimers()
    fireEvent.click(submit)
    await act(() => vi.advanceTimersByTimeAsync(15_000))

    const first = mocks.amend.mock.calls[0]![0]
    expect(screen.getByRole('button', { name: 'Check this submission again' })).toBeTruthy()
    await act(async () => {
      pending.resolve({
        submissionId: 'submission-1',
        revision: 99,
        criticalMissing: [],
        replayed: false,
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Version 99 received')).toBeNull()

    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Check this submission again' }))
    await waitFor(() => expect(mocks.amend).toHaveBeenCalledTimes(2))
    expect(mocks.amend.mock.calls[1]![0]).toMatchObject({
      submissionId: first.submissionId,
      expectedCurrentRevision: first.expectedCurrentRevision,
      selection: {
        operationId: first.selection.operationId,
        intakeRunIds: first.selection.intakeRunIds,
        intakeUploadIds: first.selection.intakeUploadIds,
        drafts: first.selection.drafts,
      },
    })
  })

  it('unlocks a frozen selection after an uncertain retry receives a definitive conflict', async () => {
    const retry = deferred<never>()
    const refresh = deferred<null>()
    mocks.submit
      .mockRejectedValueOnce(new Error('network ended'))
      .mockReturnValueOnce(retry.promise)
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit this version' }))
    const retryButton = await screen.findByRole('button', { name: 'Check this submission again' })
    const latestReadsBeforeRetry = mocks.latest.mock.calls.length
    mocks.latest.mockReturnValueOnce(refresh.promise)
    fireEvent.click(retryButton)

    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
    const back = screen.getByRole('button', { name: 'Back to editing' }) as HTMLButtonElement
    expect(back.disabled).toBe(true)
    expect(screen.getByTestId('drafts').dataset.suspended).toBe('true')
    const stored = JSON.parse(
      sessionStorage.getItem('torchiko:intake-v1:user-1:venue-1') ?? '{}',
    ) as { operationId?: string }
    expect(stored.operationId).toBe(mocks.submit.mock.calls[0]![0].selection.operationId)
    expect(mocks.submit.mock.calls[1]![0]).toEqual(mocks.submit.mock.calls[0]![0])

    await act(async () => retry.reject({ data: { code: 'CONFLICT' } }))
    await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(latestReadsBeforeRetry + 1))
    expect(back.disabled).toBe(true)
    expect(screen.getByTestId('drafts').dataset.suspended).toBe('true')
    expect(sessionStorage.getItem('torchiko:intake-v1:user-1:venue-1')).toBeNull()

    await act(async () => refresh.resolve(null))
    await screen.findByText(
      'Some selected materials are incomplete or changed. Confirm “Send what is complete” or revise the selection.',
    )
    expect(back.disabled).toBe(false)
    expect(sessionStorage.getItem('torchiko:intake-v1:user-1:venue-1')).toBeNull()
    fireEvent.click(back)
    expect(await screen.findByRole('button', { name: 'Review my materials' })).toBeTruthy()
    expect(screen.getByTestId('drafts').dataset.suspended).toBe('false')
  })

  it('keeps an internal server result ambiguous with the exact retry identity locked', async () => {
    mocks.submit.mockRejectedValue({ data: { code: 'INTERNAL_SERVER_ERROR' } })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit this version' }))

    await screen.findByRole('button', { name: 'Check this submission again' })
    const back = screen.getByRole('button', { name: 'Back to editing' }) as HTMLButtonElement
    expect(back.disabled).toBe(true)
    const stored = JSON.parse(
      sessionStorage.getItem('torchiko:intake-v1:user-1:venue-1') ?? '{}',
    ) as { operationId?: string }
    expect(stored.operationId).toBe(mocks.submit.mock.calls[0]![0].selection.operationId)
  })

  it('preserves an uncertain retry identity in scoped session storage', async () => {
    mocks.submit.mockRejectedValue(new Error('network ended'))
    const first = render(
      <IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />,
    )
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit this version' }))
    await screen.findByRole('button', { name: 'Check this submission again' })
    const originalOperation = mocks.submit.mock.calls[0]![0].selection.operationId
    first.unmount()
    mocks.submit.mockResolvedValue({
      submissionId: 'submission-1',
      revision: 1,
      criticalMissing: [],
      replayed: true,
    })
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check this submission again' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
    expect(mocks.submit.mock.calls[1]![0].selection.operationId).toBe(originalOperation)
  })

  it('holds a restored retry until the initial durable receipt read settles', async () => {
    const initialReceipt = deferred<null>()
    mocks.latest.mockReturnValue(initialReceipt.promise)
    sessionStorage.setItem(
      'torchiko:intake-v1:user-1:venue-1',
      JSON.stringify({
        version: 1,
        operationId: '11111111-1111-4111-8111-111111111111',
        selectedKeys: ['source:run-1'],
        partialAcknowledged: false,
        base: null,
        drafts: [],
      }),
    )
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    const retry = await screen.findByRole('button', { name: 'Check this submission again' })
    expect((retry as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(retry)
    expect(mocks.submit).not.toHaveBeenCalled()

    initialReceipt.resolve(null)
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
    expect(mocks.submit.mock.calls[0]![0].selection.operationId).toBe(
      '11111111-1111-4111-8111-111111111111',
    )
  })

  it('does not retain another user context or expose its uncertain retry', async () => {
    sessionStorage.setItem(
      'torchiko:intake-v1:user-1:venue-1',
      JSON.stringify({
        version: 1,
        operationId: '11111111-1111-4111-8111-111111111111',
        selectedKeys: ['source:run-1'],
        partialAcknowledged: false,
        base: null,
        drafts: [],
      }),
    )
    const rendered = render(
      <IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />,
    )
    await screen.findByRole('button', { name: 'Check this submission again' })
    rendered.rerender(
      <IntakeV1SubmissionWorkspace ownerId="user-2" venueId="venue-1" proposals={[]} />,
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review my materials' })).toBeTruthy(),
    )
    expect(screen.queryByRole('button', { name: 'Check this submission again' })).toBeNull()
    expect(sessionStorage.getItem('torchiko:intake-v1:user-1:venue-1')).not.toBeNull()
  })

  it('remounts the private draft workspace when the trusted owner changes', async () => {
    const rendered = render(
      <IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />,
    )
    await waitFor(() => expect(mocks.draftMounted).toHaveBeenCalledTimes(1))

    rendered.rerender(
      <IntakeV1SubmissionWorkspace ownerId="user-2" venueId="venue-1" proposals={[]} />,
    )

    await waitFor(() => expect(mocks.draftMounted).toHaveBeenCalledTimes(2))
    expect(mocks.draftUnmounted).toHaveBeenCalledTimes(1)
  })

  it('reports a confirmed save when exact receipt reload fails', async () => {
    mocks.get.mockRejectedValue(new Error('read failed'))
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit this version' }))
    expect(
      await screen.findByText(/submission was saved, but its receipt could not reload/i),
    ).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/not saved|was not shared/iu)
  })

  it('reads the exact saved revision when a concurrent newer revision is already current', async () => {
    const newerAggregate = receipt(2)
    newerAggregate.revisions = [
      {
        ...receipt(1).revisions[0]!,
        revision: 1,
        members: [
          ...receipt(1).revisions[0]!.members,
          {
            ordinal: 1,
            kind: 'INTAKE_RUN',
            immutableHash: 'd'.repeat(64),
            intakeRunId: 'saved-run',
            intakeUploadId: null,
            linkedIntakeRunId: null,
            displayName: 'Saved source',
            sourceKind: 'NOTES',
          },
        ],
      },
    ]
    mocks.get.mockResolvedValue(newerAggregate)
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit this version' }))

    await screen.findByText('Version 1 received')
    expect(screen.getByText(/2 selected items saved for review/u)).toBeTruthy()
    expect(mocks.get).toHaveBeenCalledWith(
      { venueId: 'venue-1', submissionId: 'submission-1', revisionCursor: 2, revisionLimit: 1 },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.processing).toHaveBeenLastCalledWith({
      ownerId: 'user-1',
      venueId: 'venue-1',
      submissionId: 'submission-1',
      revision: 1,
    })
  })

  it('refetches a changed amendment base and requires a fresh explicit review', async () => {
    mocks.latest
      .mockResolvedValueOnce(receipt(4))
      .mockResolvedValueOnce(receipt(4))
      .mockResolvedValue(receipt(5))
    mocks.amend.mockRejectedValueOnce({ data: { code: 'CONFLICT' } }).mockResolvedValueOnce({
      submissionId: 'submission-1',
      revision: 6,
      criticalMissing: [],
      replayed: false,
    })
    mocks.get.mockResolvedValue(receipt(6))
    render(<IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />)
    await screen.findByText('Version 4 received')
    fireEvent.click(screen.getByRole('button', { name: 'Review an update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit this update' }))
    expect(
      await screen.findByText(/changed elsewhere.*review the refreshed materials/i),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Submit this update' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Review an update' }))
    expect(await screen.findByText('Earlier staff answers')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Submit this update' }))
    await waitFor(() => expect(mocks.amend).toHaveBeenCalledTimes(2))
    expect(mocks.amend.mock.calls[0]![0].expectedCurrentRevision).toBe(4)
    expect(mocks.amend.mock.calls[1]![0]).toMatchObject({
      expectedCurrentRevision: 5,
      selection: { intakeRunIds: expect.arrayContaining(['prior-run']) },
    })
  })

  it('drops a late preparation result after the venue changes', async () => {
    const oldSources = deferred<typeof sourcePage>()
    mocks.sources.mockReturnValueOnce(oldSources.promise).mockResolvedValue(sourcePage)
    const rendered = render(
      <IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />,
    )
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    rendered.rerender(
      <IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-2" proposals={[]} />,
    )
    oldSources.resolve(sourcePage)

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Review my materials' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    expect(
      screen.queryByRole('heading', { name: 'Choose what goes into this version.' }),
    ).toBeNull()
    expect(mocks.submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    await waitFor(() =>
      expect(mocks.sources).toHaveBeenCalledWith(
        { venueId: 'venue-2', limit: 25 },
        { signal: expect.any(AbortSignal) },
      ),
    )
    const replacementSignal = mocks.sources.mock.calls.at(-1)?.[1]?.signal as AbortSignal
    expect(replacementSignal.aborted).toBe(false)
  })

  it('drops a late mutation result after the client is replaced', async () => {
    const oldMutation = deferred<{
      submissionId: string
      revision: number
      criticalMissing: never[]
      replayed: boolean
    }>()
    mocks.submit.mockReturnValue(oldMutation.promise)
    const rendered = render(
      <IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />,
    )
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Review my materials' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit this version' }))

    const replacementLatest = vi.fn().mockResolvedValue(null)
    mocks.currentClient = {
      ...mocks.client,
      intake: {
        ...mocks.client.intake,
        getLatestV1: { query: replacementLatest },
      },
    }
    rendered.rerender(
      <IntakeV1SubmissionWorkspace ownerId="user-1" venueId="venue-1" proposals={[]} />,
    )
    oldMutation.resolve({
      submissionId: 'old-submission',
      revision: 1,
      criticalMissing: [],
      replayed: false,
    })

    await waitFor(() => expect(replacementLatest).toHaveBeenCalled())
    expect(screen.queryByText('Version 1 received')).toBeNull()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
