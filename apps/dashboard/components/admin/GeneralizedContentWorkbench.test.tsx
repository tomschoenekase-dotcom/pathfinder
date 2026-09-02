// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
  revise: vi.fn(),
  retire: vi.fn(),
  publish: vi.fn(),
  withdraw: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      previewUniversalContent: { query: mocks.preview },
      createUniversalContent: { mutate: mocks.create },
      addUniversalContentRevision: { mutate: mocks.revise },
      retireUniversalContent: { mutate: mocks.retire },
      publishUniversalContent: { mutate: mocks.publish },
      withdrawUniversalContent: { mutate: mocks.withdraw },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { GeneralizedContentWorkbench } from './GeneralizedContentWorkbench'

describe('GeneralizedContentWorkbench', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.preview.mockResolvedValue({
      preview: { lifecycle: 'EFFECTIVE', audience: 'OPERATOR' },
    })
  })

  const contentModule = {
    id: 'module-1',
    revisionId: 'revision-3',
    kind: 'POLICY' as const,
    version: 3,
    audience: 'PUBLIC' as const,
    effectiveFrom: null,
    effectiveUntil: null,
    payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
    publishedRevisionId: null,
  }
  const itemModule = {
    id: 'item-1',
    revisionId: 'item-revision-3',
    kind: 'ITEM' as const,
    version: 3,
    audience: 'PUBLIC' as const,
    effectiveFrom: null,
    effectiveUntil: null,
    payload: {
      kind: 'ITEM',
      name: 'Apollo guidance computer',
      description: 'A preserved flight computer.',
      placeId: 'place-1',
      itemType: 'artifact',
    },
    publishedRevisionId: null,
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  it('shows the honest default-off state and disables durable writes', () => {
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled={false}
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    expect(screen.getByText('Default-off flag disabled')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Create module' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText(/PUBLIC revisions remain private drafts/i)).toBeTruthy()
  })

  it('validates through the server contract and reports the no-publication preview', async () => {
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Typed payload JSON'), {
      target: { value: '{"kind":"SERVICE","name":"Coat check"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }))
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce())
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
      { signal: expect.any(AbortSignal) },
    )
    expect((await screen.findByRole('status')).textContent).toMatch(
      /guest and client publication remain off/i,
    )
  })

  it('offers ITEM authoring with a strict typed template', () => {
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'ITEM' } })
    expect((screen.getByLabelText('Typed payload JSON') as HTMLTextAreaElement).value).toContain(
      '"kind": "ITEM"',
    )
    expect((screen.getByLabelText('Typed payload JSON') as HTMLTextAreaElement).value).toContain(
      '"itemType": ""',
    )
  })

  it('creates a strict generalized ITEM with the frozen creation key', async () => {
    mocks.create.mockResolvedValue({ version: 1 })
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'ITEM' } })
    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: 'PUBLIC' } })
    fireEvent.change(screen.getByLabelText('Typed payload JSON'), {
      target: { value: JSON.stringify(itemModule.payload) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create module' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: '137c3504-8e5a-4f43-9271-dc51e4e47dad',
      draft: expect.objectContaining({ audience: 'PUBLIC', payload: itemModule.payload }),
    })
  })

  it('binds existing PUBLIC ITEM revise, retire, publish, and withdraw actions exactly', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('35a7173c-b42b-485b-8885-81355585489e')
    mocks.revise.mockResolvedValue({ version: 4 })
    mocks.retire.mockResolvedValue({ version: 4 })
    mocks.publish.mockResolvedValue({ action: 'PUBLISH' })
    mocks.withdraw.mockResolvedValue({ action: 'WITHDRAW' })
    const props = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      authoringEnabled: true,
      initialCreationKey: '137c3504-8e5a-4f43-9271-dc51e4e47dad',
    }

    render(<GeneralizedContentWorkbench {...props} modules={[itemModule]} />)
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'item-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Append revision' }))
    await waitFor(() => expect(mocks.revise).toHaveBeenCalledOnce())
    expect(mocks.revise).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'item-1', expectedLatestVersion: 3 }),
    )

    cleanup()
    render(<GeneralizedContentWorkbench {...props} modules={[itemModule]} />)
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'item-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Append retirement revision' }))
    fireEvent.change(screen.getByLabelText('Retirement effective at'), {
      target: { value: '2026-08-12T18:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement revision' }))
    await waitFor(() => expect(mocks.retire).toHaveBeenCalledOnce())
    expect(mocks.retire).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'item-1', expectedLatestVersion: 3 }),
    )

    cleanup()
    render(<GeneralizedContentWorkbench {...props} modules={[itemModule]} />)
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'item-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish this version to guests' }))
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleId: 'item-1',
        revisionId: 'item-revision-3',
        expectedLatestVersion: 3,
      }),
    )

    cleanup()
    render(
      <GeneralizedContentWorkbench
        {...props}
        modules={[{ ...itemModule, publishedRevisionId: 'item-revision-3' }]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'item-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw from guest guide' }))
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledOnce())
    expect(mocks.withdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleId: 'item-1',
        expectedPublishedRevisionId: 'item-revision-3',
      }),
    )
  })

  it('uses the displayed latest version as the revision CAS', async () => {
    mocks.revise.mockResolvedValue({ version: 4 })
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[
          {
            id: 'module-1',
            revisionId: 'revision-3',
            kind: 'POLICY',
            version: 3,
            audience: 'OPERATOR',
            effectiveFrom: null,
            effectiveUntil: null,
            payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
            publishedRevisionId: null,
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'module-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Append revision' }))
    await waitFor(() => expect(mocks.revise).toHaveBeenCalledOnce())
    expect(mocks.revise).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'module-1', expectedLatestVersion: 3 }),
    )
  })

  it('locks the stale workbench after a confirmed retirement revision until refresh', async () => {
    mocks.retire.mockResolvedValue({ version: 4 })
    const { rerender } = render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[
          {
            id: 'module-1',
            revisionId: 'revision-3',
            kind: 'POLICY',
            version: 3,
            audience: 'OPERATOR',
            effectiveFrom: null,
            effectiveUntil: null,
            payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
            publishedRevisionId: null,
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'module-1' } })
    const retireButton = screen.getByRole('button', { name: 'Append retirement revision' })
    fireEvent.click(retireButton)
    fireEvent.change(screen.getByLabelText('Retirement effective at'), {
      target: { value: '2026-08-12T18:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement revision' }))
    await waitFor(() => expect(mocks.retire).toHaveBeenCalledOnce())
    await waitFor(() => expect((retireButton as HTMLButtonElement).disabled).toBe(true))
    expect((await screen.findByRole('status')).textContent).toMatch(/retirement boundary recorded/i)
    rerender(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[{ ...contentModule, revisionId: 'revision-4', version: 4 }]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'module-1' } })
    expect(
      (screen.getByRole('button', { name: 'Append retirement revision' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('retains the exact publication request key across an ambiguous unchanged retry', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('35a7173c-b42b-485b-8885-81355585489e')
    mocks.publish
      .mockRejectedValueOnce(new Error('Unknown result'))
      .mockResolvedValueOnce({ action: 'PUBLISH' })
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[
          {
            id: 'module-1',
            revisionId: 'revision-3',
            kind: 'POLICY',
            version: 3,
            audience: 'PUBLIC',
            effectiveFrom: null,
            effectiveUntil: null,
            payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
            publishedRevisionId: null,
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'module-1' } })
    const button = screen.getByRole('button', { name: 'Publish this version to guests' })
    fireEvent.click(button)
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    await screen.findByText(
      'The publication outcome is unknown. Retry only if this exact revision is unchanged.',
    )
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2))
    expect(mocks.publish.mock.calls[0]?.[0].requestId).toBe(
      mocks.publish.mock.calls[1]?.[0].requestId,
    )
  })

  it('never renders raw errors and locks conflicts for authoritative re-review', async () => {
    mocks.preview.mockRejectedValueOnce(new Error('postgres://secret/provider-stack'))
    mocks.revise.mockRejectedValueOnce(
      Object.assign(new Error('internal revision digest'), { data: { code: 'CONFLICT' } }),
    )
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[contentModule]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }))
    expect(await screen.findByText('Content action needs attention')).toBeTruthy()
    expect(screen.queryByText(/postgres|provider-stack/iu)).toBeNull()
    fireEvent.change(screen.getByLabelText('Action target'), {
      target: { value: contentModule.id },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Append revision' }))
    expect(await screen.findByText(/authoritative revision/)).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Append revision' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.queryByText(/internal revision digest/)).toBeNull()
  })

  it('ignores a late preview after exact venue and module revision scope changes', async () => {
    const pending = deferred<{ preview: { lifecycle: string; audience: string } }>()
    mocks.preview.mockReturnValue(pending.promise)
    const { rerender } = render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[contentModule]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }))
    rerender(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-2"
        authoringEnabled
        initialCreationKey="237c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[{ ...contentModule, revisionId: 'revision-4', version: 4 }]}
      />,
    )
    expect((screen.getByLabelText('Action target') as HTMLSelectElement).value).toBe('new')
    await act(async () =>
      pending.resolve({ preview: { lifecycle: 'EFFECTIVE', audience: 'PUBLIC' } }),
    )
    expect(screen.queryByText(/guest and client publication remain off/)).toBeNull()
  })

  it('gives preview validation a cancellable transport boundary', async () => {
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }))
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce())
    expect(mocks.preview).toHaveBeenCalledWith(expect.any(Object), {
      signal: expect.any(AbortSignal),
    })
  })

  it('aborts an in-flight preview when the workbench unmounts', async () => {
    let signal: AbortSignal | undefined
    mocks.preview.mockImplementationOnce((_input, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => undefined)
    })
    const rendered = render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Validate and preview' }))
    await waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('invalidates a pending create synchronously when only the creation key changes', async () => {
    const pending = deferred<{ version: number }>()
    mocks.create.mockReturnValue(pending.promise)
    const { rerender } = render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create module' }))
    rerender(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="237c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[]}
      />,
    )
    await act(async () => pending.resolve({ version: 1 }))
    expect(screen.queryByText(/Version 1 recorded/)).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(screen.getByText(/237c3504-8e5a-4f43-9271-dc51e4e47dad/)).toBeTruthy()
  })

  it('uses one synchronous fence across preview and publication controls', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = deferred<{ preview: { lifecycle: string; audience: string } }>()
    mocks.preview.mockReturnValue(pending.promise)
    render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[contentModule]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), {
      target: { value: contentModule.id },
    })
    const preview = screen.getByRole('button', { name: 'Validate and preview' })
    const publish = screen.getByRole('button', { name: 'Publish this version to guests' })
    fireEvent.click(preview)
    fireEvent.click(publish)
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1))
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(
      screen.getByRole('region', { name: 'Immutable revision editor' }).getAttribute('aria-busy'),
    ).toBe('true')
    await act(async () =>
      pending.resolve({ preview: { lifecycle: 'EFFECTIVE', audience: 'PUBLIC' } }),
    )
  })

  it('has no automated accessibility violations in an actionable state', async () => {
    const { container } = render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[contentModule]}
      />,
    )
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('has no automated accessibility violations with a PUBLIC ITEM selected', async () => {
    const { container } = render(
      <GeneralizedContentWorkbench
        tenantId="tenant-1"
        venueId="venue-1"
        authoringEnabled
        initialCreationKey="137c3504-8e5a-4f43-9271-dc51e4e47dad"
        modules={[itemModule]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Action target'), { target: { value: 'item-1' } })
    expect(screen.getByRole('button', { name: 'Publish this version to guests' })).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
