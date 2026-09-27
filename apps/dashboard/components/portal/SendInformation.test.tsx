/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../../lib/intake-file-identity', async (load) => {
  const actual = await load<typeof import('../../lib/intake-file-identity')>()
  return {
    ...actual,
    // jsdom cannot stream-hash files; the transfer protocol is what these tests exercise.
    identifyIntakeFile: vi.fn(async (file: File) => {
      const hex = Array.from(`${file.name}:${file.size}`, (c) => c.charCodeAt(0).toString(16))
        .join('')
        .padEnd(64, '0')
        .slice(0, 64)
      return { sha256Hex: hex, sha256Base64: 'fixture' }
    }),
  }
})
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

import {
  normalizeWebsiteLink,
  SendInformationView,
  type SendInformationApi,
} from './SendInformation'

function photo(name = 'hours-sign.png') {
  return new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], name, { type: 'image/png' })
}

function api(overrides: Partial<SendInformationApi> = {}): SendInformationApi {
  return {
    reserve: vi.fn(async (input) => ({
      upload: { id: `upload-${input.requestId}`, status: 'AWAITING_REVIEW' },
      uploadRequest: null,
    })),
    verify: vi.fn(),
    signMultipartPart: vi.fn(),
    completeMultipart: vi.fn(),
    createProposal: vi.fn(async () => ({})),
    ...overrides,
  }
}

function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!
  fireEvent.change(input, { target: { files: [file] } })
}

describe('Send us information', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('sends files before the link and note, and keeps both when a file fails', async () => {
    let reserveCalls = 0
    const reserve = vi.fn(async (input: { requestId: string }) => {
      reserveCalls += 1
      if (reserveCalls === 1) throw new Error('network')
      return {
        upload: { id: `upload-${input.requestId}`, status: 'AWAITING_REVIEW' },
        uploadRequest: null,
      }
    })
    const adapter = api({ reserve: reserve as unknown as SendInformationApi['reserve'] })
    const onSent = vi.fn()
    render(
      <SendInformationView venueId="venue-1" canSendLinksAndNotes api={adapter} onSent={onSent} />,
    )

    chooseFile(photo())
    fireEvent.click(screen.getByRole('button', { name: 'Add a link' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Website link' }), {
      target: { value: 'maplehollow.org/fall' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Write a note' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Open 9–5 daily through October.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Torchiko' }))

    expect(await screen.findByText(/haven’t been sent yet/u)).toBeTruthy()
    expect(adapter.createProposal).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Website link' }).value).toBe(
      'maplehollow.org/fall',
    )
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' }).value).toBe(
      'Open 9–5 daily through October.',
    )
    expect(onSent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByText(/^Sent to Torchiko: 1 file, your link and your note\./u),
    ).toBeTruthy()
    // A retry of the same bytes keeps the same request identity, so it cannot duplicate.
    const firstRequest = reserve.mock.calls[0]![0].requestId
    expect(reserve.mock.calls[1]![0].requestId).toBe(firstRequest)
    expect(adapter.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'WEBSITE',
        websiteUri: 'https://maplehollow.org/fall',
        displayName: 'maplehollow.org',
        venueId: 'venue-1',
      }),
    )
    expect(adapter.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'NOTES', notes: 'Open 9–5 daily through October.' }),
    )
    expect(document.body.textContent).not.toMatch(/published to your|now live/iu)
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it('keeps a note and its request identity when only the note fails', async () => {
    let calls = 0
    const createProposal = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('down')
      return {}
    })
    render(
      <SendInformationView venueId="venue-1" canSendLinksAndNotes api={api({ createProposal })} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Write a note' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Closed Monday.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Torchiko' }))
    expect(await screen.findByText(/Your words are still here/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send to Torchiko' }))
    await waitFor(() => expect(createProposal).toHaveBeenCalledTimes(2))
    const [first, second] = createProposal.mock.calls as unknown as Array<[{ requestId: string }]>
    expect(second![0].requestId).toBe(first![0].requestId)
  })

  it('reports a file still in its safety check as received, not failed', async () => {
    const reserve = vi.fn(async () => ({
      upload: { id: 'u1', status: 'VERIFYING' },
      uploadRequest: null,
    }))
    const verify = vi.fn(async () => ({
      upload: { id: 'u1', status: 'PRECHECK_PASSED' },
      nextAction: 'WAIT',
    }))
    render(
      <SendInformationView
        venueId="venue-1"
        canSendLinksAndNotes
        api={api({
          reserve: reserve as unknown as SendInformationApi['reserve'],
          verify: verify as unknown as SendInformationApi['verify'],
        })}
      />,
    )
    chooseFile(photo())
    fireEvent.click(screen.getByRole('button', { name: 'Send to Torchiko' }))
    expect(await screen.findByText('Sent · finishing safety check')).toBeTruthy()
    expect(screen.getByText(/nothing else is needed from you/u)).toBeTruthy()
  })

  it('lets staff send files but leaves links and notes to managers', () => {
    render(<SendInformationView venueId="venue-1" canSendLinksAndNotes={false} api={api()} />)
    expect(screen.queryByRole('button', { name: 'Add a link' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Write a note' })).toBeNull()
    expect(screen.getByText(/manager or owner on your team/u)).toBeTruthy()
    expect(document.querySelector('input[type=file]')).toBeTruthy()
  })

  it('accepts casual web addresses and refuses anything else', () => {
    expect(normalizeWebsiteLink('maplehollow.org/hours')).toBe('https://maplehollow.org/hours')
    expect(normalizeWebsiteLink(' http://example.org ')).toBe('http://example.org/')
    expect(normalizeWebsiteLink('javascript:alert(1)')).toBeNull()
    expect(normalizeWebsiteLink('not a link')).toBeNull()
    expect(normalizeWebsiteLink('https://user:pass@example.org')).toBeNull()
  })
})
