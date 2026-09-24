/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import { ProspectEvidenceAdmission } from './ProspectEvidenceAdmission'
import type {
  EvidenceAdmissionView,
  SalesWorkflowView,
} from '@pathfinder/api/prospect-sales-contract'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const view: SalesWorkflowView = {
  venueId: 'venue',
  organizationId: 'org',
  name: 'Synthetic unit fixture',
  snapshotHash: 'a'.repeat(64),
  sourceCount: 1,
  sourceState: 'NATIVE_SOURCE_CATALOG_WITH_EXACT_IMPORT_LINEAGE',
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
}
const evidence: EvidenceAdmissionView = {
  selectionId: null,
  selection: null,
  holds: [],
  captures: [
    {
      id: 'native-capture',
      identity: {
        venueId: 'venue',
        organizationId: 'org',
        name: 'Synthetic unit fixture',
        city: 'Test',
        region: 'MO',
        sourceLocator: 'Fixture!9',
      },
      provenance: {
        producer: 'Synthetic source-contract unit fixture, not human verification',
        method: 'FOREGROUND_HTTPS_GET',
        associationReason: 'The named fixture has explicit location and native identity.',
        gatePlanId: 'plan-unit',
        gateReceiptSha256: 'b'.repeat(64),
      },
      pages: [
        {
          id: 'page',
          url: 'https://example.invalid/contact',
          rawSha256: 'c'.repeat(64),
          observedAt: '2026-09-20T00:00:00Z',
          retrievedAt: '2026-09-20T00:00:01Z',
          nameQuote: 'Synthetic unit fixture',
          locationQuote: 'Test, MO',
        },
      ],
      claims: [
        {
          claimId: 'identity',
          kind: 'identity',
          factKey: 'venue.identity',
          value: 'Synthetic unit fixture',
          quote: 'Synthetic unit fixture',
          start: 0,
          end: 22,
          pageId: 'page',
          reason: 'Explicit synthetic source evidence.',
          validUntil: null,
          routeKind: null,
        },
        {
          claimId: 'email',
          kind: 'public_route',
          factKey: 'route.public',
          value: 'venue@example.invalid',
          quote: 'venue@example.invalid',
          start: 23,
          end: 44,
          pageId: 'page',
          reason: 'Synthetic public route.',
          validUntil: null,
          routeKind: 'email',
        },
      ],
    },
  ],
}
describe('native evidence inspection before task admission', () => {
  afterEach(cleanup)
  it('shows genuine missing-evidence state without a fetch or free-text verification input', () => {
    render(
      <ProspectEvidenceAdmission
        view={view}
        evidence={{ ...evidence, captures: [] }}
        enabled
        onAction={vi.fn()}
      />,
    )
    expect(screen.getByText(/No native official-page capture/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /fetch|crawl|send|approve/i })).toBeNull()
  })
  it('submits only current native IDs, selected claim IDs, and attributed task direction', () => {
    const onAction = vi.fn()
    render(
      <ProspectEvidenceAdmission view={view} evidence={evidence} enabled onAction={onAction} />,
    )
    fireEvent.click(screen.getByLabelText('Admit claim identity'))
    fireEvent.change(screen.getByLabelText('Selected public route'), { target: { value: 'email' } })
    fireEvent.click(screen.getByRole('button', { name: 'Admit selected evidence for review' }))
    expect(onAction).toHaveBeenCalledWith({
      action: 'admitEvidence',
      input: expect.objectContaining({
        captureId: 'native-capture',
        expectedSelectionId: null,
        venueId: 'venue',
        expectedSnapshotHash: 'a'.repeat(64),
        selection: expect.objectContaining({ claimIds: ['identity'], routeClaimId: 'email' }),
      }),
    })
    expect(JSON.stringify(onAction.mock.calls)).not.toContain('rawBytes')
    expect(screen.getByText(/UNKNOWN/)).toBeTruthy()
  })
  it('keeps held/pending admission disabled and does not conceal provenance', async () => {
    const { container } = render(
      <ProspectEvidenceAdmission
        view={view}
        evidence={evidence}
        enabled={false}
        onAction={vi.fn()}
      />,
    )
    expect(screen.getByText(/Producer:/)).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: 'Admit selected evidence for review',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
