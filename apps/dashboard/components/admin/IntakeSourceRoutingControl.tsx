'use client'

import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const REQUEST_TIMEOUT_MS = 15_000

export type IntakeSourceRoutingIdentity = {
  id: string
  name: string
  agentType: string
  enabled: boolean
  accessCapabilities: string[]
  autonomyLevel: string
  autonomousActions: string[]
  defaultProvider: string | null
  defaultModel: string | null
}

type Props = {
  tenantId: string
  venueId: string
  identities?: IntakeSourceRoutingIdentity[]
}

type Feedback = { kind: 'error' | 'success'; text: string }
type Action = { token: number; scope: number }

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

export function IntakeSourceRoutingControl({ tenantId, venueId, identities = [] }: Props) {
  const client = useTRPCClient()
  const [selectedIdentityId, setSelectedIdentityId] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState<'read' | 'save' | 'more' | null>(null)
  const [requiresRefresh, setRequiresRefresh] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [candidates, setCandidates] = useState<IntakeSourceRoutingIdentity[]>([])
  const [nextCursor, setNextCursor] = useState<{ createdAt: string; id: string } | null>(null)
  const mounted = useRef(false)
  const scopeGeneration = useRef(0)
  const sequence = useRef(0)
  const activeAction = useRef<number | null>(null)
  const controller = useRef<AbortController | null>(null)

  const selectedCandidate = candidates.find((identity) => identity.id === selectedIdentityId)
  const fallbackIdentity = identities.find((identity) => identity.id === selectedIdentityId)
  const configuredOutsidePage =
    selectedIdentityId && !candidates.some((identity) => identity.id === selectedIdentityId)
  const canEnable = Boolean(selectedCandidate)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
      activeAction.current = null
    }
  }, [])

  function begin(kind: 'read' | 'save' | 'more'): Action | null {
    if (activeAction.current !== null) return null
    const action = { token: ++sequence.current, scope: scopeGeneration.current }
    activeAction.current = action.token
    setPending(kind)
    return action
  }

  function current(action: Action) {
    return (
      mounted.current &&
      action.scope === scopeGeneration.current &&
      action.token === activeAction.current
    )
  }

  function finish(action: Action) {
    if (!current(action)) return
    activeAction.current = null
    setPending(null)
  }

  async function readConfiguration(successMessage?: string) {
    const action = begin('read')
    if (!action) return
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    setFeedback(null)
    try {
      const [policy, page] = await Promise.all([
        runBoundedClientRequest({
          parentSignal: requestController.signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
          request: (signal) =>
            client.admin.getIntakeSourceAgentRouting.query({ tenantId, venueId }, { signal }),
        }),
        runBoundedClientRequest({
          parentSignal: requestController.signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
          request: (signal) =>
            client.admin.listIntakeSourceAgentRoutingCandidates.query(
              { tenantId, venueId, limit: 50 },
              { signal },
            ),
        }),
      ])
      if (!current(action)) return
      setSelectedIdentityId(policy?.agentIdentityId ?? '')
      setEnabled(policy?.enabled ?? false)
      setRevision(policy?.revision ?? 0)
      setCandidates(page.items)
      setNextCursor(page.nextCursor)
      setLoaded(true)
      setRequiresRefresh(false)
      if (successMessage) setFeedback({ kind: 'success', text: successMessage })
    } catch {
      if (!current(action)) return
      setLoaded(false)
      setRequiresRefresh(true)
      setFeedback({
        kind: 'error',
        text: 'Source review routing could not be loaded. Retry the canonical read when ready.',
      })
    } finally {
      if (controller.current === requestController) controller.current = null
      finish(action)
    }
  }

  async function loadMore() {
    if (!nextCursor) return
    const action = begin('more')
    if (!action) return
    const requestController = new AbortController()
    controller.current = requestController
    const cursor = nextCursor
    setFeedback(null)
    try {
      const page = await runBoundedClientRequest({
        parentSignal: requestController.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listIntakeSourceAgentRoutingCandidates.query(
            { tenantId, venueId, limit: 50, cursor },
            { signal },
          ),
      })
      if (!current(action)) return
      setCandidates((currentCandidates) => [
        ...currentCandidates,
        ...page.items.filter(
          (candidate) => !currentCandidates.some((current) => current.id === candidate.id),
        ),
      ])
      setNextCursor(page.nextCursor)
    } catch {
      if (!current(action)) return
      setFeedback({
        kind: 'error',
        text: 'More eligible specialists could not be loaded. No routing change was attempted.',
      })
    } finally {
      if (controller.current === requestController) controller.current = null
      finish(action)
    }
  }

  useLayoutEffect(() => {
    scopeGeneration.current += 1
    controller.current?.abort()
    controller.current = null
    activeAction.current = null
    setSelectedIdentityId('')
    setEnabled(false)
    setRevision(0)
    setLoaded(false)
    setPending(null)
    setRequiresRefresh(false)
    setFeedback(null)
    setCandidates([])
    setNextCursor(null)
  }, [tenantId, venueId, client])

  useEffect(() => {
    void readConfiguration()
    // readConfiguration deliberately captures this exact scope generation.
  }, [tenantId, venueId, client])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!loaded || requiresRefresh || !selectedIdentityId || (enabled && !canEnable)) return
    const action = begin('save')
    if (!action) return
    const requestController = new AbortController()
    controller.current = requestController
    const input = {
      tenantId,
      venueId,
      agentIdentityId: selectedIdentityId,
      expectedRevision: revision,
      enabled,
    }
    setFeedback(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: requestController.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        request: (signal) =>
          client.admin.configureIntakeSourceAgentRouting.mutate(input, { signal }),
      })
      if (!current(action)) return
      setSelectedIdentityId(result.policy.agentIdentityId)
      setEnabled(result.policy.enabled)
      setRevision(result.policy.revision)
      setFeedback({ kind: 'success', text: 'Source review routing saved.' })
    } catch (error) {
      if (!current(action)) return
      setRequiresRefresh(true)
      setFeedback({
        kind: 'error',
        text:
          errorCode(error) === 'CONFLICT'
            ? 'Source review routing changed after this page loaded. Refresh before trying again.'
            : 'The save outcome could not be confirmed. Refresh the canonical setting before trying again.',
      })
    } finally {
      if (controller.current === requestController) controller.current = null
      finish(action)
    }
  }

  return (
    <section className="border-t border-pf-light pt-5" aria-labelledby="source-routing-heading">
      <div className="max-w-3xl">
        <h3 id="source-routing-heading" className="text-lg font-semibold text-pf-deep">
          Source review preparation
        </h3>
        <p className="mt-1 text-sm leading-6 text-pf-deep/75">
          Choose who may prepare uploaded sources awaiting Torchiko review. The matching worker must
          also be available. This setting does not approve or publish content, and it does not
          reroute tasks already created. Edits remain local until you save.
        </p>
      </div>

      {!loaded && pending === 'read' ? (
        <p className="mt-4 text-sm text-pf-deep/75" role="status">
          Loading source review routing…
        </p>
      ) : loaded ? (
        <form onSubmit={(event) => void save(event)} className="mt-5 max-w-3xl space-y-4">
          <div>
            <label
              htmlFor="intake-source-routing-identity"
              className="text-sm font-semibold text-pf-deep"
            >
              Content specialist
            </label>
            <select
              id="intake-source-routing-identity"
              value={selectedIdentityId}
              disabled={pending !== null || requiresRefresh}
              onChange={(event) => setSelectedIdentityId(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm text-pf-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:opacity-55"
            >
              <option value="">Select an eligible Content specialist</option>
              {configuredOutsidePage ? (
                <option value={selectedIdentityId}>
                  {fallbackIdentity?.name ?? 'Configured specialist'} (not in eligible results)
                </option>
              ) : null}
              {candidates.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {identity.name}
                </option>
              ))}
            </select>
            {nextCursor ? (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void loadMore()}
                className="mt-2 min-h-10 text-sm font-semibold text-pf-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:opacity-50"
              >
                {pending === 'more' ? 'Loading…' : 'Load more specialists'}
              </button>
            ) : null}
          </div>

          <label className="flex min-h-11 items-start gap-3 text-sm text-pf-deep">
            <input
              type="checkbox"
              aria-label="Enable source review preparation"
              checked={enabled}
              disabled={pending !== null || requiresRefresh || (!enabled && !canEnable)}
              onChange={(event) => setEnabled(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-pf-light text-pf-primary focus-visible:ring-pf-primary"
            />
            <span>
              <span className="font-semibold">Enable source review preparation</span>
              <span className="mt-1 block text-pf-deep/75">
                You can disable a saved route while retaining its selected specialist.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={
                pending !== null ||
                requiresRefresh ||
                !selectedIdentityId ||
                (enabled && !canEnable)
              }
              className="inline-flex min-h-11 items-center rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === 'save' ? 'Saving…' : 'Save routing'}
            </button>
            <span className="text-sm text-pf-deep/75">
              Selected setting: {enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </form>
      ) : null}

      {requiresRefresh && pending === null ? (
        <button
          type="button"
          onClick={() => void readConfiguration('Source review routing refreshed.')}
          className="mt-4 inline-flex min-h-11 items-center rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
        >
          Refresh configuration
        </button>
      ) : null}
      {feedback ? (
        <p
          className={`mt-4 text-sm ${feedback.kind === 'error' ? 'text-rose-700' : 'text-emerald-700'}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </section>
  )
}
