'use client'

import type { inferRouterOutputs } from '@trpc/server'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import type { AppRouter } from '@pathfinder/api'
import { useTRPCClient } from '../../lib/trpc'

type Data = inferRouterOutputs<AppRouter>['admin']['attentionConsole']
type Exchange = Data['founderConversation'][number]
type Evidence = {
  label: string
  detail: string
  href: string
}

const suggestions = [
  'What is the highest-value thing I can do in the next five minutes?',
  'What needs my decision?',
  'Is anything broken?',
  'What are agents waiting on?',
  'What changed since my last review?',
  'Show me anything costing unexpectedly much.',
]

function evidenceItems(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const candidate = item as Record<string, unknown>
    return typeof candidate.label === 'string' &&
      typeof candidate.detail === 'string' &&
      typeof candidate.href === 'string'
      ? [{ label: candidate.label, detail: candidate.detail, href: candidate.href }]
      : []
  })
}

function ExchangeCard({ exchange }: { exchange: Exchange }) {
  const items = evidenceItems(exchange.evidence)
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium leading-6 text-slate-700">{exchange.prompt}</p>
      <div className="mt-3 rounded-2xl bg-sky-50 p-4 text-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{exchange.responseTitle}</h3>
          {exchange.disposition === 'RECORDED_FOR_TRIAGE' ? (
            <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-950">
              Recorded for triage · not executed
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-700">{exchange.responseBody}</p>
        {items.length ? (
          <ul className="mt-3 space-y-2">
            {items.map((item, index) => (
              <li key={`${item.href}-${index}`}>
                <Link
                  href={item.href}
                  className="block min-h-11 rounded-xl border border-sky-200 bg-white px-3 py-2 text-sm hover:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  <span className="font-semibold text-sky-900">{item.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-600">
                    {item.detail}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-slate-500">{new Date(exchange.createdAt).toLocaleString()}</p>
    </article>
  )
}

export function FounderOperatingConversation({ exchanges }: { exchanges: Exchange[] }) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const attemptedPrompt = useRef<string | null>(null)
  const [operationId, setOperationId] = useState(() => globalThis.crypto.randomUUID())
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  function edit(value: string) {
    const next = value.trim()
    if (attemptedPrompt.current !== null && attemptedPrompt.current !== next) {
      attemptedPrompt.current = null
      setOperationId(globalThis.crypto.randomUUID())
      setFeedback(null)
    }
    setPrompt(value)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = prompt.trim()
    if (!value || active.current) return
    active.current = true
    attemptedPrompt.current = value
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.askFounderOperatingSystem.mutate({
        operationId,
        prompt: value,
      })
      setFeedback(
        result.exchange.disposition === 'RECORDED_FOR_TRIAGE'
          ? 'Direction recorded for operating-worker triage. No action was executed.'
          : result.replayed
            ? 'The existing answer was reconciled from its durable evidence snapshot.'
            : 'Answered from the current bounded operating snapshot.',
      )
      setPrompt('')
      attemptedPrompt.current = null
      setOperationId(globalThis.crypto.randomUUID())
      router.refresh()
    } catch {
      setFeedback('The outcome is unknown. Retry unchanged to reconcile the same exchange safely.')
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <section
      aria-labelledby="founder-conversation-heading"
      className="rounded-3xl border border-sky-200 bg-gradient-to-br from-sky-50 via-white to-indigo-50 p-4 shadow-sm sm:p-6"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-800">
        Company operating conversation
      </p>
      <h2 id="founder-conversation-heading" className="mt-2 text-xl font-semibold text-slate-950">
        What do you need to know or direct?
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
        Questions are answered from the current Control Room snapshot with source links. Other
        direction is recorded for authorized worker triage; it does not execute consequential work.
      </p>

      <div
        className="mt-4 flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible sm:pb-0"
        aria-label="Suggested questions"
      >
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={pending}
            onClick={() => edit(suggestion)}
            className="min-h-11 shrink-0 rounded-full border border-sky-200 bg-white px-4 text-left text-sm font-medium text-sky-950 hover:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <form onSubmit={(event) => void submit(event)} className="mt-3">
        <label htmlFor="founder-operating-prompt" className="sr-only">
          Ask or direct Torchiko
        </label>
        <textarea
          id="founder-operating-prompt"
          rows={3}
          maxLength={10_000}
          required
          disabled={pending}
          value={prompt}
          onChange={(event) => edit(event.target.value)}
          placeholder="Ask what needs you, request context, or record direction…"
          className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-950 outline-none placeholder:text-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-200 disabled:opacity-60"
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-slate-500">
            Pricing, billing, customer contact, deployment, approvals, and policy remain separately
            gated.
          </p>
          <button
            type="submit"
            disabled={pending || !prompt.trim()}
            className="min-h-11 shrink-0 rounded-2xl bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-sky-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {pending ? 'Checking…' : 'Ask Torchiko'}
          </button>
        </div>
      </form>
      {feedback ? (
        <p role="status" className="mt-3 rounded-xl bg-white px-3 py-2 text-sm text-slate-700">
          {feedback}
        </p>
      ) : null}

      <div className="mt-6 border-t border-sky-100 pt-5">
        <h3 className="text-sm font-semibold text-slate-900">Recent conversation</h3>
        {exchanges.length ? (
          <div className="mt-3 space-y-3">
            {exchanges.map((exchange) => (
              <ExchangeCard key={exchange.id} exchange={exchange} />
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-4 text-sm text-slate-600">
            No operating conversation has been recorded yet. Start with one of the questions above.
          </p>
        )}
      </div>
    </section>
  )
}
