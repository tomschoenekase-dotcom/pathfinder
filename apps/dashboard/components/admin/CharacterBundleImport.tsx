'use client'

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

const MAX_BYTES = 12_000_000

export function CharacterBundleImport() {
  const [tenantId, setTenantId] = useState('')
  const [venueId, setVenueId] = useState('')
  const [brief, setBrief] = useState('')
  const [rationale, setRationale] = useState('')
  const [sourceProvenance, setSourceProvenance] = useState<'IMPORTED' | 'GENERATED'>('GENERATED')
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const requestId = useRef<string | null>(null)
  const router = useRouter()

  function resetRequest() {
    requestId.current = null
    if (status !== 'submitting') setStatus('idle')
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null
    setFile(selected)
    resetRequest()
    setStatus('idle')
    setMessage('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || file.size > MAX_BYTES || !file.name.toLowerCase().endsWith('.character.json')) {
      setStatus('error')
      setMessage('Choose a .character.json bundle smaller than 12 MB.')
      return
    }
    const form = event.currentTarget
    setStatus('submitting')
    setMessage('')
    const body = new FormData(form)
    requestId.current ??= crypto.randomUUID()
    body.set('requestId', requestId.current)
    body.set('sourceProvenance', sourceProvenance)
    try {
      const response = await fetch('/api/admin/character-import', { method: 'POST', body })
      const result = (await response.json()) as {
        error?: string
        displayName?: string
        briefId?: string
      }
      if (!response.ok) throw new Error(result.error || 'The bundle could not be imported.')
      setStatus('success')
      setMessage(`${result.displayName ?? 'Character'} is ready for founder review.`)
      setFile(null)
      requestId.current = null
      form.reset()
      router.refresh()
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : 'The bundle could not be imported.')
    }
  }

  return (
    <section
      aria-labelledby="character-import-heading"
      className="border border-slate-300 bg-white p-5 sm:p-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
            Verified intake
          </p>
          <h2 id="character-import-heading" className="mt-1 text-lg font-semibold text-slate-950">
            Import a prepared appearance bundle
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Upload one exact character bundle to create a review candidate. This does not approve,
            publish, or enable the character.
          </p>
        </div>
        <span className="text-xs font-semibold text-slate-500">12 MB maximum</span>
      </div>
      <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={status === 'submitting'} className="space-y-4 disabled:opacity-70">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-700">
              Tenant scope
              <input
                name="tenantId"
                required
                maxLength={191}
                value={tenantId}
                onChange={(event) => {
                  setTenantId(event.target.value)
                  resetRequest()
                }}
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm text-slate-950 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-200"
              />
            </label>
            <label className="block text-sm font-semibold text-slate-700">
              Venue scope
              <input
                name="venueId"
                required
                maxLength={191}
                value={venueId}
                onChange={(event) => {
                  setVenueId(event.target.value)
                  resetRequest()
                }}
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm text-slate-950 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-200"
              />
            </label>
          </div>
          <label className="block max-w-sm text-sm font-semibold text-slate-700">
            Source record
            <select
              name="sourceProvenance"
              value={sourceProvenance}
              onChange={(event) => {
                setSourceProvenance(event.target.value as 'IMPORTED' | 'GENERATED')
                resetRequest()
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-950 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-200"
            >
              <option value="GENERATED">Generated candidate</option>
              <option value="IMPORTED">Imported candidate</option>
            </select>
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Prepared bundle
            <input
              name="bundle"
              required
              type="file"
              accept=".character.json,application/json"
              onChange={chooseFile}
              className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
            />
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Static appearance bundle only; runtime packs are rejected at intake.
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-700">
              Review brief
              <textarea
                name="brief"
                required
                maxLength={4000}
                rows={3}
                value={brief}
                onChange={(event) => {
                  setBrief(event.target.value)
                  resetRequest()
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-950 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-200"
                placeholder="What should the founder inspect?"
              />
            </label>
            <label className="block text-sm font-semibold text-slate-700">
              Why this candidate
              <textarea
                name="rationale"
                required
                maxLength={2000}
                rows={3}
                value={rationale}
                onChange={(event) => {
                  setRationale(event.target.value)
                  resetRequest()
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-950 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-200"
                placeholder="Record the bounded source rationale."
              />
            </label>
          </div>
        </fieldset>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="submit"
            disabled={status === 'submitting'}
            className="min-h-11 rounded-lg bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800 disabled:cursor-wait disabled:opacity-60"
          >
            {status === 'submitting' ? 'Importing bundle…' : 'Create review candidate'}
          </button>
          {message ? (
            <p
              role={status === 'error' ? 'alert' : 'status'}
              className={`text-sm ${status === 'error' ? 'text-rose-700' : 'text-emerald-800'}`}
            >
              {message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  )
}
