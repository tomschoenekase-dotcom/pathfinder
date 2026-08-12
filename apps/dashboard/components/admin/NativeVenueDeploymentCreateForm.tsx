'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

export function NativeVenueDeploymentCreateForm({
  tenantId,
  venueId,
}: {
  tenantId: string
  venueId: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const scopeKey = `${tenantId}:${venueId}`
  const renderedScope = useRef(scopeKey)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const [inputScope, setInputScope] = useState(scopeKey)
  const [manifestJson, setManifestJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    generation.current += 1
    inFlight.current = false
  }
  const scopeReady = inputScope === scopeKey

  useEffect(() => {
    setInputScope(scopeKey)
    setManifestJson('')
    setBusy(false)
    setError(null)
    setNotice(null)
    inFlight.current = false
  }, [scopeKey])

  async function create() {
    if (!scopeReady || inFlight.current || !manifestJson.trim()) return
    inFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scopeKey
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const release = await client.admin.createNativeVenueDeployment.mutate({
        tenantId,
        venueId,
        manifestJson,
      })
      if (generation.current !== startedGeneration || renderedScope.current !== startedScope) return
      setNotice(
        `Native ${release.profile} release recorded as ${release.status.toLowerCase()}. Nothing was approved or applied.`,
      )
      router.refresh()
    } catch {
      if (generation.current !== startedGeneration || renderedScope.current !== startedScope) return
      setError(
        'The native FULL release could not be recorded. The manifest text is preserved; no venue state was changed.',
      )
    } finally {
      if (generation.current === startedGeneration && renderedScope.current === startedScope) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <section
      aria-labelledby="native-create-heading"
      className="rounded-2xl border border-pf-light bg-white p-5"
    >
      <h3 id="native-create-heading" className="font-semibold text-pf-deep">
        Record a native FULL release
      </h3>
      <p className="mt-2 text-sm leading-6 text-pf-deep/75">
        This accepts only a validated NATIVE_CORE_V1 FULL manifest and records an immutable draft
        release. Approval and application remain separate actions.
      </p>
      <label className="mt-4 block text-sm font-semibold text-pf-deep">
        Native FULL manifest JSON
        <textarea
          value={scopeReady ? manifestJson : ''}
          onChange={(event) => {
            setManifestJson(event.target.value)
            setError(null)
            setNotice(null)
          }}
          disabled={!scopeReady || busy}
          maxLength={2_000_000}
          className="mt-2 min-h-64 w-full rounded-2xl border border-pf-light bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        />
      </label>
      <button
        type="button"
        disabled={!scopeReady || busy || !manifestJson.trim()}
        onClick={() => void create()}
        className="mt-3 min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Recording release…' : 'Record native draft release'}
      </button>
      {error ? (
        <p className="mt-3 text-sm text-rose-800" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 text-sm text-emerald-800" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  )
}
