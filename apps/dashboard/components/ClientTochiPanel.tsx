'use client'

import type { FormEvent, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { Flame, Minus, Send, X } from 'lucide-react'

import styles from './ClientTochiPanel.module.css'

type NavigateAction = {
  type: 'navigate'
  href: string
  label: string
}

export type ClientTochiHandoffPreview = {
  previewId: string
  category:
    | 'CONTENT_CORRECTION'
    | 'OPERATIONAL_UPDATE'
    | 'BRANDING'
    | 'EXPERIENCE_BEHAVIOR'
    | 'ACCESSIBILITY'
    | 'GENERAL'
  summary: string
  requestedOutcome: string
  relevantFeature?: string
}

type HandoffAction = {
  type: 'preview-support-handoff'
  preview: ClientTochiHandoffPreview
}

function HandoffPreviewControls({
  preview,
  confirming,
  onConfirm,
  onDismiss,
}: {
  preview: ClientTochiHandoffPreview
  confirming: boolean
  onConfirm: (preview: ClientTochiHandoffPreview) => void
  onDismiss: (previewId: string) => void
}) {
  return (
    <section className={styles.handoffPreview} aria-label="Request preview">
      <strong>{preview.summary}</strong>
      <p>{preview.requestedOutcome}</p>
      <div className={styles.handoffActions}>
        <button
          type="button"
          className={styles.confirmButton}
          disabled={confirming}
          onClick={() => onConfirm(preview)}
        >
          {confirming ? 'Sending…' : 'Confirm and send'}
        </button>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={() => onDismiss(preview.previewId)}
        >
          Not now
        </button>
      </div>
    </section>
  )
}

export type ClientTochiReply = {
  id: string
  answer: string
  action?: NavigateAction | HandoffAction
}

export type ClientTochiMessage = {
  id: string
  role: 'user' | 'assistant'
  body: string
  action?: ClientTochiReply['action']
}

export type ClientTochiPanelProps = {
  enabled: boolean
  minimized?: boolean
  initialOpen?: boolean
  initialMessages?: ClientTochiMessage[]
  venueName?: string
  venues?: Array<{ id: string; name: string }>
  selectedVenueId?: string
  presence?: ReactNode
  helpHref?: string
  onOpened?: () => void | Promise<void>
  onVenueChange?: (venueId: string) => Promise<void>
  onSend: (message: string) => Promise<ClientTochiReply>
  onConfirmHandoff: (preview: ClientTochiHandoffPreview) => Promise<{ requestId: string }>
  onMinimize: () => Promise<void>
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute('aria-hidden') !== 'true')
}

export function ClientTochiPanel({
  enabled,
  minimized = false,
  initialOpen = false,
  initialMessages = [],
  venueName,
  venues = [],
  selectedVenueId,
  presence,
  helpHref = '/support',
  onOpened,
  onVenueChange,
  onSend,
  onConfirmHandoff,
  onMinimize,
}: ClientTochiPanelProps) {
  const [open, setOpen] = useState(initialOpen)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ClientTochiMessage[]>(initialMessages)
  const [sending, setSending] = useState(false)
  const [confirmingPreviewId, setConfirmingPreviewId] = useState<string | null>(null)
  const [switchingVenue, setSwitchingVenue] = useState(false)
  const [dismissedPreviewIds, setDismissedPreviewIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const statusId = useId()

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const trigger = triggerRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel?.querySelector<HTMLTextAreaElement>('textarea')?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = focusableElements(panel)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      trigger?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || !stickToBottomRef.current) return
    const container = messagesRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [error, messages, open, sending])

  if (!enabled) return null

  async function openPanel() {
    setOpen(true)
    setError(null)
    try {
      await onOpened?.()
    } catch {
      // Opening analytics are best-effort. The optional assistant remains usable.
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || sending) return

    const userMessage: ClientTochiMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      body: message,
    }
    setMessages((current) => [...current, userMessage])
    setDraft('')
    setSending(true)
    setError(null)
    try {
      const reply = await onSend(message)
      setMessages((current) => [
        ...current,
        { id: reply.id, role: 'assistant', body: reply.answer, action: reply.action },
      ])
    } catch {
      setError(
        'I could not answer that right now. Your portal still works normally, and Help & changes is available.',
      )
    } finally {
      setSending(false)
    }
  }

  async function switchVenue(venueId: string) {
    if (!onVenueChange || venueId === selectedVenueId) return
    setSwitchingVenue(true)
    setError(null)
    try {
      await onVenueChange(venueId)
    } catch {
      setError('I could not switch venue context. No message or request was sent.')
    } finally {
      setSwitchingVenue(false)
    }
  }

  async function confirmHandoff(preview: ClientTochiHandoffPreview) {
    setConfirmingPreviewId(preview.previewId)
    setError(null)
    try {
      await onConfirmHandoff(preview)
      setDismissedPreviewIds((current) => new Set(current).add(preview.previewId))
      setMessages((current) => [
        ...current,
        {
          id: `handoff-${preview.previewId}`,
          role: 'assistant',
          body: 'Your request was sent to the Torchiko team for review. You can follow it in Help & changes.',
          action: { type: 'navigate', href: helpHref, label: 'Open Help & changes' },
        },
      ])
    } catch {
      setError(
        'The request was not confirmed. Nothing new was submitted. Please try again or use Help & changes.',
      )
    } finally {
      setConfirmingPreviewId(null)
    }
  }

  async function minimizeTochi() {
    setError(null)
    try {
      await onMinimize()
      setOpen(false)
    } catch {
      setError('I could not save the minimized view. You can still close this panel normally.')
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.launcher} ${minimized ? styles.launcherCompact : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => void openPanel()}
      >
        <span className={styles.launcherMark} aria-hidden="true">
          <Flame size={16} strokeWidth={2.2} />
        </span>
        {minimized ? 'Tochi' : 'Ask Tochi'}
      </button>

      {open ? (
        <>
          <button
            type="button"
            className={styles.backdrop}
            aria-label="Close Ask Tochi"
            onClick={() => setOpen(false)}
          />
          <aside
            ref={panelRef}
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
          >
            <header className={styles.header}>
              <div>
                <p className={styles.eyebrow}>Private client help</p>
                <h2 id={headingId} className={styles.title}>
                  Ask Tochi
                </h2>
                <p className={styles.subtitle}>
                  Portal guidance{venueName ? ` for ${venueName}` : ''}. Important actions stay
                  available normally.
                </p>
                {venues.length > 1 && selectedVenueId ? (
                  <label className={styles.venueSelector}>
                    <span>Venue context</span>
                    <select
                      value={selectedVenueId}
                      disabled={sending || switchingVenue}
                      onChange={(event) => void switchVenue(event.target.value)}
                    >
                      {venues.map((venue) => (
                        <option key={venue.id} value={venue.id}>
                          {venue.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <div className={styles.headerActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Minimize Tochi"
                  onClick={() => void minimizeTochi()}
                >
                  <Minus size={19} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.closeButton}
                  aria-label="Close Ask Tochi"
                  onClick={() => setOpen(false)}
                >
                  <X size={20} aria-hidden="true" />
                </button>
              </div>
            </header>

            <div
              ref={messagesRef}
              className={styles.messages}
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              onScroll={(event) => {
                const target = event.currentTarget
                stickToBottomRef.current =
                  target.scrollHeight - target.scrollTop - target.clientHeight < 80
              }}
            >
              <div className={styles.intro}>
                <div className={styles.presenceSlot} aria-hidden={presence ? undefined : 'true'}>
                  {presence ?? <Flame size={30} color="#f2a65a" aria-hidden="true" />}
                </div>
                <p>
                  I can explain uploads, current setup, and Venue Bot settings. For bigger changes,
                  I can prepare a request for your confirmation.
                </p>
              </div>

              <ol className={styles.messageList}>
                {messages.map((message) => (
                  <li
                    key={message.id}
                    className={`${styles.message} ${
                      message.role === 'assistant' ? styles.assistantMessage : styles.userMessage
                    }`}
                  >
                    <span className={styles.messageLabel}>
                      {message.role === 'assistant' ? 'Tochi' : 'You'}
                    </span>
                    {message.body}
                    {message.action?.type === 'navigate' ? (
                      <div className={styles.actionRow}>
                        <Link className={styles.routeLink} href={message.action.href}>
                          {message.action.label}
                        </Link>
                      </div>
                    ) : null}
                    {message.action?.type === 'preview-support-handoff' &&
                    !dismissedPreviewIds.has(message.action.preview.previewId) ? (
                      <HandoffPreviewControls
                        preview={message.action.preview}
                        confirming={confirmingPreviewId === message.action.preview.previewId}
                        onConfirm={(preview) => void confirmHandoff(preview)}
                        onDismiss={(previewId) =>
                          setDismissedPreviewIds((current) => new Set(current).add(previewId))
                        }
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
              {sending ? (
                <p id={statusId} className={styles.status} role="status">
                  Tochi is checking the client-visible information…
                </p>
              ) : null}
              {error ? (
                <p className={styles.error} role="alert">
                  {error} <Link href={helpHref}>Open Help & changes</Link>
                </p>
              ) : null}
            </div>

            <form className={styles.composer} onSubmit={(event) => void submit(event)}>
              <div className={styles.composerRow}>
                <label className="sr-only" htmlFor={`${headingId}-message`}>
                  Message Tochi
                </label>
                <textarea
                  id={`${headingId}-message`}
                  className={styles.input}
                  value={draft}
                  maxLength={2_000}
                  rows={1}
                  placeholder="Ask about your setup or Venue Bot"
                  aria-describedby={sending ? statusId : undefined}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button
                  type="submit"
                  className={styles.sendButton}
                  aria-label="Send message"
                  disabled={sending || draft.trim().length === 0}
                >
                  <Send size={18} aria-hidden="true" />
                </button>
              </div>
              <p className={styles.privacy}>
                Tochi uses only client-visible Torchiko information. Review any request before it is
                sent.
              </p>
            </form>
          </aside>
        </>
      ) : null}
    </>
  )
}
