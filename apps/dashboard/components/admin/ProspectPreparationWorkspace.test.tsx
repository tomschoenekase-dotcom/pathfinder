/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SalesWorkflowView } from '@pathfinder/api/prospect-sales-contract'

import { ProspectPreparationWorkspace } from './ProspectPreparationWorkspace'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

const guide = {
  id: 'torchiko-v0.2' as const,
  label: 'Saved Torchiko writing guide v0.2',
  sourceRef: 'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md',
  state: 'available' as const,
  sha256: 'a'.repeat(64),
}

function workflow(overrides: Partial<SalesWorkflowView> = {}): SalesWorkflowView {
  return {
    venueId: 'venue-1',
    organizationId: 'org-1',
    name: 'Harbor Museum',
    snapshotHash: 'b'.repeat(64),
    sourceCount: 2,
    sourceState: 'RECORDED',
    contacts: [
      {
        id: 'contact-1',
        name: 'Avery',
        email: 'avery@example.invalid',
        readiness: 'READY',
        permission: 'RECORDED',
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
      value: 'avery@example.invalid',
      publicSnapshotStatus: 'RECORDED',
      nativeContactId: 'contact-1',
      readiness: 'READY',
      permission: 'RECORDED',
    },
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
    writerHold: 'Prepare current context first',
    ...overrides,
  }
}

function transport({
  organization = {
    id: 'org-1',
    canonicalName: 'Harbor Museum',
    venues: [{ id: 'venue-1', name: 'Harbor Museum' }],
  },
  view = workflow(),
}: {
  organization?: { id: string; canonicalName: string; venues: { id: string; name: string }[] }
  view?: SalesWorkflowView
} = {}) {
  return {
    readOrganization: vi.fn().mockResolvedValue(organization),
    load: vi.fn().mockResolvedValue(view),
    act: vi.fn().mockResolvedValue(view),
  }
}

describe('ProspectPreparationWorkspace', () => {
  afterEach(cleanup)

  it('holds a multi-venue organization until an operator chooses the exact native venue', async () => {
    const current = transport({
      organization: {
        id: 'org-1',
        canonicalName: 'Harbor Museum',
        venues: [
          { id: 'venue-east', name: 'Harbor East' },
          { id: 'venue-west', name: 'Harbor West' },
        ],
      },
    })
    render(
      <ProspectPreparationWorkspace
        organizationIds={['org-1']}
        transport={current}
        savedWritingGuide={guide}
      />,
    )

    expect(await screen.findByText(/select one exact native venue/i)).toBeTruthy()
    expect(current.load).not.toHaveBeenCalled()
    expect(current.act).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Prepare current record' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Exact native venue for Harbor Museum'), {
      target: { value: 'venue-west' },
    })
    await waitFor(() => expect(current.load).toHaveBeenCalledWith('venue-west'))
    expect(current.act).not.toHaveBeenCalled()
  })

  it('uses the explicitly selected saved guide only when the operator prepares the ready record', async () => {
    const current = transport()
    render(
      <ProspectPreparationWorkspace
        organizationIds={['org-1']}
        transport={current}
        savedWritingGuide={guide}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Harbor Museum' })).toBeTruthy()
    expect(current.act).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use saved Torchiko guide' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare current record' }))

    await waitFor(() =>
      expect(current.act).toHaveBeenCalledWith({
        action: 'prepare',
        input: {
          venueId: 'venue-1',
          expectedSnapshotHash: 'b'.repeat(64),
          savedWritingGuide: 'torchiko-v0.2',
          expectedWritingGuideSha256: 'a'.repeat(64),
        },
      }),
    )
  })

  it('keeps a suppressed record visibly held and never exposes preparation', async () => {
    const current = transport({
      view: workflow({ suppression: { blocked: true, reasons: ['Contact opted out'] } }),
    })
    render(
      <ProspectPreparationWorkspace
        organizationIds={['org-1']}
        transport={current}
        savedWritingGuide={guide}
      />,
    )

    expect(await screen.findByText('Contact opted out')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Prepare current record' })).toBeNull()
    expect(current.act).not.toHaveBeenCalled()
  })

  it('reloads the same selection when its authenticated transport changes', async () => {
    const first = transport()
    const page = render(
      <ProspectPreparationWorkspace
        organizationIds={['org-1']}
        transport={first}
        savedWritingGuide={guide}
      />,
    )
    await screen.findByRole('heading', { name: 'Harbor Museum' })
    const second = transport({
      organization: {
        id: 'org-1',
        canonicalName: 'Updated Museum',
        venues: [{ id: 'venue-1', name: 'Updated Museum' }],
      },
    })
    page.rerender(
      <ProspectPreparationWorkspace
        organizationIds={['org-1']}
        transport={second}
        savedWritingGuide={guide}
      />,
    )
    expect(await screen.findByRole('heading', { name: 'Updated Museum' })).toBeTruthy()
    expect(second.readOrganization).toHaveBeenCalledWith('org-1')
    expect(second.act).not.toHaveBeenCalled()
  })
})
