/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { ExternalCredentialLifecycle } from './ExternalCredentialLifecycleWorkspace'

const credential = {
  id: 'credential-a',
  venueId: 'venue-a',
  kind: 'PARTNER_READ_API' as const,
  label: 'Museum partner',
  capabilities: ['venues:read'],
  secretPrefix: 'pf_read_visible',
  enabled: false,
  expiresAt: null,
  revokedAt: null,
  updatedAt: new Date('2026-08-12T12:00:00Z'),
}

describe('external credential lifecycle workspace', () => {
  const issue = vi.fn()
  const rotate = vi.fn()
  const revoke = vi.fn()
  const activate = vi.fn()
  const refresh = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    issue.mockResolvedValue({
      credential,
      plaintextSecret: 'pf_read_ONE_TIME_SECRET',
      replayed: false,
    })
    rotate.mockResolvedValue({
      credential: { ...credential, id: 'credential-b', secretPrefix: 'pf_read_replacement' },
      plaintextSecret: 'pf_read_ROTATED_SECRET',
      replayed: false,
    })
    revoke.mockResolvedValue({
      credential: { ...credential, revokedAt: new Date('2026-08-12T13:00:00Z') },
      plaintextSecret: null,
      replayed: false,
    })
    activate.mockResolvedValue({
      credential: { ...credential, enabled: true },
      plaintextSecret: null,
      replayed: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function renderWorkspace(
    selected: React.ComponentProps<typeof ExternalCredentialLifecycle>['credential'] = credential,
  ) {
    return render(
      <ExternalCredentialLifecycle
        tenantId="tenant-a"
        clientName="Museum Group"
        venues={[{ id: 'venue-a', name: 'East Museum' }]}
        credential={selected}
        issue={issue}
        rotate={rotate}
        revoke={revoke}
        activate={activate}
        onRefresh={refresh}
      />,
    )
  }

  function completeIssueForm() {
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Partner reader' } })
    fireEvent.click(screen.getByLabelText('venues:read'))
    fireEvent.click(screen.getByLabelText(/I confirmed the client/))
  }

  it('issues disabled metadata once and keeps the one-time secret ephemeral', async () => {
    renderWorkspace()
    completeIssueForm()
    const button = screen.getByRole('button', { name: 'Issue disabled credential' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(await screen.findByRole('heading', { name: 'Copy this secret now' })).toBeTruthy()
    expect(issue).toHaveBeenCalledOnce()
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        clientId: 'tenant-a',
        venueId: null,
        kind: 'PARTNER_READ_API',
        capabilities: ['venues:read'],
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      }),
    )
    expect(screen.getByText('pf_read_ONE_TIME_SECRET')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy secret' }))
    await screen.findByText(/Clipboard contents remain sensitive/)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('pf_read_ONE_TIME_SECRET')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss permanently' }))
    expect(screen.queryByText('pf_read_ONE_TIME_SECRET')).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'External access is capability-gated' }),
    )
  })

  it('reconciles an ambiguous issue with the same operation and never invents a replay secret', async () => {
    issue
      .mockRejectedValueOnce(new Error('SECRET_SENTINEL provider response lost'))
      .mockResolvedValueOnce({ credential, plaintextSecret: null, replayed: true })
    renderWorkspace()
    completeIssueForm()
    fireEvent.click(screen.getByRole('button', { name: 'Issue disabled credential' }))
    expect(await screen.findByText(/result is uncertain/i)).toBeTruthy()
    expect(document.body.textContent).not.toContain('SECRET_SENTINEL')
    const operationId = issue.mock.calls[0]?.[0]?.operationId

    fireEvent.click(screen.getByRole('button', { name: 'Check issue result' }))
    expect(
      await screen.findByRole('heading', { name: 'Secret is no longer available' }),
    ).toBeTruthy()
    expect(issue.mock.calls[1]?.[0]?.operationId).toBe(operationId)
    expect(screen.queryByRole('button', { name: 'Copy secret' })).toBeNull()
    expect(document.body.textContent).not.toContain('pf_read_ONE_TIME_SECRET')
  })

  it('locks sibling actions after rotation and preserves exact scope and CAS', async () => {
    renderWorkspace()
    fireEvent.click(screen.getByLabelText(/confirmed the prefix/))
    fireEvent.click(screen.getByLabelText(/revocation is permanent/))
    const rotateButton = screen.getByRole('button', { name: 'Rotate credential' })
    const revokeButton = screen.getByRole('button', { name: 'Revoke permanently' })
    fireEvent.click(rotateButton)
    fireEvent.click(revokeButton)

    expect(await screen.findByText('pf_read_ROTATED_SECRET')).toBeTruthy()
    expect(rotate).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
    expect(rotate).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      clientId: 'tenant-a',
      venueId: 'venue-a',
      credentialId: 'credential-a',
      expectedUpdatedAt: '2026-08-12T12:00:00.000Z',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    })
    expect(
      (screen.getByRole('button', { name: 'Revoke permanently' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Issue disabled credential' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('requires deliberate revocation confirmation and sends only an allowlisted reason', async () => {
    renderWorkspace()
    const button = screen.getByRole('button', { name: 'Revoke permanently' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'POSSIBLE_COMPROMISE' } })
    fireEvent.click(screen.getByLabelText(/revocation is permanent/))
    fireEvent.click(button)

    await screen.findByText(/credential was revoked and remains disabled/i)
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'POSSIBLE_COMPROMISE' }),
    )
  })

  it('does not interpolate an unknown stored capability into lifecycle confirmations', () => {
    renderWorkspace({
      ...credential,
      capabilities: ['provider:SECRET_SENTINEL'],
    })
    expect(screen.getByText(/Capabilities: Capability unavailable/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('provider:SECRET_SENTINEL')
  })

  it('purges an ephemeral secret immediately when the selected scope changes', async () => {
    const view = renderWorkspace()
    completeIssueForm()
    fireEvent.click(screen.getByRole('button', { name: 'Issue disabled credential' }))
    await screen.findByText('pf_read_ONE_TIME_SECRET')

    view.rerender(
      <ExternalCredentialLifecycle
        tenantId="tenant-b"
        clientName="Other client"
        venues={[]}
        credential={null}
        issue={issue}
        rotate={rotate}
        revoke={revoke}
        activate={activate}
      />,
    )
    expect(screen.queryByText('pf_read_ONE_TIME_SECRET')).toBeNull()
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('')
  })

  it('ignores a late secret and error after client scope changes', async () => {
    let resolveIssue:
      | ((result: {
          credential: typeof credential
          plaintextSecret: string | null
          replayed: boolean
        }) => void)
      | undefined
    issue.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveIssue = resolve
      }),
    )
    const view = renderWorkspace()
    completeIssueForm()
    fireEvent.click(screen.getByRole('button', { name: 'Issue disabled credential' }))

    view.rerender(
      <ExternalCredentialLifecycle
        tenantId="tenant-b"
        clientName="Other client"
        venues={[]}
        credential={null}
        issue={issue}
        rotate={rotate}
        revoke={revoke}
        activate={activate}
      />,
    )
    resolveIssue?.({ credential, plaintextSecret: 'SECRET_SENTINEL_LATE', replayed: false })
    await waitFor(() => expect(screen.queryByText('SECRET_SENTINEL_LATE')).toBeNull())
    expect(screen.queryByText(/result is uncertain/i)).toBeNull()
  })

  it('has no automated accessibility violations in disabled lifecycle state', async () => {
    const { container } = renderWorkspace()
    document.documentElement.lang = 'en'
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations).toEqual([])
  })

  it('activates only a confirmed exact venue MCP bridge credential without returning a secret', async () => {
    const bridgeCredential = {
      ...credential,
      kind: 'MCP' as const,
      label: 'Codex runner',
      capabilities: ['agent-runs:execute'],
      secretPrefix: 'pf_mcp_visible',
    }
    renderWorkspace(bridgeCredential)
    const button = screen.getByRole('button', { name: 'Activate bridge credential' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/verified the venue and the exact capability list/i))
    fireEvent.click(button)
    await screen.findByText(/Bridge credential activated/i)
    expect(activate).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      clientId: 'tenant-a',
      venueId: 'venue-a',
      credentialId: 'credential-a',
      expectedUpdatedAt: '2026-08-12T12:00:00.000Z',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    })
    expect(document.body.textContent).not.toMatch(/pf_mcp_[A-Za-z0-9_-]{20,}/u)
  })
})
