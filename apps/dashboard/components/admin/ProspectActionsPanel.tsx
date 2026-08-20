'use client'

import { useRouter } from 'next/navigation'
import { FormEvent, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

const STAGES = [
  'DISCOVERED',
  'RESEARCHED',
  'NEEDS_REVIEW',
  'READY_FOR_OUTREACH',
  'CONTACTED',
  'FOLLOW_UP_DUE',
  'REPLIED',
  'CONVERSATION',
  'QUALIFIED',
  'PROPOSAL_DECISION',
  'WON',
  'LOST',
  'PARKED',
  'DO_NOT_CONTACT',
] as const
type Stage = (typeof STAGES)[number]

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export function ProspectActionsPanel({
  organizationId,
  currentStage,
  currentPriority,
  currentNextAction,
  currentNextActionAt,
  archived,
}: {
  organizationId: string
  currentStage: Stage
  currentPriority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  currentNextAction: string | null
  currentNextActionAt: string | null
  archived: boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [stage, setStage] = useState(currentStage)
  const [priority, setPriority] = useState(currentPriority)
  const [nextAction, setNextAction] = useState(currentNextAction ?? '')
  const [nextActionAt, setNextActionAt] = useState(currentNextActionAt?.slice(0, 10) ?? '')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function savePipeline(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.updateProspectPipeline.mutate({
        organizationId,
        stage,
        priority,
        nextAction: nextAction.trim() || null,
        nextActionAt: nextActionAt ? new Date(`${nextActionAt}T12:00:00.000Z`).toISOString() : null,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      setMessage('Pipeline updated with history evidence.')
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update pipeline.')
    } finally {
      setBusy(false)
    }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault()
    if (!note.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.addProspectNote.mutate({ organizationId, note: note.trim() })
      setNote('')
      setMessage('Note added to the durable timeline.')
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not add note.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleArchive() {
    const archiveReason = window.prompt(
      archived ? 'Why is this prospect being restored?' : 'Why is this prospect being archived?',
    )
    if (!archiveReason?.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.archiveProspect.mutate({
        organizationId,
        archived: !archived,
        reason: archiveReason.trim(),
      })
      setMessage(archived ? 'Prospect restored.' : 'Prospect archived.')
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not change archive state.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {message ? (
        <p
          role="status"
          className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
        >
          {message}
        </p>
      ) : null}
      <form
        onSubmit={savePipeline}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h2 className="font-semibold text-slate-950">Operational continuity</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-slate-600">
            Stage
            <select
              value={stage}
              onChange={(event) => setStage(event.target.value as Stage)}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-normal text-slate-900"
            >
              {STAGES.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Priority
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as typeof priority)}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-normal text-slate-900"
            >
              {(['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600 sm:col-span-2">
            Next action
            <input
              value={nextAction}
              onChange={(event) => setNextAction(event.target.value)}
              maxLength={2000}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-normal text-slate-900"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Next-action date
            <input
              type="date"
              value={nextActionAt}
              onChange={(event) => setNextActionAt(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-normal text-slate-900"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Reason / evidence
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm font-normal text-slate-900"
            />
          </label>
        </div>
        <button
          disabled={busy}
          className="mt-4 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save pipeline
        </button>
      </form>
      <form
        onSubmit={addNote}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <label className="text-sm font-semibold text-slate-900">
          Add timeline note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={10000}
            rows={4}
            className="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm font-normal"
            placeholder="Record research, a conversation, or a decision…"
          />
        </label>
        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            disabled={busy || !note.trim()}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 disabled:opacity-50"
          >
            Add note
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggleArchive()}
            className="text-sm font-semibold text-slate-500 hover:text-rose-700"
          >
            {archived ? 'Restore prospect' : 'Archive prospect'}
          </button>
        </div>
      </form>
    </div>
  )
}
