/* @vitest-environment jsdom */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { ProspectClaimMeaningReview, unreviewedClaimSpans } from './ProspectClaimMeaningReview'
import type { MeaningReviewView, SalesWorkflowView } from '@pathfinder/api/prospect-sales-contract'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

function fixture() {
  const draft = {
    id: 'draft',
    version: 1,
    subject: 'A guide idea',
    body: 'Hello,',
    contentHash: 'a'.repeat(64),
    preparationId: 'prep',
    previousDraftId: null,
    warnings: [],
    state: 'DRAFT_REVIEW',
  }
  const review: MeaningReviewView = {
    boundIdentity: {
      draftId: 'draft',
      preparationId: 'prep',
      recipientKind: 'email',
      recipientValue: 'venue@example.invalid',
      sourceSnapshotHash: 'b'.repeat(64),
      threadId: '',
      inboundId: '',
    },
    bindingHash: 'c'.repeat(64),
    stale: false,
    status: 'REQUIRED',
    readReviewRecorded: false,
    sources: [
      {
        claim_id: 'H-SCOPE',
        category: 'SALES HYPOTHESIS',
        text: 'Propose a small guide for discussion, not a promise.',
        source_id: 'request',
        source_pointer: '/supplied_facts/0',
        evidence_sha256: 'd'.repeat(64),
        limitation: 'Task hypothesis, not venue fact.',
        url: null,
      },
    ],
    questions: [],
    current: null,
    history: [],
  }
  const view: SalesWorkflowView = {
    venueId: 'venue',
    organizationId: 'org',
    name: 'Explicit synthetic UI fixture',
    sourceCount: 1,
    sourceState: 'EXACT_NATIVE_SOURCE_CROSSWALK',
    contacts: [],
    gate: {
      decision: 'ENOUGH_EVIDENCE',
      canPrepare: true,
      questions: [],
      humanQuestions: [],
      notices: [],
    },
    routing: {
      kind: 'email',
      value: 'venue@example.invalid',
      publicSnapshotStatus: 'SNAPSHOT_ONLY',
      nativeContactId: null,
      readiness: 'UNKNOWN',
      permission: 'UNKNOWN',
    },
    suppression: { blocked: false, reasons: [] },
    outreachState: 'DRAFT_REVIEW',
    correspondenceState: 'NO_THREAD',
    correspondence: null,
    threadCandidates: [],
    snapshotHash: 'b'.repeat(64),
    draft,
    claimReview: review,
    preparation: {
      id: 'prep',
      approvedCount: 0,
      selectedCount: 0,
      stale: false,
      why: 'Synthetic source inspection',
      expectedDraftId: 'draft',
      writerMarkdown: 'Fixture context',
      wltIdentity: 'wlt-fixture',
    },
    revisions: [],
    blocker: null,
    SEND_AUTHORIZED: false,
    senderAvailable: false,
  }
  return { view, review, onAction: vi.fn().mockResolvedValue(undefined) }
}
describe('source-inspection UI without automatic semantic approval', () => {
  afterEach(cleanup)
  it('segments exact Unicode code points without calling a model or declaring support', () => {
    const result = unreviewedClaimSpans('Idea 🔎', 'Hello,\n\nA room 🔥\n\nThanks,\nTom')
    expect(result[0]!.annotation.end).toBe(6)
    for (const row of result) {
      expect(row.verdict).toBe('uncertain')
      expect(row.annotation.category).toBe('UNSUPPORTED ADDITION')
      expect(row.annotation.claim_ids).toEqual([])
    }
    expect(result[2]!.annotation).toMatchObject({ start: 8, end: 16, quote: 'A room 🔥' })
  })
  it('requires explicit attribution and all reasons; shows source text, provenance and zero approved language', async () => {
    const f = fixture()
    render(<ProspectClaimMeaningReview {...f} enabled local />)
    expect(
      (screen.getByRole('button', { name: 'Record claim / meaning findings' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(screen.getByText('Propose a small guide for discussion, not a promise.')).toBeTruthy()
    expect(screen.getByText(/0 active entries, 0 selected/)).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Authenticated operator/ })).toBeNull()
    for (const name of [
      'Claim category',
      'Attributed verdict',
      'Reviewer type',
      'Reviewer identity / attribution',
      'Reason for this mapping and assessment',
    ]) {
      const control = screen.getByLabelText(name) as HTMLInputElement
      const label = Array.from(document.querySelectorAll('label')).find(
        (entry) => entry.htmlFor === control.id,
      )
      expect(control.id).toBeTruthy()
      expect(label?.textContent).toBe(name)
      expect(label?.contains(control)).toBe(false)
    }
    expect(screen.queryByRole('button', { name: /^send|approve/i })).toBeNull()
    fireEvent.click(screen.getByText('Source details: H-SCOPE'))
    expect(screen.getByText('request#/supplied_facts/0')).toBeTruthy()
    expect(screen.getByText(/Evidence SHA-256:/)).toBeTruthy()
    const result = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    })
    expect(result.violations).toEqual([])
    expect(f.onAction).not.toHaveBeenCalled()
  })
  it('records deliberately unresolved spans as findings with exact hashes, never a human action', () => {
    const f = fixture()
    render(<ProspectClaimMeaningReview {...f} enabled local />)
    fireEvent.change(screen.getByLabelText('Reason for this mapping and assessment'), {
      target: {
        value: 'The source and text need further assessment before support can be asserted.',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect claim 2' }))
    fireEvent.change(screen.getByLabelText('Reason for this mapping and assessment'), {
      target: { value: 'This is an ordinary greeting with no factual claim.' },
    })
    fireEvent.change(screen.getByLabelText('Reviewer identity / attribution'), {
      target: { value: 'Synthetic test model; not Tom' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record claim / meaning findings' }))
    expect(f.onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'meaning',
        input: expect.objectContaining({
          venueId: 'venue',
          draftId: 'draft',
          contentHash: 'a'.repeat(64),
          expectedBindingHash: 'c'.repeat(64),
          expectedMeaningReviewId: null,
          reviewer: { kind: 'model', identity: 'Synthetic test model; not Tom' },
          languageUses: [],
          unsupportedClaims: expect.arrayContaining([expect.stringContaining('subject-0-12')]),
        }),
      }),
    )
    const payload = f.onAction.mock.calls[0]![0].input
    expect(
      payload.assessments.every((row: { verdict: string }) => row.verdict === 'uncertain'),
    ).toBe(true)
    expect(payload.actor).toBeUndefined()
  })
  it('disables recording on unsaved draft or stale evidence while preserving inspection', () => {
    const f = fixture()
    f.review.stale = true
    f.review.status = 'STALE'
    render(<ProspectClaimMeaningReview {...f} enabled={false} local />)
    expect(screen.getByText(/Retained findings are not rewritten/)).toBeTruthy()
    const select = screen.getByLabelText('Claim category') as HTMLSelectElement
    expect(select.closest('fieldset')?.disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Record claim / meaning findings' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
  it('splits a mixed span without copying its prior support assessment', () => {
    const f = fixture()
    render(<ProspectClaimMeaningReview {...f} enabled local />)
    fireEvent.change(screen.getByLabelText('Attributed verdict'), {
      target: { value: 'supported' },
    })
    fireEvent.click(screen.getByText('Split a span with more than one claim'))
    fireEvent.change(
      screen.getByLabelText('Split after this many code points within the selected span'),
      { target: { value: '2' } },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Split selected span' }))
    expect(screen.getByText('Text spans (3)')).toBeTruthy()
    expect((screen.getByLabelText('Attributed verdict') as HTMLSelectElement).value).toBe(
      'uncertain',
    )
  })
})
