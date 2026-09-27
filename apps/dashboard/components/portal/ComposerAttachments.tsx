'use client'

import { useEffect, useId, useState } from 'react'
import { AlertTriangle, FileText, LoaderCircle, Paperclip, RefreshCw, X } from 'lucide-react'

import { browserUuid } from '../../lib/browser-uuid'
import { SAFE_INTAKE_FILE_TYPES, validateIntakeFile } from '../../lib/intake-file-identity'
import {
  inferIntakeCategory,
  IntakeTransferError,
  transferIntakeFile,
  type IntakeTransferApi,
  type IntakeTransferAttempt,
} from '../../lib/intake-file-transfer'
import { portalFocus } from './PortalPrimitives'

export type ComposerAttachment = {
  localId: string
  name: string
  size: number
  file?: File
  /** Set once Torchiko has verified the file and it can travel with a message. */
  intakeUploadId?: string
  phase: 'uploading' | 'ready' | 'checking' | 'failed'
  error: string | null
  attempt?: IntakeTransferAttempt | undefined
}

export type EligibleSupportFile = {
  intakeUploadId: string
  fileName: string
  byteSize: number
}

export const MAX_MESSAGE_ATTACHMENTS = 20

export function readyAttachmentIds(items: ComposerAttachment[]) {
  return items.flatMap((item) =>
    item.phase === 'ready' && item.intakeUploadId ? [item.intakeUploadId] : [],
  )
}

export function attachmentsBlockSending(items: ComposerAttachment[]) {
  return items.some((item) => item.phase !== 'ready')
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Thumb({ file }: { file?: File | undefined }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file?.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
  ) : (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-tk-paper text-tk-soft">
      <FileText className="h-4 w-4" aria-hidden="true" />
    </span>
  )
}

/**
 * Attach a new photo or file straight from the composer. Each file goes through the same
 * checked upload as everything else a venue sends; it can travel with the message only after
 * Torchiko has verified it.
 */
export function ComposerAttachments({
  venueId,
  items,
  onChange,
  disabled,
  api,
  eligible = [],
  eligibleHasMore = false,
  onLoadMoreEligible,
  labelledBy,
}: {
  venueId: string
  items: ComposerAttachment[]
  onChange: (update: (current: ComposerAttachment[]) => ComposerAttachment[]) => void
  disabled: boolean
  api: IntakeTransferApi
  eligible?: EligibleSupportFile[]
  eligibleHasMore?: boolean
  onLoadMoreEligible?: () => void
  labelledBy?: string
}) {
  const inputId = useId()
  const [showEarlier, setShowEarlier] = useState(false)
  const [selectionError, setSelectionError] = useState<string | null>(null)

  function patch(localId: string, change: Partial<ComposerAttachment>) {
    onChange((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
    )
  }

  async function upload(item: ComposerAttachment) {
    if (!item.file) return
    patch(item.localId, { phase: 'uploading', error: null })
    try {
      const outcome = await transferIntakeFile({
        venueId,
        file: item.file,
        category: inferIntakeCategory(item.file),
        api,
        priorAttempt: item.attempt,
        onAttempt: (attempt) => patch(item.localId, { attempt }),
      })
      if (outcome.kind === 'awaiting-review') {
        patch(item.localId, { phase: 'ready', intakeUploadId: outcome.uploadId })
      } else if (outcome.kind === 'security-pending') {
        patch(item.localId, {
          phase: 'checking',
          intakeUploadId: outcome.uploadId,
          error: 'Still finishing a safety check. Check again in a moment, or remove it.',
        })
      } else {
        patch(item.localId, {
          phase: 'failed',
          attempt: undefined,
          error: 'Torchiko couldn’t accept this file. Remove it or choose another.',
        })
      }
    } catch (error) {
      patch(item.localId, {
        phase: 'failed',
        error:
          error instanceof IntakeTransferError
            ? error.message
            : 'This file didn’t upload. Your message is safe—try again.',
      })
    }
  }

  function addFiles(list: FileList | null) {
    if (!list?.length) return
    const selected = Array.from(list)
    if (items.length + selected.length > MAX_MESSAGE_ATTACHMENTS) {
      setSelectionError(`Attach up to ${MAX_MESSAGE_ATTACHMENTS} files to one message.`)
      return
    }
    setSelectionError(null)
    const next = selected.map((file) => {
      const error = validateIntakeFile(file)
      return {
        localId: browserUuid(),
        name: file.name,
        size: file.size,
        file,
        phase: error ? ('failed' as const) : ('uploading' as const),
        error,
      }
    })
    onChange((current) => [...current, ...next])
    for (const item of next) if (!item.error) void upload(item)
  }

  const usable = eligible.filter(
    (file) => !items.some((item) => item.intakeUploadId === file.intakeUploadId),
  )

  return (
    <div>
      {items.length ? (
        <ul className="mb-2 flex flex-col gap-2" aria-label="Attachments">
          {items.map((item) => (
            <li
              key={item.localId}
              className="flex items-center gap-3 rounded-lg border border-tk-rule bg-white px-2.5 py-2"
            >
              <Thumb file={item.file} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={item.name}>
                  {item.name}
                </p>
                <p
                  role="status"
                  className={`flex items-center gap-1.5 text-[0.8rem] leading-5 ${
                    item.phase === 'failed' ? 'text-tk-danger' : 'text-tk-soft'
                  }`}
                >
                  {item.phase === 'uploading' ? (
                    <LoaderCircle
                      className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : item.phase === 'failed' ? (
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : null}
                  {item.phase === 'uploading'
                    ? 'Uploading…'
                    : item.phase === 'ready'
                      ? `${fileSize(item.size)} · ready to send`
                      : (item.error ?? 'Needs attention')}
                </p>
              </div>
              {(item.phase === 'failed' || item.phase === 'checking') && item.file ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void upload(item)}
                  className={`inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-semibold text-tk-focus hover:bg-tk-ink-wash ${portalFocus}`}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  {item.phase === 'checking' ? 'Check again' : 'Retry'}
                </button>
              ) : null}
              {item.phase !== 'uploading' ? (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${item.name}`}
                  onClick={() =>
                    onChange((current) =>
                      current.filter((candidate) => candidate.localId !== item.localId),
                    )
                  }
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-tk-soft hover:bg-tk-ink-wash hover:text-tk-ink ${portalFocus}`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input
          id={inputId}
          type="file"
          multiple
          accept={SAFE_INTAKE_FILE_TYPES.join(',')}
          disabled={disabled}
          className="sr-only"
          aria-describedby={labelledBy}
          onChange={(event) => {
            addFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
        <label
          htmlFor={inputId}
          className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm font-semibold text-tk-ink hover:bg-tk-ink-wash has-[:disabled]:opacity-55 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tk-focus ${
            disabled ? 'pointer-events-none opacity-55' : ''
          }`}
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          Attach photo or file
        </label>
        {(usable.length || eligibleHasMore) && !showEarlier ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowEarlier(true)}
            className={`min-h-11 rounded-md px-1 text-sm text-tk-soft underline underline-offset-4 hover:text-tk-ink ${portalFocus}`}
          >
            Use a file you already sent
          </button>
        ) : null}
      </div>
      {showEarlier ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {usable.length ? (
            <label className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm text-tk-soft">
              Already sent
              <select
                value=""
                disabled={disabled}
                aria-label="Choose a file you already sent"
                onChange={(event) => {
                  const file = usable.find(
                    (candidate) => candidate.intakeUploadId === event.currentTarget.value,
                  )
                  if (!file) return
                  onChange((current) => [
                    ...current,
                    {
                      localId: browserUuid(),
                      name: file.fileName,
                      size: file.byteSize,
                      intakeUploadId: file.intakeUploadId,
                      phase: 'ready',
                      error: null,
                    },
                  ])
                }}
                className={`min-h-11 min-w-0 flex-1 rounded-lg border border-tk-rule-strong bg-white px-2 text-sm text-tk-ink ${portalFocus}`}
              >
                <option value="">Choose a file…</option>
                {usable.map((file) => (
                  <option key={file.intakeUploadId} value={file.intakeUploadId}>
                    {file.fileName} ({fileSize(file.byteSize)})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-sm text-tk-soft">No earlier files are ready to attach yet.</p>
          )}
          {eligibleHasMore && onLoadMoreEligible ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onLoadMoreEligible}
              className={`min-h-11 rounded-md px-2 text-sm font-semibold text-tk-focus hover:bg-tk-ink-wash ${portalFocus}`}
            >
              Show earlier files
            </button>
          ) : null}
        </div>
      ) : null}
      {selectionError ? (
        <p role="alert" className="mt-1 text-sm text-tk-danger">
          {selectionError}
        </p>
      ) : null}
    </div>
  )
}
