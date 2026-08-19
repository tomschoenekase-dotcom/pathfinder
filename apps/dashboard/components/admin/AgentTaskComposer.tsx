'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Identity = { id: string; name: string; enabled: boolean; agentType: string }

export function AgentTaskComposer({
  tenantId,
  venueId,
  identities,
}: {
  tenantId: string
  venueId: string
  identities: Identity[]
}) {
  const available = identities
    .filter((identity) => identity.enabled)
    .sort((left, right) => {
      const leftPrimary = left.agentType === 'PRIMARY' ? 0 : 1
      const rightPrimary = right.agentType === 'PRIMARY' ? 0 : 1
      return leftPrimary - rightPrimary || left.name.localeCompare(right.name)
    })
  const primary = available.find((identity) => identity.agentType === 'PRIMARY')
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const attemptedSignature = useRef<string | null>(null)
  const [operationId, setOperationId] = useState(() => globalThis.crypto.randomUUID())
  const [agentIdentityId, setAgentIdentityId] = useState(available[0]?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  function edit(nextIdentity: string, nextPrompt: string) {
    const signature = `${nextIdentity}\u0000${nextPrompt.trim()}`
    if (attemptedSignature.current && attemptedSignature.current !== signature) {
      attemptedSignature.current = null
      setOperationId(globalThis.crypto.randomUUID())
      setFeedback(null)
    }
    setAgentIdentityId(nextIdentity)
    setPrompt(nextPrompt)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = prompt.trim()
    if (!value || !agentIdentityId || active.current) return
    active.current = true
    attemptedSignature.current = `${agentIdentityId}\u0000${value}`
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.createAgentTask.mutate({
        operationId,
        tenantId,
        venueId,
        agentIdentityId,
        prompt: value,
      })
      setFeedback(
        result.replayed
          ? result.executionTriggered
            ? 'The existing task was confirmed and dispatched to the worker queue.'
            : 'The existing queued task was confirmed.'
          : result.executionTriggered
            ? 'Task queued and dispatched. Open the run to follow its evidence.'
            : 'Task queued. A connected worker is required to begin it.',
      )
      setPrompt('')
      attemptedSignature.current = null
      setOperationId(globalThis.crypto.randomUUID())
      router.refresh()
    } catch {
      setFeedback('The queue outcome is unknown. Retry unchanged to reconcile the same task.')
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">New task</p>
      <h3 className="mt-2 text-xl font-semibold text-pf-deep">What should your team work on?</h3>
      {primary ? (
        <p className="mt-2 text-sm leading-6 text-pf-deep/65">
          Start with {primary.name} for coordination, or assign a specialist directly when you
          already know the owner.
        </p>
      ) : (
        <p className="mt-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          No primary agent is enabled. Tasks can still go directly to specialists, but automatic
          team coordination is unavailable.
        </p>
      )}
      <form onSubmit={(event) => void submit(event)} className="mt-4 space-y-3">
        <label className="grid gap-2 text-sm font-semibold text-pf-deep">
          Specialist
          <select
            value={agentIdentityId}
            disabled={pending || available.length === 0}
            onChange={(event) => edit(event.target.value, prompt)}
            className="min-h-11 rounded-2xl border border-pf-light bg-white px-4 font-normal"
          >
            {available.length === 0 ? <option value="">No enabled specialists</option> : null}
            {available.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.name} · {identity.agentType.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold text-pf-deep">
          Goal
          <textarea
            rows={4}
            maxLength={10_000}
            required
            disabled={pending || available.length === 0}
            value={prompt}
            onChange={(event) => edit(agentIdentityId, event.target.value)}
            placeholder="Research the issue, make a plan, and ask me only when a decision is genuinely needed…"
            className="rounded-2xl border border-pf-light bg-white px-4 py-3 font-normal outline-none focus:border-pf-primary"
          />
        </label>
        <button
          type="submit"
          disabled={pending || !agentIdentityId || !prompt.trim()}
          className="min-h-11 rounded-2xl bg-pf-deep px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Queuing…' : 'Queue task'}
        </button>
      </form>
      <p className="mt-3 text-xs leading-5 text-pf-deep/55">
        This records durable work intent. It does not call a model or spend money until a reviewed
        worker runtime claims the run.
      </p>
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/70" role="status">
          {feedback}
        </p>
      ) : null}
    </section>
  )
}
