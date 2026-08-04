'use client'

import { useMemo, useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type JsonRecord = Record<string, unknown>

function normalizeQuestions(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (typeof item === 'string') return { id: `Q-${index + 1}`, question: item, answer: '' }
    if (item && typeof item === 'object') return item as JsonRecord
    return { id: `Q-${index + 1}`, question: String(item), answer: '' }
  })
}

function questionText(question: JsonRecord, index: number) {
  const value = question.question ?? question.prompt ?? question.text
  return typeof value === 'string' ? value : `Question ${index + 1}`
}

export function MediaIngestionReview({
  tenantId,
  projectId,
  initialQuestions,
  initialDraft,
}: {
  tenantId: string
  projectId: string
  initialQuestions: unknown
  initialDraft: unknown
}) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (!clientRef.current) clientRef.current = createTRPCClient()
  const [questions, setQuestions] = useState(() => normalizeQuestions(initialQuestions))
  const [draftText, setDraftText] = useState(() => JSON.stringify(initialDraft ?? {}, null, 2))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const parseError = useMemo(() => {
    try {
      const value = JSON.parse(draftText)
      return value && typeof value === 'object' && !Array.isArray(value)
        ? null
        : 'The draft root must be a JSON object.'
    } catch {
      return 'The draft is not valid JSON.'
    }
  }, [draftText])

  async function save() {
    if (parseError) return
    setBusy(true)
    setMessage(null)
    try {
      await clientRef.current!.mediaIngestion.saveReview.mutate({
        tenantId,
        projectId,
        questions,
        draftJson: JSON.parse(draftText) as JsonRecord,
      })
      setMessage('Review saved.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the review.')
    } finally {
      setBusy(false)
    }
  }

  function download() {
    if (parseError) return
    const blob = new Blob([draftText], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'pathfinder-venue-import.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Questions for you</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          These are ambiguities that could materially change the guide. Leave anything unanswered
          and it stays explicitly uncertain.
        </p>
        {questions.length === 0 ? (
          <p className="mt-5 rounded-lg bg-pf-surface px-4 py-3 text-sm text-pf-deep/60">
            No blocking questions were generated.
          </p>
        ) : (
          <div className="mt-5 space-y-4">
            {questions.map((question, index) => (
              <label
                key={String(question.id ?? index)}
                className="block text-sm font-medium text-pf-deep/75"
              >
                {questionText(question, index)}
                <textarea
                  rows={3}
                  value={typeof question.answer === 'string' ? question.answer : ''}
                  onChange={(event) =>
                    setQuestions((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, answer: event.target.value } : item,
                      ),
                    )
                  }
                  className="mt-2 w-full rounded-lg border border-pf-light bg-pf-surface px-4 py-3 font-normal outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                />
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">PathFinder JSON</h2>
            <p className="mt-2 text-sm text-pf-deep/60">
              Review or edit the generated import before downloading it.
            </p>
          </div>
          <button
            type="button"
            onClick={download}
            disabled={Boolean(parseError)}
            className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary hover:border-pf-accent disabled:opacity-40"
          >
            Download JSON
          </button>
        </div>
        <textarea
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
          spellCheck={false}
          className="mt-5 min-h-[34rem] w-full rounded-lg border border-pf-light bg-pf-surface px-4 py-3 font-mono text-xs leading-5 outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
        {parseError ? <p className="mt-2 text-sm text-rose-700">{parseError}</p> : null}
      </section>

      <div className="flex items-center justify-end gap-4">
        {message ? <span className="text-sm text-pf-deep/60">{message}</span> : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || Boolean(parseError)}
          className="rounded-full bg-pf-primary px-6 py-3 text-sm font-semibold text-white hover:bg-pf-accent disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save review'}
        </button>
      </div>
    </div>
  )
}
