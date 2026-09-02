/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  list: vi.fn(),
  createDraft: vi.fn(),
  approve: vi.fn(),
  applyPackage: vi.fn(),
  revertPackage: vi.fn(),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    venuePackage: {
      preview: { mutate: mocks.preview },
      list: { query: mocks.list },
      createDraft: { mutate: mocks.createDraft },
      approve: { mutate: mocks.approve },
      applyPackage: { mutate: mocks.applyPackage },
      revertPackage: { mutate: mocks.revertPackage },
    },
  }),
}))

import { VenueJsonImporter } from './VenueJsonImporter'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code } })
}

const payload = {
  schemaVersion: 1,
  places: [
    {
      name: 'Butterfly Conservatory',
      type: 'exhibit',
      itemType: 'exhibit',
      shortDescription: 'Butterflies.',
      lat: 41.8,
      lng: -87.6,
      tags: ['family'],
      importanceScore: 80,
    },
  ],
  knowledgeEntries: [
    {
      title: 'Accessibility',
      category: 'Accessibility',
      content: 'Step-free entry.',
      isEnabled: true,
    },
  ],
}

const completeSemanticDuplicateScan = {
  status: 'COMPLETE' as const,
  similarityThreshold: 0.9,
  scopes: {
    places: {
      embeddingProfile: 'openai:text-embedding-3-small:1536',
      inputCount: 1,
      scannedInputCount: 1,
      existingCount: 2,
      scannedExistingCount: 2,
    },
    knowledgeEntries: {
      embeddingProfile: 'openai:text-embedding-3-small:1536',
      inputCount: 1,
      scannedInputCount: 1,
      existingCount: 3,
      scannedExistingCount: 3,
    },
  },
}

const preview = {
  schemaVersion: 1,
  payloadHash: 'a'.repeat(64),
  baseDigest: 'b'.repeat(64),
  warningDigest: 'c'.repeat(64),
  mode: 'ADDITIVE_V1',
  report: {
    errors: [],
    warnings: [],
    semanticDuplicateScan: completeSemanticDuplicateScan,
  },
  changes: {
    places: { add: payload.places, change: [], remove: [], unchanged: 2 },
    knowledgeEntries: { add: payload.knowledgeEntries, change: [], remove: [], unchanged: 3 },
  },
}

const updatedAt = new Date('2026-08-08T12:00:00.000Z')
const draft = {
  id: 'cpackageabc1234567890',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  schemaVersion: 1,
  payload,
  payloadHash: preview.payloadHash,
  baseDigest: preview.baseDigest,
  validationReport: preview.report,
  previewPlan: preview,
  status: 'DRAFT',
  createdBy: 'manager-1',
  approvedBy: null,
  approvedAt: null,
  appliedBy: null,
  appliedAt: null,
  appliedEntities: null,
  revertedBy: null,
  revertedAt: null,
  createdAt: updatedAt,
  updatedAt,
}

const v2Payload = {
  schemaVersion: 2,
  venue: {
    identity: { description: null },
    branding: {
      chatLogoUrl: 'https://cdn.example.test/venue-logo.png',
      chatBannerUrl: null,
    },
  },
  places: [],
  knowledgeEntries: [],
}

const v2Preview = {
  ...preview,
  schemaVersion: 2,
  mode: 'CONFIG_PATCH_AND_ADDITIVE_V2',
  changes: {
    venue: {
      change: [
        {
          path: 'venue.identity.description',
          before: 'Legacy venue description',
          after: null,
        },
        {
          path: 'venue.branding.chatLogoUrl',
          before: null,
          after: 'https://cdn.example.test/venue-logo.png',
        },
        {
          path: 'venue.branding.chatBannerUrl',
          before: 'https://cdn.example.test/old-banner.png',
          after: null,
        },
      ],
      unchanged: 8,
    },
    places: { add: [], change: [], remove: [], unchanged: 2 },
    knowledgeEntries: { add: [], change: [], remove: [], unchanged: 3 },
  },
}

const v2Draft = {
  ...draft,
  id: 'cpackagev2abc123456789',
  schemaVersion: 2,
  payload: v2Payload,
  previewPlan: v2Preview,
  validationReport: v2Preview.report,
}

const v3Preview = {
  ...preview,
  schemaVersion: 3,
  mode: 'MUTATING_V3',
  changes: {
    venue: {
      expectedVersionId: 'venue-version-reviewed',
      change: [{ path: 'venue.identity.name', before: 'City Museum', after: 'City Museum V3' }],
      unchanged: 10,
    },
    places: {
      add: [{ itemKey: 'place-create-key', value: { name: 'New gallery', type: 'room' } }],
      change: [
        {
          itemKey: 'place-update-key',
          id: 'place-existing',
          expectedVersionId: 'place-version-reviewed',
          before: { name: 'Old gallery' },
          after: { name: 'Updated gallery' },
        },
      ],
      remove: [
        {
          itemKey: 'place-delete-key',
          id: 'place-retired',
          expectedVersionId: 'place-delete-version-reviewed',
          before: { name: 'Retired gallery' },
          dependencies: [{ entityType: 'TOUR_STOP', count: 2 }],
        },
      ],
      unchanged: 4,
    },
    knowledgeEntries: {
      add: [{ itemKey: 'knowledge-create-key', value: { title: 'New policy' } }],
      change: [
        {
          itemKey: 'knowledge-update-key',
          id: 'knowledge-existing',
          expectedVersionId: 'knowledge-version-reviewed',
          before: { title: 'Old policy' },
          after: { title: 'Updated policy' },
        },
      ],
      remove: [],
      unchanged: 5,
    },
  },
}

const v3Draft = {
  ...draft,
  id: 'cpackagev3abc123456789',
  schemaVersion: 3,
  previewPlan: v3Preview,
  validationReport: v3Preview.report,
}

describe('venue package workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue([])
    mocks.preview.mockResolvedValue(preview)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('uses the server preview and renders every supported addition exactly', async () => {
    render(
      <VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="location_aware" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))

    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce())
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        payload: expect.objectContaining({ schemaVersion: 1 }),
      }),
    )
    expect(await screen.findByText(/"shortDescription": "Butterflies\."/)).toBeTruthy()
    expect(screen.getByText(/"lat": 41\.8,/)).toBeTruthy()
    expect(screen.getAllByText(/"tags": \[/).some((node) => node.tagName === 'PRE')).toBe(true)
    expect(screen.getByText(/"content": "Step-free entry\."/)).toBeTruthy()
    expect(screen.getAllByText(/"isEnabled": true/).some((node) => node.tagName === 'PRE')).toBe(
      true,
    )
    expect(screen.getByText(/2 existing places unchanged/)).toBeTruthy()
    expect(screen.getByText(/3 existing entries unchanged/)).toBeTruthy()
    expect(screen.getByText('Exact additive preview')).toBeTruthy()
    expect(screen.getByText('Mode: ADDITIVE_V1')).toBeTruthy()
  })

  it('renders a saved V2 configuration patch exactly without requesting another preview', async () => {
    mocks.list.mockResolvedValueOnce([v2Draft])

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(v2Draft.id))

    expect(
      await screen.findByText('Exact venue configuration patch + additive preview'),
    ).toBeTruthy()
    expect(screen.getByText('Mode: CONFIG_PATCH_AND_ADDITIVE_V2')).toBeTruthy()
    expect(screen.getByText('Venue configuration changes (3)')).toBeTruthy()
    expect(screen.getByText('venue.identity.description')).toBeTruthy()
    expect(screen.getByText('"Legacy venue description" → null (clear)')).toBeTruthy()
    expect(screen.getByText('venue.branding.chatLogoUrl')).toBeTruthy()
    expect(screen.getByText('null → "https://cdn.example.test/venue-logo.png"')).toBeTruthy()
    expect(screen.getByText('venue.branding.chatBannerUrl')).toBeTruthy()
    expect(
      screen.getByText('"https://cdn.example.test/old-banner.png" → null (clear)'),
    ).toBeTruthy()
    expect(screen.getByText('8 venue configuration fields unchanged.')).toBeTruthy()
    expect(
      screen.getByText(
        'Branding URL fields are compatible external URL references. This package does not upload, copy, or host image assets.',
      ),
    ).toBeTruthy()
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('renders the complete saved V3 mutation plan and immutable review bindings', async () => {
    mocks.list.mockResolvedValueOnce([v3Draft])

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(v3Draft.id))

    expect(await screen.findByText('Exact mutating venue package preview')).toBeTruthy()
    expect(screen.getByText('Mode: MUTATING_V3')).toBeTruthy()
    expect(screen.getByText('Venue configuration changes (1)')).toBeTruthy()
    expect(screen.getByText('Places: 1 added, 1 changed, 1 removed')).toBeTruthy()
    expect(screen.getByText('Knowledge: 1 added, 1 changed, 0 removed')).toBeTruthy()
    expect(screen.getByText(/"itemKey": "place-create-key"/)).toBeTruthy()
    expect(screen.getByText(/"expectedVersionId": "place-version-reviewed"/)).toBeTruthy()
    expect(screen.getByText(/"entityType": "TOUR_STOP"/)).toBeTruthy()
    expect(screen.getByText(/"expectedVersionId": "knowledge-version-reviewed"/)).toBeTruthy()
    expect(
      screen.getByText(
        /Version IDs bind updates and removals to the exact reviewed entity history/,
      ),
    ).toBeTruthy()
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('shows strict server rejection and performs no draft or lifecycle write', async () => {
    mocks.preview.mockRejectedValueOnce(
      new Error('payload.tours: Unrecognized key; schemaVersion 1 does not support tours'),
    )
    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.change(screen.getByLabelText('Canonical package JSON'), {
      target: {
        value: JSON.stringify({
          schemaVersion: 1,
          places: [],
          knowledgeEntries: [],
          tours: [],
        }),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))

    expect((await screen.findByRole('alert')).textContent).toContain('does not support tours')
    expect(mocks.createDraft).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.applyPackage).not.toHaveBeenCalled()
  })

  it('rotates only a terminal draft identity so unchanged JSON can be retried', async () => {
    const terminalError = Object.assign(
      new Error('This draft key has terminal duplicate-analysis evidence; use a new key.'),
      { data: { code: 'PRECONDITION_FAILED' } },
    )
    mocks.createDraft
      .mockRejectedValueOnce(terminalError)
      .mockResolvedValueOnce({ ...draft, preview, replayed: false })
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([draft])

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))
    expect(await screen.findByText('Semantic duplicate scan: COMPLETE')).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save immutable draft' })
    fireEvent.click(save)
    expect((await screen.findByRole('alert')).textContent).toContain('terminal duplicate-analysis')
    await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledTimes(1))
    const firstKey = mocks.createDraft.mock.calls[0]?.[0].draftKey

    fireEvent.click(save)
    expect(await screen.findByText('Draft saved for review.')).toBeTruthy()
    const secondKey = mocks.createDraft.mock.calls[1]?.[0].draftKey
    expect(secondKey).not.toBe(firstKey)
  })

  it('renders complete semantic evidence from a selected package without requesting a new preview', async () => {
    mocks.list.mockResolvedValueOnce([draft])

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(draft.id))

    expect(await screen.findByText('Semantic duplicate scan: COMPLETE')).toBeTruthy()
    expect(
      screen.getByText(/Places: 1\/1 draft items and 2\/2 existing items compared/),
    ).toBeTruthy()
    expect(
      screen.getByText(/Knowledge: 1\/1 draft items and 3\/3 existing items compared/),
    ).toBeTruthy()
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('retains incomplete saved evidence but blocks approval without requesting a new preview', async () => {
    const incompletePreview = {
      ...preview,
      warningDigest: 'e'.repeat(64),
      report: {
        errors: [],
        warnings: [],
        semanticDuplicateScan: {
          ...completeSemanticDuplicateScan,
          status: 'INCOMPLETE' as const,
          scopes: {
            ...completeSemanticDuplicateScan.scopes,
            places: {
              ...completeSemanticDuplicateScan.scopes.places,
              scannedInputCount: 0,
              scannedExistingCount: 1,
            },
          },
        },
      },
    }
    const incompleteDraft = {
      ...draft,
      validationReport: incompletePreview.report,
      previewPlan: incompletePreview,
    }
    mocks.list.mockResolvedValueOnce([incompleteDraft])

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(draft.id))

    expect(await screen.findByText('Semantic duplicate scan: INCOMPLETE')).toBeTruthy()
    expect(screen.getByText(/retained as evidence but cannot be approved or applied/)).toBeTruthy()
    expect(
      screen.getByText(/Places: 0\/1 draft items and 1\/2 existing items compared/),
    ).toBeTruthy()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(approve)
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('blocks applying a legacy approved package with incomplete semantic evidence', async () => {
    const incompletePreview = {
      ...preview,
      report: {
        errors: [
          {
            code: 'SEMANTIC_SCAN_INCOMPLETE',
            path: 'semanticDuplicateScan',
            message: 'This package predates semantic duplicate analysis.',
          },
        ],
        warnings: [],
        semanticDuplicateScan: {
          ...completeSemanticDuplicateScan,
          status: 'INCOMPLETE' as const,
          scopes: {
            places: {
              ...completeSemanticDuplicateScan.scopes.places,
              scannedInputCount: 0,
              scannedExistingCount: 0,
            },
            knowledgeEntries: {
              ...completeSemanticDuplicateScan.scopes.knowledgeEntries,
              scannedInputCount: 0,
              scannedExistingCount: 0,
            },
          },
        },
      },
    }
    const approvedLegacy = {
      ...draft,
      status: 'APPROVED',
      validationReport: incompletePreview.report,
      previewPlan: incompletePreview,
    }
    mocks.list.mockResolvedValueOnce([approvedLegacy])

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(draft.id))

    const apply = screen.getByRole('button', { name: 'Apply approved package' })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(apply)
    expect(mocks.applyPackage).not.toHaveBeenCalled()
  })

  it('uses one acknowledgement for combined exact and semantic warnings before approval', async () => {
    const warningPreview = {
      ...preview,
      warningDigest: 'd'.repeat(64),
      report: {
        errors: [],
        warnings: [
          {
            code: 'DUPLICATE_EXISTING_CONTENT',
            path: 'places.0.name',
            message: 'An active venue place already has this normalized name.',
          },
          {
            code: 'SEMANTIC_DUPLICATE_EXISTING_CONTENT',
            path: 'knowledgeEntries.0.title',
            message: 'This entry is semantically similar to existing venue knowledge.',
          },
        ],
        semanticDuplicateScan: completeSemanticDuplicateScan,
      },
    }
    mocks.preview.mockResolvedValue(warningPreview)
    mocks.createDraft.mockResolvedValue({
      ...draft,
      validationReport: warningPreview.report,
      preview: warningPreview,
      replayed: false,
    })
    mocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...draft,
          validationReport: warningPreview.report,
          previewPlan: warningPreview,
        },
      ])
      .mockResolvedValueOnce([
        {
          ...draft,
          status: 'APPROVED',
          validationReport: warningPreview.report,
          previewPlan: warningPreview,
        },
      ])
    mocks.approve.mockResolvedValue({ ...draft, status: 'APPROVED' })

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))
    expect(await screen.findByText(/already has this normalized name/)).toBeTruthy()
    expect(screen.getByText(/semantically similar to existing venue knowledge/)).toBeTruthy()
    expect(screen.getByText('I reviewed all 2 warnings.')).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable draft' }))
    expect(await screen.findByText('Draft saved for review.')).toBeTruthy()
    expect(mocks.preview).toHaveBeenCalledTimes(2)

    const approve = screen.getByRole('button', { name: 'Approve' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((approve as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(approve)

    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith({
        id: draft.id,
        expectedUpdatedAt: updatedAt,
        commandKey: expect.any(String),
        acknowledgedWarningDigest: warningPreview.warningDigest,
        acknowledgedPayloadHash: warningPreview.payloadHash,
      }),
    )
    expect(await screen.findByText(/Application remains a separate action/)).toBeTruthy()
  })

  it('keeps apply and confirmed aggregate revert as separate lifecycle actions', async () => {
    const approved = { ...draft, status: 'APPROVED' }
    const applied = { ...draft, status: 'APPLIED', updatedAt: new Date(updatedAt.getTime() + 1) }
    mocks.list
      .mockResolvedValueOnce([approved])
      .mockResolvedValueOnce([applied])
      .mockResolvedValueOnce([{ ...applied, status: 'REVERTED' }])
    mocks.applyPackage.mockResolvedValue(applied)
    mocks.revertPackage.mockResolvedValue({ ...applied, status: 'REVERTED' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(draft.id))
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))
    await waitFor(() =>
      expect(mocks.applyPackage).toHaveBeenCalledWith({
        id: draft.id,
        expectedUpdatedAt: updatedAt,
        commandKey: expect.any(String),
      }),
    )
    expect(await screen.findByText('Package applied atomically.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Revert package' }))
    await waitFor(() =>
      expect(mocks.revertPackage).toHaveBeenCalledWith({
        id: draft.id,
        expectedUpdatedAt: applied.updatedAt,
        commandKey: expect.any(String),
      }),
    )
    expect(window.confirm).toHaveBeenCalled()
  })

  it('shares one synchronous Preview/Save fence and locks the captured package payload', async () => {
    const pendingPreview = deferred<typeof preview>()
    const submittedPayload = {
      ...payload,
      places: [{ ...payload.places[0], name: 'Captured gallery' }],
    }
    mocks.list.mockResolvedValueOnce([draft]).mockResolvedValueOnce([draft])
    mocks.createDraft.mockResolvedValueOnce({ ...draft, preview, replayed: false })

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    const editor = screen.getByLabelText('Canonical package JSON') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: JSON.stringify(submittedPayload) } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))
    expect(await screen.findByText('Semantic duplicate scan: COMPLETE')).toBeTruthy()

    mocks.preview.mockReturnValueOnce(pendingPreview.promise)
    const previewButton = screen.getByRole('button', {
      name: 'Preview on server',
    }) as HTMLButtonElement
    const saveButton = screen.getByRole('button', {
      name: 'Save immutable draft',
    }) as HTMLButtonElement
    const packageButton = (await screen.findByText(draft.id)).closest('button') as HTMLButtonElement

    act(() => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      previewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.preview).toHaveBeenCalledTimes(2)
    expect(mocks.createDraft).not.toHaveBeenCalled()
    const workspace = screen
      .getByRole('heading', { name: 'Venue package workspace' })
      .closest('section')?.parentElement
    expect(workspace?.getAttribute('aria-busy')).toBe('true')
    expect(editor.disabled).toBe(true)
    expect(
      (screen.getByLabelText('Load venue package JSON file') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(previewButton.disabled).toBe(true)
    expect(saveButton.disabled).toBe(true)
    expect(packageButton.disabled).toBe(true)

    pendingPreview.resolve(preview)
    await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledOnce())
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'venue-1', payload: submittedPayload }),
    )
  })

  it('shows truthful loading and ignores an older venue history response', async () => {
    const venueOne = deferred<(typeof draft)[]>()
    const venueTwo = deferred<(typeof draft)[]>()
    const venueTwoDraft = {
      ...draft,
      id: 'cpackagevenue2abc12345',
      venueId: 'venue-2',
    }
    mocks.list.mockImplementation(({ venueId }: { venueId: string }) =>
      venueId === 'venue-1' ? venueOne.promise : venueTwo.promise,
    )

    const view = render(
      <VenueJsonImporter venueId="venue-1" venueName="First Museum" guideMode="non_location" />,
    )
    expect(screen.getByText(/Loading package history/)).toBeTruthy()
    expect(screen.queryByText('No saved package revisions yet.')).toBeNull()

    view.rerender(
      <VenueJsonImporter venueId="venue-2" venueName="Second Museum" guideMode="non_location" />,
    )
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect((mocks.list.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true)
    expect(mocks.list.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    venueTwo.resolve([venueTwoDraft])
    expect(await screen.findByText(venueTwoDraft.id)).toBeTruthy()

    venueOne.resolve([draft])
    await act(async () => venueOne.promise)
    expect(screen.queryByText(draft.id)).toBeNull()
    expect(screen.getByText(venueTwoDraft.id)).toBeTruthy()
  })

  it('cancels a pending package-history transport read on unmount', async () => {
    mocks.list.mockImplementation(() => new Promise(() => undefined))
    const view = render(
      <VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />,
    )
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    const signal = mocks.list.mock.calls[0]?.[1]?.signal as AbortSignal

    view.unmount()

    expect(signal.aborted).toBe(true)
  })

  it.each([
    { action: 'Approve', status: 'DRAFT' as const },
    { action: 'Apply approved package', status: 'APPROVED' as const },
    { action: 'Revert package', status: 'APPLIED' as const },
  ])(
    'uses structured conflict recovery and stale-locks $action until explicit reselection',
    async ({ action, status }) => {
      const current = { ...draft, status }
      const refreshed = { ...current, updatedAt: new Date(updatedAt.getTime() + 10) }
      mocks.list.mockResolvedValueOnce([current]).mockResolvedValueOnce([refreshed])
      const rejection = codedError('CONFLICT', 'Revision mismatch.')
      if (status === 'DRAFT') mocks.approve.mockRejectedValueOnce(rejection)
      if (status === 'APPROVED') mocks.applyPackage.mockRejectedValueOnce(rejection)
      if (status === 'APPLIED') {
        vi.spyOn(window, 'confirm').mockReturnValue(true)
        mocks.revertPackage.mockRejectedValueOnce(rejection)
      }

      render(
        <VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />,
      )
      fireEvent.click(await screen.findByText(current.id))
      fireEvent.click(screen.getByRole('button', { name: action }))

      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
      expect((await screen.findByRole('alert')).textContent).toContain(
        'This package changed after it was loaded.',
      )
      const staleAction = screen.getByRole('button', { name: action }) as HTMLButtonElement
      expect(staleAction.disabled).toBe(true)

      fireEvent.click(screen.getByText(refreshed.id))
      expect((screen.getByRole('button', { name: action }) as HTMLButtonElement).disabled).toBe(
        false,
      )
    },
  )

  it('does not infer a conflict refresh from message text alone', async () => {
    const approved = { ...draft, status: 'APPROVED' as const }
    mocks.list.mockResolvedValueOnce([approved])
    mocks.applyPackage.mockRejectedValueOnce(new Error('The response changed before delivery.'))

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(approved.id))
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))

    expect((await screen.findByRole('alert')).textContent).toContain('changed before delivery')
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('reuses the command key when mutation success is followed by an unconfirmed list failure', async () => {
    const approved = { ...draft, status: 'APPROVED' as const }
    const applied = {
      ...draft,
      status: 'APPLIED' as const,
      updatedAt: new Date(updatedAt.getTime() + 1),
    }
    mocks.list
      .mockResolvedValueOnce([approved])
      .mockRejectedValueOnce(new Error('Package history is unavailable.'))
      .mockResolvedValueOnce([applied])
    mocks.applyPackage.mockResolvedValue(applied)

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(approved.id))
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))
    expect((await screen.findByRole('alert')).textContent).toContain('could not be confirmed')
    expect(screen.queryByText('Package applied atomically.')).toBeNull()
    const firstKey = mocks.applyPackage.mock.calls[0]?.[0].commandKey

    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))
    expect(await screen.findByText('Package applied atomically.')).toBeTruthy()
    expect(mocks.applyPackage).toHaveBeenCalledTimes(2)
    expect(mocks.applyPackage.mock.calls[1]?.[0].commandKey).toBe(firstKey)
  })

  it('does not claim lifecycle success when the preferred revision is absent from refresh', async () => {
    const approved = { ...draft, status: 'APPROVED' as const }
    const applied = {
      ...draft,
      status: 'APPLIED' as const,
      updatedAt: new Date(updatedAt.getTime() + 1),
    }
    mocks.list.mockResolvedValueOnce([approved]).mockResolvedValueOnce([])
    mocks.applyPackage.mockResolvedValueOnce(applied)

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(approved.id))
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Package applied atomically.')).toBeNull()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('clears a stale initial-history error after a draft is authoritatively confirmed', async () => {
    const initialHistory = deferred<(typeof draft)[]>()
    const pendingCreate = deferred<typeof draft & { preview: typeof preview; replayed: boolean }>()
    mocks.list.mockReturnValueOnce(initialHistory.promise).mockResolvedValueOnce([draft])
    mocks.createDraft.mockReturnValueOnce(pendingCreate.promise)

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))
    await screen.findByText('Semantic duplicate scan: COMPLETE')
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable draft' }))
    await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledOnce())

    initialHistory.reject(new Error('Initial history failed.'))
    expect((await screen.findByRole('alert')).textContent).toContain('Initial history failed.')

    pendingCreate.resolve({ ...draft, preview, replayed: false })
    expect(await screen.findByText('Draft saved for review.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not continue into a package-list refresh after lifecycle completion on unmount', async () => {
    const approved = { ...draft, status: 'APPROVED' as const }
    const applied = {
      ...draft,
      status: 'APPLIED' as const,
      updatedAt: new Date(updatedAt.getTime() + 1),
    }
    const pendingApply = deferred<typeof applied>()
    mocks.list.mockResolvedValueOnce([approved])
    mocks.applyPackage.mockReturnValueOnce(pendingApply.promise)

    const view = render(
      <VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />,
    )
    fireEvent.click(await screen.findByText(approved.id))
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))
    await waitFor(() => expect(mocks.applyPackage).toHaveBeenCalledOnce())
    view.unmount()

    pendingApply.resolve(applied)
    await act(async () => pendingApply.promise)
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('reports file-read failure and ignores a late file from the previous venue', async () => {
    const lateRead = deferred<string>()
    const view = render(
      <VenueJsonImporter venueId="venue-1" venueName="First Museum" guideMode="non_location" />,
    )
    const fileInput = screen.getByLabelText('Load venue package JSON file')
    const originalText = (screen.getByLabelText('Canonical package JSON') as HTMLTextAreaElement)
      .value

    fireEvent.change(fileInput, {
      target: {
        files: [{ text: () => Promise.reject(new Error('The JSON file could not be read.')) }],
      },
    })
    expect((await screen.findByRole('alert')).textContent).toContain('could not be read')
    expect((screen.getByLabelText('Canonical package JSON') as HTMLTextAreaElement).value).toBe(
      originalText,
    )

    fireEvent.change(fileInput, { target: { files: [{ text: () => lateRead.promise }] } })
    view.rerender(
      <VenueJsonImporter venueId="venue-2" venueName="Second Museum" guideMode="non_location" />,
    )
    lateRead.resolve('{"schemaVersion":999}')
    await act(async () => lateRead.promise)
    expect((screen.getByLabelText('Canonical package JSON') as HTMLTextAreaElement).value).not.toBe(
      '{"schemaVersion":999}',
    )
  })

  it('rejects oversized venue-package JSON before reading it', async () => {
    const read = vi.fn(async () => '{"schemaVersion":1}')
    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    const fileInput = screen.getByLabelText('Load venue package JSON file')
    const originalText = (screen.getByLabelText('Canonical package JSON') as HTMLTextAreaElement)
      .value

    fireEvent.change(fileInput, {
      target: {
        files: [{ size: 2 * 1024 * 1024 + 1, text: read }],
      },
    })

    expect((await screen.findByRole('alert')).textContent).toContain('2 MB or smaller')
    expect(read).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Canonical package JSON') as HTMLTextAreaElement).value).toBe(
      originalText,
    )
    expect(fileInput.getAttribute('aria-describedby')).toBe('venue-package-file-limit')
    expect(screen.getByText('JSON files up to 2 MB.')).toBeTruthy()
  })
})
