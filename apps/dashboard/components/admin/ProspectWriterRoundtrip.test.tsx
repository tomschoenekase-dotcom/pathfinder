/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import { ProspectWriterRoundtrip } from './ProspectWriterRoundtrip'
import type { SalesWorkflowView } from '@pathfinder/api/prospect-sales-contract'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const view: SalesWorkflowView = {
  venueId: 'v',
  organizationId: 'o',
  name: 'Synthetic unit only',
  snapshotHash: 'a'.repeat(64),
  sourceCount: 0,
  sourceState: 'NONE',
  contacts: [],
  gate: {
    decision: 'RESEARCH_REQUIRED',
    canPrepare: false,
    questions: [],
    humanQuestions: [],
    notices: [],
  },
  routing: null,
  suppression: { blocked: false, reasons: [] },
  outreachState: 'NO_DRAFT',
  correspondenceState: 'NO_THREAD',
  correspondence: null,
  threadCandidates: [],
  preparation: null,
  draft: null,
  revisions: [],
  blocker: null,
  SEND_AUTHORIZED: false,
  senderAvailable: false,
  writerTask: null,
  writerHold: 'Current persisted preparation required',
}
function candidate(venueId = 'v') {
  const h = 'a'.repeat(64)
  return {
    schema: 'torchiko.native-writer-result/1',
    taskId: `writer-task_${h}`,
    binding: {
      venueId,
      organizationId: 'o',
      preparationId: 'p',
      nativeSnapshotHash: h,
      preparationHash: h,
      componentCodeHash: h,
      fileSetHash: h,
      selectionId: null,
      routeHash: h,
      routeKind: 'email',
      recipient: 'qa@example.invalid',
      formUrl: null,
      threadHash: h,
      libraryHash: h,
      wltHash: h,
      expectedDraftId: null,
      expectedVenueDraftId: null,
      expectedMeaningReviewId: null,
      expectedReadReviewId: null,
    },
    generatedBy: { kind: 'model', identity: 'Synthetic test' },
    subject: 'Hello',
    body: 'Hi, 🌿',
    annotations: ['subject', 'body'].map((section, index) => ({
      annotation_id: section,
      section,
      start: 0,
      end: 5,
      quote: index ? 'Hi, 🌿' : 'Hello',
      category: 'NONFACTUAL',
      claim_ids: [],
      reason: 'Synthetic greeting',
      answers: [],
    })),
    languageUses: [],
    assessment: null,
  }
}
describe('bounded file-only writer exchange UI', () => {
  afterEach(cleanup)
  it('clears the import action only after an explicit receipt confirmation', async () => {
    const action = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<ProspectWriterRoundtrip view={view} enabled exportTask={vi.fn()} onAction={action} />)
    fireEvent.change(screen.getByLabelText('AI result JSON file'), {
      target: { files: [{ size: 1000, text: async () => JSON.stringify(candidate()) }] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Import exact AI candidate' }))
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Import exact AI candidate' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    expect(screen.queryByText(/Exact result receipt confirmed/)).toBeNull()
    expect(screen.getByText(/Receipt not confirmed/)).toBeTruthy()
    expect(screen.getByText(/Bound recipient: qa@example.invalid/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Import exact AI candidate' }))
    expect(await screen.findByText(/Exact result receipt confirmed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Import exact AI candidate' })).toBeNull()
    expect(action.mock.calls[1]?.[0]).toEqual(action.mock.calls[0]?.[0])
  })
  it('discards a slow file read after navigating to another prospect', async () => {
    let resolve!: (value: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const action = vi.fn()
    const props = { enabled: true, exportTask: vi.fn(), onAction: action }
    const page = render(<ProspectWriterRoundtrip view={view} {...props} />)
    fireEvent.change(screen.getByLabelText('AI result JSON file'), {
      target: { files: [{ size: 1000, text: () => pending }] },
    })
    page.rerender(<ProspectWriterRoundtrip view={{ ...view, venueId: 'other' }} {...props} />)
    resolve(JSON.stringify(candidate()))
    await waitFor(() =>
      expect((screen.getByLabelText('AI result JSON file') as HTMLInputElement).disabled).toBe(
        false,
      ),
    )
    expect(screen.queryByRole('button', { name: 'Import exact AI candidate' })).toBeNull()
    expect(action).not.toHaveBeenCalled()
  })
  it('retains the exact candidate after a lost response and permits an identical retry', async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValue(undefined)
    render(<ProspectWriterRoundtrip view={view} enabled exportTask={vi.fn()} onAction={action} />)
    fireEvent.change(screen.getByLabelText('AI result JSON file'), {
      target: { files: [{ size: 1000, text: async () => JSON.stringify(candidate()) }] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Import exact AI candidate' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Response lost')
    expect(screen.getByText(/Keep this exact result file/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Import exact AI candidate' }))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2))
    expect(action.mock.calls[1]?.[0]).toEqual(action.mock.calls[0]?.[0])
  })
  it('does not export a stale or nonexistent preparation', () => {
    const exportTask = vi.fn()
    render(
      <ProspectWriterRoundtrip view={view} enabled exportTask={exportTask} onAction={vi.fn()} />,
    )
    expect(
      (screen.getByRole('button', { name: 'Download current writer task' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(screen.getByText('Current persisted preparation required')).toBeTruthy()
    expect(exportTask).not.toHaveBeenCalled()
  })
  it('refuses an oversized file before reading its content', async () => {
    const text = vi.fn()
    render(<ProspectWriterRoundtrip view={view} enabled exportTask={vi.fn()} onAction={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('AI result JSON file'), {
      target: { files: [{ size: 60001, text }] },
    })
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('60,000'),
    )
    expect(text).not.toHaveBeenCalled()
  })
  it('rejects arbitrary source/authority JSON instead of submitting it', async () => {
    const action = vi.fn()
    render(<ProspectWriterRoundtrip view={view} enabled exportTask={vi.fn()} onAction={action} />)
    fireEvent.change(screen.getByLabelText('AI result JSON file'), {
      target: {
        files: [{ size: 100, text: async () => JSON.stringify({ actor: 'Tom', approved: true }) }],
      },
    })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(action).not.toHaveBeenCalled()
  })
  it('keeps pending imports disabled and distinguishes absence of approval accessibly', async () => {
    const { container } = render(
      <ProspectWriterRoundtrip
        view={view}
        enabled={false}
        exportTask={vi.fn()}
        onAction={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('AI result JSON file') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/NOT AN EMAIL BODY/)).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
  it('labels model attribution and makes an older replay receipt visible', () => {
    render(
      <ProspectWriterRoundtrip
        view={{
          ...view,
          draft: {
            id: 'new-draft',
            version: 2,
            subject: 'New',
            body: 'Review only',
            contentHash: 'b'.repeat(64),
            state: 'DRAFT_REVIEW',
            preparationId: 'prep',
            warnings: [],
            previousDraftId: 'old-draft',
            writerAttribution: {
              generatedByKind: 'model',
              generatedBy: 'Tom',
              submittedBy: 'synthetic:operator',
              taskId: 'task',
              resultHash: 'c'.repeat(64),
            },
          },
          writerImportReceipt: {
            id: 'old-receipt',
            draftId: 'old-draft',
            meaningReviewId: null,
            replayed: true,
          },
        }}
        enabled
        exportTask={vi.fn()}
        onAction={vi.fn()}
      />,
    )
    expect(screen.getByText('Model · Tom')).toBeTruthy()
    expect(screen.getByText(/already stored; no new draft/)).toBeTruthy()
    expect(screen.getByText(/newer draft is now current/)).toBeTruthy()
  })
})
