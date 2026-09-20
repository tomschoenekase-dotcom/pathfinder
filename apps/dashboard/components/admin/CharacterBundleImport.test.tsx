/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  refresh: vi.fn(),
  randomUUID: vi.fn(() => 'request-stable-1'),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { CharacterBundleImport } from './CharacterBundleImport'

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText('Tenant scope'), { target: { value: 'tenant-1' } })
  fireEvent.change(screen.getByLabelText('Venue scope'), { target: { value: 'venue-1' } })
  fireEvent.change(screen.getByLabelText('Review brief'), {
    target: { value: 'Inspect this candidate.' },
  })
  fireEvent.change(screen.getByLabelText('Why this candidate'), {
    target: { value: 'Approved source.' },
  })
}

function chooseFile(name = 'candidate.character.json', bytes = 'bundle') {
  const file = new File([bytes], name, { type: 'application/json' })
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [file] },
  })
  return file
}

function successfulResponse() {
  return Promise.resolve(
    new Response(JSON.stringify({ displayName: 'Mochi', briefId: 'brief-1' }), { status: 201 }),
  )
}

function submitForm() {
  fireEvent.submit(
    screen.getByRole('button', { name: /create review candidate/i }).closest('form')!,
  )
}

describe('CharacterBundleImport request lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = mocks.fetch as typeof fetch
    mocks.fetch.mockResolvedValue(successfulResponse())
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: mocks.randomUUID,
    })
  })

  afterEach(() => cleanup())

  it('submits file metadata and selected provenance, then refreshes after success', async () => {
    render(<CharacterBundleImport />)
    fillRequiredFields()
    chooseFile()
    fireEvent.change(screen.getByLabelText('Source record'), { target: { value: 'IMPORTED' } })
    submitForm()

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
    const request = mocks.fetch.mock.calls[0]![1] as RequestInit
    const body = request.body as FormData
    expect(body.get('tenantId')).toBe('tenant-1')
    expect(body.get('venueId')).toBe('venue-1')
    expect(body.get('sourceProvenance')).toBe('IMPORTED')
    expect(body.get('requestId')).toBe('request-stable-1')
    expect(body.get('bundle')).toBeInstanceOf(File)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('status')).textContent).toMatch(/ready for founder review/i)
  })

  it('reuses the same request id when a failed submission is retried', async () => {
    mocks.fetch
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce(successfulResponse())
    render(<CharacterBundleImport />)
    fillRequiredFields()
    chooseFile()
    submitForm()
    await screen.findByRole('alert')
    submitForm()
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
    const first = (mocks.fetch.mock.calls[0]![1] as RequestInit).body as FormData
    const second = (mocks.fetch.mock.calls[1]![1] as RequestInit).body as FormData
    expect(first.get('requestId')).toBe('request-stable-1')
    expect(second.get('requestId')).toBe('request-stable-1')
  })

  it('resets the idempotency request when the input changes', async () => {
    render(<CharacterBundleImport />)
    fillRequiredFields()
    chooseFile()
    submitForm()
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Review brief'), { target: { value: 'Changed brief.' } })
    chooseFile('replacement.character.json')
    submitForm()
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
    expect((mocks.fetch.mock.calls[1]![1].body as FormData).get('requestId')).toBe(
      'request-stable-1',
    )
    expect(mocks.randomUUID).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed file names before making a request', async () => {
    render(<CharacterBundleImport />)
    fillRequiredFields()
    chooseFile('candidate.json')
    submitForm()
    expect((await screen.findByRole('alert')).textContent).toMatch(/\.character\.json/i)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('disables all form controls while the request is pending', async () => {
    let resolve!: (value: Response) => void
    mocks.fetch.mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r
      }),
    )
    render(<CharacterBundleImport />)
    fillRequiredFields()
    chooseFile()
    submitForm()
    await screen.findByRole('button', { name: /importing bundle/i })
    expect(screen.getByLabelText('Tenant scope').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Venue scope').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Source record').matches(':disabled')).toBe(true)
    expect(document.querySelector('input[type="file"]')?.matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Review brief').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Why this candidate').matches(':disabled')).toBe(true)
    resolve(new Response(JSON.stringify({ displayName: 'Mochi' }), { status: 201 }))
  })
})
