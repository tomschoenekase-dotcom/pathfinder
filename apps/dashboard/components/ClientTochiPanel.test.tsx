/* @vitest-environment jsdom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClientTochiPanel, type ClientTochiReply } from './ClientTochiPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(() => cleanup())

const navigateReply: ClientTochiReply = {
  id: 'reply-1',
  answer: 'Open Information to review the files already received.',
  action: { type: 'navigate', href: '/information', label: 'Open Information' },
}

describe('ClientTochiPanel', () => {
  it('keeps inline route actions large enough for touch use', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'components/ClientTochiPanel.module.css'),
      'utf8',
    )
    expect(css).toMatch(/\.routeLink\s*\{[\s\S]*?min-height:\s*2\.75rem;/u)
  })

  it('renders nothing when the client has disabled Tochi', () => {
    const { container } = render(
      <ClientTochiPanel
        enabled={false}
        onSend={vi.fn()}
        onConfirmHandoff={vi.fn()}
        onMinimize={vi.fn()}
      />,
    )
    expect(container.childElementCount).toBe(0)
  })

  it('opens as a labelled modal, focuses the composer, closes on Escape, and restores focus', async () => {
    render(
      <ClientTochiPanel
        enabled
        venueName="City Museum"
        onSend={vi.fn()}
        onConfirmHandoff={vi.fn()}
        onMinimize={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Ask Tochi' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Ask Tochi' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message Tochi' }))
    expect(screen.getByText(/Important actions stay available normally/u)).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps opening usable when best-effort opened telemetry fails', async () => {
    render(
      <ClientTochiPanel
        enabled
        onOpened={vi.fn().mockRejectedValue(new Error('analytics unavailable'))}
        onSend={vi.fn()}
        onConfirmHandoff={vi.fn()}
        onMinimize={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ask Tochi' }))
    expect(await screen.findByRole('dialog', { name: 'Ask Tochi' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('minimizes without disabling assistance', async () => {
    const onMinimize = vi.fn().mockResolvedValue(undefined)
    render(
      <ClientTochiPanel
        enabled
        initialOpen
        onSend={vi.fn()}
        onConfirmHandoff={vi.fn()}
        onMinimize={onMinimize}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Tochi' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onMinimize).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Ask Tochi' })).toBeTruthy()
  })

  it('sends a bounded message and renders only the server-owned navigation link', async () => {
    const onSend = vi.fn().mockResolvedValue(navigateReply)
    render(
      <ClientTochiPanel
        enabled
        initialOpen
        onSend={onSend}
        onConfirmHandoff={vi.fn()}
        onMinimize={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Message Tochi' }), {
      target: { value: 'Did you receive my brochure?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText(navigateReply.answer)).toBeTruthy()
    expect(onSend).toHaveBeenCalledWith('Did you receive my brochure?')
    expect(screen.getByRole('link', { name: 'Open Information' }).getAttribute('href')).toBe(
      '/information',
    )
  })

  it('previews a handoff and does not submit until the client confirms', async () => {
    const preview = {
      previewId: 'preview-1',
      category: 'EXPERIENCE_BEHAVIOR' as const,
      summary: 'Review a POS integration',
      requestedOutcome: 'Assess ticket purchase support and required security work.',
    }
    const onConfirmHandoff = vi.fn().mockResolvedValue({ requestId: 'request-1' })
    render(
      <ClientTochiPanel
        enabled
        initialOpen
        onSend={vi.fn().mockResolvedValue({
          id: 'reply-1',
          answer: 'I can prepare that request. Nothing has been submitted.',
          action: { type: 'preview-support-handoff', preview },
        })}
        onConfirmHandoff={onConfirmHandoff}
        onMinimize={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Message Tochi' }), {
      target: { value: 'Add POS ticket purchasing.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('region', { name: 'Request preview' })).toBeTruthy()
    expect(onConfirmHandoff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }))
    expect(await screen.findByText(/sent to the Torchiko team for review/u)).toBeTruthy()
    expect(onConfirmHandoff).toHaveBeenCalledWith(preview)
  })

  it('states that nothing was submitted when handoff confirmation fails', async () => {
    const preview = {
      previewId: 'preview-1',
      category: 'GENERAL' as const,
      summary: 'Review a technical issue',
      requestedOutcome: 'Investigate the requested behavior.',
    }
    render(
      <ClientTochiPanel
        enabled
        initialOpen
        onSend={vi.fn().mockResolvedValue({
          id: 'reply-1',
          answer: 'Review this request before sending.',
          action: { type: 'preview-support-handoff', preview },
        })}
        onConfirmHandoff={vi.fn().mockRejectedValue(new Error('offline'))}
        onMinimize={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Message Tochi' }), {
      target: { value: 'Please report this.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Nothing new was submitted')
  })

  it('fails independently while keeping the normal help route available', async () => {
    render(
      <ClientTochiPanel
        enabled
        initialOpen
        onSend={vi.fn().mockRejectedValue(new Error('provider down'))}
        onConfirmHandoff={vi.fn()}
        onMinimize={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Tochi' }), {
      target: { value: 'What should I do next?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Your portal still works normally',
    )
    expect(screen.getByRole('link', { name: 'Open Help & changes' }).getAttribute('href')).toBe(
      '/support',
    )
  })

  it('keeps a long conversation pinned to the latest reply when the reader is at the bottom', async () => {
    render(
      <ClientTochiPanel
        enabled
        initialOpen
        initialMessages={Array.from({ length: 12 }, (_, index) => ({
          id: `message-${index}`,
          role: index % 2 ? ('assistant' as const) : ('user' as const),
          body: `Earlier message ${index + 1}`,
        }))}
        onSend={vi.fn().mockResolvedValue({ id: 'latest', answer: 'Latest reply' })}
        onConfirmHandoff={vi.fn()}
        onMinimize={vi.fn()}
      />,
    )
    const log = screen.getByRole('log')
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Tochi' }), {
      target: { value: 'One more question' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Latest reply')
    expect(log.scrollTop).toBe(1200)
  })
})
