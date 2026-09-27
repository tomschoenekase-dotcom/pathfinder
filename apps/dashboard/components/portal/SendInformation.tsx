'use client'

import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  FileText,
  Link2,
  LoaderCircle,
  NotebookPen,
  RefreshCw,
  UploadCloud,
  X,
} from 'lucide-react'

import { browserUuid } from '../../lib/browser-uuid'
import {
  MAX_INTAKE_FILE_SELECTION,
  SAFE_INTAKE_FILE_TYPES,
  validateIntakeFile,
} from '../../lib/intake-file-identity'
import {
  inferIntakeCategory,
  IntakeTransferError,
  IntakeTransferSuperseded,
  transferIntakeFile,
  type IntakeTransferApi,
  type IntakeTransferAttempt,
} from '../../lib/intake-file-transfer'
import { useTRPCClient } from '../../lib/trpc'
import { useIntakeTransferApi } from '../../lib/use-intake-transfer-api'
import {
  PortalNotice,
  PortalSection,
  portalButtonPrimary,
  portalButtonSecondary,
  portalFocus,
  portalInput,
  portalTextLink,
} from './PortalPrimitives'

export type SendInformationApi = IntakeTransferApi & {
  createProposal: (
    input:
      | {
          venueId: string
          requestId: string
          kind: 'WEBSITE'
          displayName: string
          websiteUri: string
        }
      | { venueId: string; requestId: string; kind: 'NOTES'; notes: string },
  ) => Promise<unknown>
}

type FileItem = {
  localId: string
  file: File
  phase: 'ready' | 'sending' | 'sent' | 'checking' | 'failed' | 'invalid' | 'rejected'
  error: string | null
  progress: number | null
  attempt?: IntakeTransferAttempt
}

type TextPart = {
  open: boolean
  value: string
  requestId: string
  status: 'idle' | 'failed'
  error: string | null
}

const emptyPart = (): TextPart => ({
  open: false,
  value: '',
  requestId: browserUuid(),
  status: 'idle',
  error: null,
})

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** Accepts "maplehollow.org/hours" as readily as a full address. */
export function normalizeWebsiteLink(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname.includes('.') || url.username || url.password) return null
    return url.toString().slice(0, 2000)
  } catch {
    return null
  }
}

function FileThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  return url ? (
    <span
      aria-hidden="true"
      className="h-10 w-10 shrink-0 rounded-md border border-tk-rule bg-cover bg-center"
      style={{ backgroundImage: `url("${url}")` }}
    />
  ) : (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-tk-rule bg-tk-paper text-tk-soft"
    >
      <FileText className="h-4 w-4" />
    </span>
  )
}

function useSendInformationApi(): SendInformationApi {
  const client = useTRPCClient()
  const transfer = useIntakeTransferApi()
  return useMemo(
    () => ({
      ...transfer,
      createProposal: (input) => client.intake.createProposal.mutate(input),
    }),
    [client, transfer],
  )
}

export function SendInformation(props: { venueId: string; canSendLinksAndNotes: boolean }) {
  const api = useSendInformationApi()
  const router = useRouter()
  return <SendInformationView {...props} api={api} onSent={() => router.refresh()} />
}

export function SendInformationView({
  venueId,
  canSendLinksAndNotes,
  api,
  onSent,
}: {
  venueId: string
  canSendLinksAndNotes: boolean
  api: SendInformationApi
  onSent?: () => void
}) {
  const inputId = useId()
  const hintId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<FileItem[]>([])
  const [link, setLink] = useState<TextPart>(emptyPart)
  const [note, setNote] = useState<TextPart>(emptyPart)
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    tone: 'success' | 'attention' | 'error'
    text: string
  } | null>(null)
  const sendingRef = useRef(false)
  const scopeRef = useRef(venueId)
  const generationRef = useRef(0)
  if (scopeRef.current !== venueId) {
    scopeRef.current = venueId
    generationRef.current += 1
  }

  useEffect(() => {
    setFiles([])
    setLink(emptyPart())
    setNote(emptyPart())
    setResult(null)
    setSelectionError(null)
  }, [venueId])

  function patchFile(localId: string, patch: Partial<FileItem>) {
    setFiles((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    )
  }

  function addFiles(list: FileList | null) {
    if (!list?.length) return
    const selected = Array.from(list)
    const pending = files.filter((item) => item.phase !== 'sent' && item.phase !== 'checking')
    if (pending.length + selected.length > MAX_INTAKE_FILE_SELECTION) {
      setSelectionError(`Choose up to ${MAX_INTAKE_FILE_SELECTION} files at a time.`)
      return
    }
    const known = new Set(
      files.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`),
    )
    const next: FileItem[] = selected.map((file) => {
      const key = `${file.name}:${file.size}:${file.lastModified}`
      const error = known.has(key) ? 'This file is already in the list.' : validateIntakeFile(file)
      known.add(key)
      return {
        localId: browserUuid(),
        file,
        phase: error ? 'invalid' : 'ready',
        error,
        progress: null,
      }
    })
    setSelectionError(null)
    setResult(null)
    // A new selection starts a new batch; confirmed items from the last one step aside.
    setFiles((current) => [
      ...current.filter((item) => item.phase !== 'sent' && item.phase !== 'checking'),
      ...next,
    ])
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  const normalizedLink = normalizeWebsiteLink(link.value)
  const linkInvalid = link.open && link.value.trim() !== '' && !normalizedLink
  const pendingFiles = files.filter((item) => ['ready', 'failed'].includes(item.phase))
  const hasLink = link.open && Boolean(normalizedLink)
  const hasNote = note.open && note.value.trim() !== ''
  const somethingToSend = pendingFiles.length > 0 || hasLink || hasNote
  const blockedByRejected = files.some((item) => item.phase === 'rejected')

  async function sendAll() {
    if (sendingRef.current || !somethingToSend || linkInvalid) return
    sendingRef.current = true
    setSending(true)
    setResult(null)
    const scope = venueId
    const generation = generationRef.current
    const isCurrent = () => scopeRef.current === scope && generationRef.current === generation
    let sentFiles = 0
    let pendingChecks = 0
    let fileFailures = 0
    try {
      for (const item of pendingFiles) {
        patchFile(item.localId, { phase: 'sending', error: null, progress: null })
        try {
          const outcome = await transferIntakeFile({
            venueId: scope,
            file: item.file,
            category: inferIntakeCategory(item.file),
            api,
            priorAttempt: item.attempt,
            isCurrent,
            onAttempt: (attempt) => patchFile(item.localId, { attempt }),
            onProgress: (bytes) =>
              patchFile(item.localId, {
                progress: Math.min(100, Math.round((bytes / Math.max(1, item.file.size)) * 100)),
              }),
          })
          if (outcome.kind === 'awaiting-review') {
            sentFiles += 1
            patchFile(item.localId, { phase: 'sent', progress: null })
          } else if (outcome.kind === 'security-pending') {
            pendingChecks += 1
            patchFile(item.localId, { phase: 'checking', progress: null })
          } else {
            fileFailures += 1
            patchFile(item.localId, {
              phase: 'rejected',
              progress: null,
              error: 'Torchiko couldn’t accept this file. Remove it, or choose a different copy.',
            })
          }
        } catch (error) {
          if (error instanceof IntakeTransferSuperseded) return
          fileFailures += 1
          patchFile(item.localId, {
            phase: 'failed',
            progress: null,
            error:
              error instanceof IntakeTransferError
                ? error.message
                : 'This file didn’t reach Torchiko. Check your connection and try again.',
          })
        }
      }
      if (!isCurrent()) return

      // The link and note travel only after every file has gone through, so fixing a file
      // never costs the venue the words they wrote alongside it.
      if (fileFailures > 0) {
        setResult({
          tone: 'error',
          text:
            (sentFiles + pendingChecks > 0
              ? `${sentFiles + pendingChecks} of ${pendingFiles.length} files reached Torchiko. `
              : '') +
            (hasLink || hasNote
              ? 'Your link and note are still here and haven’t been sent yet. Retry the file marked above, or remove it, then send again.'
              : 'Retry the file marked above, or remove it.'),
        })
        return
      }

      let linkSent = false
      let noteSent = false
      let textFailure = false
      if (hasLink && normalizedLink) {
        try {
          await api.createProposal({
            venueId: scope,
            requestId: link.requestId,
            kind: 'WEBSITE',
            displayName: new URL(normalizedLink).hostname.replace(/^www\./u, ''),
            websiteUri: normalizedLink,
          })
          linkSent = true
          if (isCurrent()) setLink(emptyPart())
        } catch {
          textFailure = true
          if (isCurrent())
            setLink((current) => ({
              ...current,
              status: 'failed',
              error: 'This link wasn’t sent. It’s still here—try again.',
            }))
        }
      }
      if (hasNote) {
        try {
          await api.createProposal({
            venueId: scope,
            requestId: note.requestId,
            kind: 'NOTES',
            notes: note.value.trim(),
          })
          noteSent = true
          if (isCurrent()) setNote(emptyPart())
        } catch {
          textFailure = true
          if (isCurrent())
            setNote((current) => ({
              ...current,
              status: 'failed',
              error: 'This note wasn’t sent. Your words are still here—try again.',
            }))
        }
      }
      if (!isCurrent()) return

      const parts = [
        sentFiles + pendingChecks > 0
          ? `${sentFiles + pendingChecks} file${sentFiles + pendingChecks === 1 ? '' : 's'}`
          : null,
        linkSent ? 'your link' : null,
        noteSent ? 'your note' : null,
      ].filter(Boolean) as string[]
      const sentSummary =
        parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
      if (parts.length) onSent?.()
      if (textFailure) {
        setResult({
          tone: 'error',
          text: sentSummary
            ? `Sent ${sentSummary} to Torchiko. Something below didn’t go through yet.`
            : 'That didn’t go through. Nothing was lost—try again.',
        })
      } else {
        setResult({
          tone: pendingChecks > 0 ? 'attention' : 'success',
          text:
            `Sent to Torchiko: ${sentSummary}. We review everything before your visitor guide changes.` +
            (pendingChecks > 0
              ? ' A file is still finishing its safety check—nothing else is needed from you.'
              : ''),
        })
      }
    } finally {
      if (scopeRef.current === scope) {
        sendingRef.current = false
        setSending(false)
      }
    }
  }

  return (
    <PortalSection
      id="send-information-heading"
      title="Send us information"
      description="Photos, documents, a website link or a quick note. We’ll review it before anything in your guide changes."
    >
      <label
        htmlFor={inputId}
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={handleDrop}
        className={`mt-4 flex min-h-[6.5rem] cursor-pointer items-center gap-4 rounded-lg border border-dashed px-4 py-4 transition-colors focus-within:ring-2 focus-within:ring-tk-focus focus-within:ring-offset-2 motion-reduce:transition-none sm:px-5 ${
          dragging
            ? 'border-tk-focus bg-tk-ink-wash'
            : 'border-tk-rule-strong bg-tk-paper/60 hover:border-tk-ink hover:bg-white'
        }`}
      >
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          multiple
          accept={SAFE_INTAKE_FILE_TYPES.join(',')}
          aria-describedby={hintId}
          disabled={sending}
          className="sr-only"
          onChange={(event) => {
            addFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
        <UploadCloud className="h-7 w-7 shrink-0 text-tk-ink" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-[0.95rem] font-semibold text-tk-ink">
            <span className="hidden [@media(pointer:fine)]:inline">
              {dragging ? 'Drop to add these files' : 'Drag files here or click to choose'}
            </span>
            <span className="[@media(pointer:fine)]:hidden">Tap to choose photos or files</span>
          </span>
          <span id={hintId} className="mt-0.5 block text-sm text-tk-soft">
            Photos, PDFs, videos or audio · up to {MAX_INTAKE_FILE_SELECTION} at a time
          </span>
        </span>
      </label>
      {selectionError ? (
        <p role="alert" className="mt-2 text-sm font-medium text-tk-danger">
          {selectionError}
        </p>
      ) : null}

      {files.length ? (
        <ul className="mt-3 divide-y divide-tk-rule rounded-lg border border-tk-rule bg-white">
          {files.map((item) => {
            const busy = item.phase === 'sending'
            const statusText =
              item.phase === 'ready'
                ? formatBytes(item.file.size)
                : item.phase === 'sending'
                  ? item.progress !== null
                    ? `Sending · ${item.progress}%`
                    : 'Sending…'
                  : item.phase === 'sent'
                    ? 'Sent to Torchiko'
                    : item.phase === 'checking'
                      ? 'Sent · finishing safety check'
                      : (item.error ?? 'Needs attention')
            return (
              <li key={item.localId} className="flex items-center gap-3 px-3 py-2.5">
                <FileThumb file={item.file} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-tk-ink" title={item.file.name}>
                    {item.file.name}
                  </p>
                  <p
                    className={`flex items-center gap-1.5 text-[0.8rem] leading-5 ${
                      ['failed', 'invalid', 'rejected'].includes(item.phase)
                        ? 'text-tk-danger'
                        : item.phase === 'sent' || item.phase === 'checking'
                          ? 'text-tk-moss'
                          : 'text-tk-soft'
                    }`}
                  >
                    {busy ? (
                      <LoaderCircle
                        className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : item.phase === 'sent' || item.phase === 'checking' ? (
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : ['failed', 'invalid', 'rejected'].includes(item.phase) ? (
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : null}
                    <span>{statusText}</span>
                  </p>
                </div>
                {item.phase === 'failed' ? (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => void sendAll()}
                    className={`inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-tk-focus hover:bg-tk-ink-wash ${portalFocus}`}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
                  </button>
                ) : null}
                {!busy ? (
                  <button
                    type="button"
                    disabled={sending}
                    aria-label={
                      item.phase === 'sent' || item.phase === 'checking'
                        ? `Dismiss ${item.file.name}`
                        : `Remove ${item.file.name}`
                    }
                    onClick={() =>
                      setFiles((current) =>
                        current.filter((candidate) => candidate.localId !== item.localId),
                      )
                    }
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-tk-soft hover:bg-tk-ink-wash hover:text-tk-ink ${portalFocus}`}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {canSendLinksAndNotes ? (
        <>
          {link.open ? (
            <div className="mt-3">
              <label htmlFor={`${inputId}-link`} className="text-sm font-semibold text-tk-ink">
                Website link
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id={`${inputId}-link`}
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="maplehollow.org/visit"
                  value={link.value}
                  disabled={sending}
                  aria-invalid={linkInvalid || link.status === 'failed'}
                  aria-describedby={`${inputId}-link-help`}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setResult(null)
                    setLink((current) => ({
                      ...current,
                      value,
                      status: 'idle',
                      error: null,
                      // Different words are a different submission; retries of the same words reuse it.
                      requestId: value === current.value ? current.requestId : browserUuid(),
                    }))
                  }}
                  className={portalInput}
                />
                <button
                  type="button"
                  aria-label="Remove link"
                  disabled={sending}
                  onClick={() => setLink(emptyPart())}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-tk-soft hover:bg-tk-ink-wash hover:text-tk-ink ${portalFocus}`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <p
                id={`${inputId}-link-help`}
                className={`mt-1 text-[0.8rem] ${linkInvalid || link.error ? 'font-medium text-tk-danger' : 'text-tk-soft'}`}
              >
                {linkInvalid
                  ? 'That doesn’t look like a web address yet.'
                  : (link.error ?? 'A page with hours, events, maps or anything else useful.')}
              </p>
            </div>
          ) : null}
          {note.open ? (
            <div className="mt-3">
              <label htmlFor={`${inputId}-note`} className="text-sm font-semibold text-tk-ink">
                Note
              </label>
              <div className="mt-1.5 flex gap-2">
                <textarea
                  id={`${inputId}-note`}
                  rows={3}
                  maxLength={20_000}
                  value={note.value}
                  disabled={sending}
                  placeholder="For example: we’re now open 9–5 daily through October."
                  aria-invalid={note.status === 'failed'}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setResult(null)
                    setNote((current) => ({
                      ...current,
                      value,
                      status: 'idle',
                      error: null,
                      requestId: value === current.value ? current.requestId : browserUuid(),
                    }))
                  }}
                  className={`${portalInput} min-h-[5.5rem] py-2.5 leading-6`}
                />
                <button
                  type="button"
                  aria-label="Remove note"
                  disabled={sending}
                  onClick={() => setNote(emptyPart())}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-tk-soft hover:bg-tk-ink-wash hover:text-tk-ink ${portalFocus}`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {note.error ? (
                <p className="mt-1 text-[0.8rem] font-medium text-tk-danger">{note.error}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-center">
        {canSendLinksAndNotes && !link.open ? (
          <button
            type="button"
            disabled={sending}
            onClick={() => setLink((current) => ({ ...current, open: true }))}
            className={portalButtonSecondary}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" /> Add a link
          </button>
        ) : null}
        {canSendLinksAndNotes && !note.open ? (
          <button
            type="button"
            disabled={sending}
            onClick={() => setNote((current) => ({ ...current, open: true }))}
            className={portalButtonSecondary}
          >
            <NotebookPen className="h-4 w-4" aria-hidden="true" /> Write a note
          </button>
        ) : null}
        {somethingToSend || sending ? (
          <button
            type="button"
            onClick={() => void sendAll()}
            disabled={sending || linkInvalid || blockedByRejected}
            className={`${portalButtonPrimary} min-[420px]:ml-auto`}
          >
            {sending ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {sending ? 'Sending…' : 'Send to Torchiko'}
          </button>
        ) : null}
      </div>
      {blockedByRejected ? (
        <p className="mt-2 text-sm text-tk-danger">
          Remove the file Torchiko couldn’t accept to send the rest.
        </p>
      ) : null}
      {!canSendLinksAndNotes ? (
        <p className="mt-3 text-sm leading-6 text-tk-soft">
          Links and notes can be added by a manager or owner on your team.
        </p>
      ) : null}

      <div className="mt-3" aria-live="polite">
        {result ? (
          <PortalNotice tone={result.tone} role={result.tone === 'error' ? 'alert' : 'status'}>
            {result.text}{' '}
            {result.tone !== 'error' ? (
              <Link
                href={`/information?venue=${encodeURIComponent(venueId)}`}
                className={portalTextLink}
              >
                See what you’ve sent
              </Link>
            ) : null}
          </PortalNotice>
        ) : null}
      </div>
    </PortalSection>
  )
}
