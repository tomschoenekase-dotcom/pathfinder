/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }))
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({ portal: { createPreviewFeedbackRequest: { mutate: mocks.mutate } } }),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

import { ClientPackagePreview } from './ClientPackagePreview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const preview = {
  venue: {
    id: 'venue / one',
    name: 'Riverside Museum',
    description: 'A welcoming museum.',
    category: 'Museum',
    branding: {
      theme: 'classic',
      accentColor: '#235f67',
      font: 'sans',
      logoUrl: null,
      bannerUrl: null,
    },
    guide: {
      name: 'River Guide',
      tone: { preset: 'friendly' as const, behaviorVersion: 1 as const },
    },
  },
  package: {
    id: 'package / approved',
    status: 'APPROVED' as const,
    approvedAt: '2026-08-12T12:00:00.000Z',
  },
  experience: {
    places: [
      {
        name: 'River Gallery',
        type: 'EXHIBIT',
        shortDescription: 'Explore river life.',
        longDescription: null,
        areaName: 'Level 2',
        hours: '9-5',
        lat: 41.88,
        lng: -87.62,
        photoUrl: null,
        tags: ['Family'],
      },
    ],
    knowledgeEntries: [
      { title: 'Arrival', category: 'Planning', content: 'Use the east entrance.' },
    ],
    summary: { placeCount: 1, knowledgeEntryCount: 1 },
  },
  staleness: 'CURRENT' as const,
  autoApply: false as const,
  published: false as const,
  guestAccessible: false as const,
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('ClientPackagePreview', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders only the safe exact experience and no lifecycle mutation controls', () => {
    render(<ClientPackagePreview preview={preview} />)
    expect(screen.getByText('Approved preview - not live')).toBeTruthy()
    expect(screen.getByText('River Gallery')).toBeTruthy()
    expect(screen.getByText('Use the east entrance.')).toBeTruthy()
    expect(screen.getByText(/friendly voice/i)).toBeTruthy()
    expect(screen.getByText('Map location included')).toBeTruthy()
    expect(
      screen.getAllByRole('link', { name: 'Send preview feedback' })[0]!.getAttribute('href'),
    ).toBe('#preview-feedback')
    expect(document.body.textContent).not.toMatch(
      /payload|hash|schema|provider|validation|provenance|apply|publish now/i,
    )
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
    expect(screen.getByText(/presentation here is simplified/i)).toBeTruthy()
  })

  it('has no automated accessibility violations with populated approved content', async () => {
    const { container } = render(<ClientPackagePreview preview={preview} />)
    document.documentElement.lang = 'en'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map(({ id }) => id)).toEqual([])
  })

  it('tests guided and open questions against the exact package and records answer feedback', async () => {
    mocks.mutate.mockResolvedValue({ request: { id: 'request_1' } })
    render(<ClientPackagePreview preview={preview} />)

    fireEvent.click(screen.getByRole('button', { name: 'What should I see if I have one hour?' }))
    expect(screen.getByText(/does not contain a supported answer/i)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Your question'), {
      target: { value: 'Where is the arrival entrance?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Test question' }))
    expect(screen.getAllByText('Use the east entrance.')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Needs a change' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: 'package / approved',
        context: {
          kind: 'PREVIEW_ANSWER',
          prompt: 'Where is the arrival entrance?',
          answerRef: 'knowledge:0:Arrival',
          verdict: 'NEEDS_CHANGE',
        },
      }),
    )
    expect(await screen.findByText(/saved as follow-up work/i)).toBeTruthy()
  })

  it('renders truthful empty sections and has no automated accessibility violations', async () => {
    const { container } = render(
      <ClientPackagePreview
        preview={{
          ...preview,
          experience: {
            places: [],
            knowledgeEntries: [],
            summary: { placeCount: 0, knowledgeEntryCount: 0 },
          },
        }}
      />,
    )
    expect(screen.getByText(/No visitor places/i)).toBeTruthy()
    expect(screen.getByText(/No visitor answers/i)).toBeTruthy()
    document.documentElement.lang = 'en'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map(({ id }) => id)).toEqual([])
  })

  it('fences duplicates and reuses identity for unchanged ambiguous retry', async () => {
    const pending = deferred<never>()
    mocks.mutate.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('unknown'))
    render(<ClientPackagePreview preview={preview} />)
    fireEvent.change(screen.getByLabelText('Feedback'), {
      target: { value: 'Please revise arrival.' },
    })
    const submit = screen.getByRole('button', { name: 'Send preview feedback' })
    fireEvent.click(submit)
    fireEvent.submit(submit.closest('form')!)
    expect(mocks.mutate).toHaveBeenCalledOnce()
    const first = mocks.mutate.mock.calls[0]![0]
    expect(first).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      venueId: 'venue / one',
      packageId: 'package / approved',
      body: 'Please revise arrival.',
      attachments: [],
    })
    await act(async () => pending.reject(new Error('unknown')))
    expect(screen.getByLabelText<HTMLTextAreaElement>('Feedback').value).toBe(
      'Please revise arrival.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send preview feedback' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.mutate.mock.calls[1]![0].operationId).toBe(first.operationId)
  })

  it('rotates identity on edit and reports success without exposing request ID', async () => {
    mocks.mutate
      .mockRejectedValueOnce(new Error('unknown'))
      .mockResolvedValueOnce({ request: { id: 'private_request_id' } })
    render(<ClientPackagePreview preview={preview} />)
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'First wording' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send preview feedback' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    const firstId = mocks.mutate.mock.calls[0]![0].operationId
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Changed wording' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send preview feedback' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.mutate.mock.calls[1]![0].operationId).not.toBe(firstId)
    expect(await screen.findByText(/feedback was sent/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Support' }).getAttribute('href')).toBe(
      '/support?venue=venue+%2F+one',
    )
    expect(document.body.textContent).not.toContain('private_request_id')
  })
})
