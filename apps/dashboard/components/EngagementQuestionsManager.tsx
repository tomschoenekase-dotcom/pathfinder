'use client'

import { type FormEvent, useRef, useState } from 'react'
import { Flame, Plus, Sparkles, Trash2 } from 'lucide-react'

import { createTRPCClient } from '../lib/trpc'

type EngagementQuestionType = 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
type TenantEngagementMode = 'STOIC' | 'BALANCED' | 'CURIOUS'

type EngagementQuestion = {
  id: string
  questionType: EngagementQuestionType
  prompt: string
  choiceOptions: string[]
  intensity: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

type EngagementQuestionsManagerProps = {
  initialMode: TenantEngagementMode
  initialQuestions: EngagementQuestion[]
}

const MODE_OPTIONS: Array<{ value: TenantEngagementMode; label: string; description: string }> = [
  {
    value: 'STOIC',
    label: 'Stoic',
    description: 'The AI functions as normal and never asks engagement questions.',
  },
  {
    value: 'BALANCED',
    label: 'Balanced',
    description: 'The AI asks the questions below, at the intensity you set for each.',
  },
  {
    value: 'CURIOUS',
    label: 'Curious',
    description:
      'Like Balanced, but if none of your questions fit the moment, the AI will ask a genuinely curious question of its own.',
  },
]

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

function emptyChoiceOptions(): string[] {
  return ['', '']
}

function normalizedOptions(choiceOptions: string[]) {
  return choiceOptions.map((option) => option.trim()).filter((option) => option.length > 0)
}

function QuestionCard({
  client,
  question,
  onUpdated,
  onDeleted,
}: {
  client: ReturnType<typeof createTRPCClient>
  question: EngagementQuestion
  onUpdated: (question: EngagementQuestion) => void
  onDeleted: (id: string) => void
}) {
  const [questionType, setQuestionType] = useState<EngagementQuestionType>(question.questionType)
  const [prompt, setPrompt] = useState(question.prompt)
  const [choiceOptions, setChoiceOptions] = useState<string[]>(
    question.choiceOptions.length > 0 ? question.choiceOptions : emptyChoiceOptions(),
  )
  const [intensity, setIntensity] = useState(question.intensity)
  const [isActive, setIsActive] = useState(question.isActive)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cleanOptions = normalizedOptions(choiceOptions)
  const hasEnoughOptions = questionType === 'OPEN_ENDED' || cleanOptions.length >= 2

  async function save() {
    if (!prompt.trim() || !hasEnoughOptions) return

    setSaving(true)
    setError(null)
    try {
      const updated = await client.engagementQuestion.update.mutate({
        id: question.id,
        questionType,
        prompt: prompt.trim(),
        choiceOptions: questionType === 'MULTIPLE_CHOICE' ? cleanOptions : [],
        intensity,
        isActive,
      })
      onUpdated({
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setSaving(true)
    setError(null)
    try {
      await client.engagementQuestion.delete.mutate({ id: question.id })
      onDeleted(question.id)
    } catch (err) {
      setError(getErrorMessage(err))
      setSaving(false)
    }
  }

  return (
    <div className="rounded-[1.5rem] border border-pf-light bg-pf-surface p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setQuestionType('OPEN_ENDED')}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              questionType === 'OPEN_ENDED'
                ? 'bg-pf-primary text-white'
                : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
            }`}
          >
            Open-ended
          </button>
          <button
            type="button"
            onClick={() => setQuestionType('MULTIPLE_CHOICE')}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              questionType === 'MULTIPLE_CHOICE'
                ? 'bg-pf-primary text-white'
                : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
            }`}
          >
            Soft multiple-choice
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium text-pf-deep/60">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="h-4 w-4 rounded border-pf-light text-pf-primary focus:ring-pf-accent"
          />
          Active
        </label>
      </div>

      <textarea
        value={prompt}
        maxLength={500}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe the question and what you want to learn. The AI rephrases this in its own words each time."
        className="mt-4 min-h-24 w-full rounded-2xl border border-pf-light bg-pf-white px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
      />

      {questionType === 'MULTIPLE_CHOICE' ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-pf-deep/50">
            Add 2-4 options the AI can mention conversationally.
          </p>
          {choiceOptions.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={option}
                maxLength={100}
                onChange={(event) => {
                  const next = [...choiceOptions]
                  next[index] = event.target.value
                  setChoiceOptions(next)
                }}
                placeholder={`Option ${index + 1}`}
                className="min-h-10 w-full rounded-2xl border border-pf-light bg-pf-white px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              />
              {choiceOptions.length > 2 ? (
                <button
                  type="button"
                  onClick={() => setChoiceOptions(choiceOptions.filter((_, i) => i !== index))}
                  className="text-pf-deep/40 hover:text-rose-500"
                  aria-label="Remove option"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ))}
          {choiceOptions.length < 4 ? (
            <button
              type="button"
              onClick={() => setChoiceOptions([...choiceOptions, ''])}
              className="text-xs font-medium text-pf-accent hover:underline"
            >
              + Add option
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-medium text-pf-deep/60">
          <span>How often the AI pushes this question</span>
          <span>{intensity}/5</span>
        </div>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={intensity}
          onChange={(event) => setIntensity(Number(event.target.value))}
          className="mt-2 w-full accent-pf-accent"
        />
      </div>

      {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => void remove()}
          disabled={saving}
          className="text-xs font-medium text-rose-500 hover:underline disabled:opacity-50"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !prompt.trim() || !hasEnoughOptions}
          className="inline-flex min-h-9 items-center rounded-full bg-pf-primary px-4 text-xs font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function NewQuestionForm({
  client,
  onCreated,
}: {
  client: ReturnType<typeof createTRPCClient>
  onCreated: (question: EngagementQuestion) => void
}) {
  const [questionType, setQuestionType] = useState<EngagementQuestionType>('OPEN_ENDED')
  const [prompt, setPrompt] = useState('')
  const [choiceOptions, setChoiceOptions] = useState<string[]>(emptyChoiceOptions())
  const [intensity, setIntensity] = useState(3)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cleanOptions = normalizedOptions(choiceOptions)
  const hasEnoughOptions = questionType === 'OPEN_ENDED' || cleanOptions.length >= 2

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!prompt.trim() || !hasEnoughOptions) return

    setSaving(true)
    setError(null)
    try {
      const created = await client.engagementQuestion.create.mutate({
        questionType,
        prompt: prompt.trim(),
        choiceOptions: questionType === 'MULTIPLE_CHOICE' ? cleanOptions : [],
        intensity,
      })
      onCreated({
        ...created,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      })
      setPrompt('')
      setChoiceOptions(emptyChoiceOptions())
      setIntensity(3)
      setQuestionType('OPEN_ENDED')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface p-5"
    >
      <div className="flex items-center gap-2">
        <Plus className="h-4 w-4 text-pf-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-pf-deep">Add a new question</h3>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setQuestionType('OPEN_ENDED')}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            questionType === 'OPEN_ENDED'
              ? 'bg-pf-primary text-white'
              : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
          }`}
        >
          Open-ended
        </button>
        <button
          type="button"
          onClick={() => setQuestionType('MULTIPLE_CHOICE')}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            questionType === 'MULTIPLE_CHOICE'
              ? 'bg-pf-primary text-white'
              : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
          }`}
        >
          Soft multiple-choice
        </button>
      </div>

      <textarea
        value={prompt}
        maxLength={500}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="e.g. Ask what the guest's favorite part of the visit was, so we can learn what resonates most."
        className="mt-4 min-h-24 w-full rounded-2xl border border-pf-light bg-pf-white px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
      />

      {questionType === 'MULTIPLE_CHOICE' ? (
        <div className="mt-3 space-y-2">
          {choiceOptions.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={option}
                maxLength={100}
                onChange={(event) => {
                  const next = [...choiceOptions]
                  next[index] = event.target.value
                  setChoiceOptions(next)
                }}
                placeholder={`Option ${index + 1}`}
                className="min-h-10 w-full rounded-2xl border border-pf-light bg-pf-white px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              />
              {choiceOptions.length > 2 ? (
                <button
                  type="button"
                  onClick={() => setChoiceOptions(choiceOptions.filter((_, i) => i !== index))}
                  className="text-pf-deep/40 hover:text-rose-500"
                  aria-label="Remove option"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ))}
          {choiceOptions.length < 4 ? (
            <button
              type="button"
              onClick={() => setChoiceOptions([...choiceOptions, ''])}
              className="text-xs font-medium text-pf-accent hover:underline"
            >
              + Add option
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-medium text-pf-deep/60">
          <span>How often the AI pushes this question</span>
          <span>{intensity}/5</span>
        </div>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={intensity}
          onChange={(event) => setIntensity(Number(event.target.value))}
          className="mt-2 w-full accent-pf-accent"
        />
      </div>

      {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}

      <button
        type="submit"
        disabled={saving || !prompt.trim() || !hasEnoughOptions}
        className="mt-4 inline-flex min-h-10 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Adding...' : 'Add question'}
      </button>
    </form>
  )
}

export function EngagementQuestionsManager({
  initialMode,
  initialQuestions,
}: EngagementQuestionsManagerProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [mode, setMode] = useState<TenantEngagementMode>(initialMode)
  const [questions, setQuestions] = useState<EngagementQuestion[]>(initialQuestions)
  const [modeSaving, setModeSaving] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)

  async function handleModeChange(next: TenantEngagementMode) {
    if (next === mode) return

    setModeSaving(true)
    setModeError(null)
    try {
      await client.tenant.setEngagementMode.mutate({ mode: next })
      setMode(next)
    } catch (err) {
      setModeError(getErrorMessage(err))
    } finally {
      setModeSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-deep text-pf-light">
            <Flame className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">Mode</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
              How curious should the AI be?
            </h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              This applies to every active question below.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {MODE_OPTIONS.map((option) => {
            const isSelected = mode === option.value

            return (
              <button
                key={option.value}
                type="button"
                disabled={modeSaving}
                onClick={() => void handleModeChange(option.value)}
                className={`rounded-[1.5rem] border p-5 text-left transition disabled:opacity-60 ${
                  isSelected
                    ? 'border-pf-accent bg-pf-accent/5'
                    : 'border-pf-light bg-pf-surface hover:border-pf-accent/40 hover:bg-pf-white'
                }`}
              >
                <p className="text-lg font-semibold text-pf-deep">{option.label}</p>
                <p className="mt-2 text-sm leading-6 text-pf-deep/60">{option.description}</p>
              </button>
            )
          })}
        </div>
        {modeError ? <p className="mt-4 text-sm text-rose-600">{modeError}</p> : null}
      </section>

      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-accent/10 text-pf-primary">
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              Questions
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
              Your engagement questions
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/60">
              The AI rephrases each one in its own words and picks its moment, so it will not ask
              every question every conversation.
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          {questions.length === 0 ? (
            <p className="text-sm text-pf-deep/40">No engagement questions yet.</p>
          ) : (
            questions.map((question) => (
              <QuestionCard
                key={question.id}
                client={client}
                question={question}
                onUpdated={(updated) =>
                  setQuestions((current) =>
                    current.map((item) => (item.id === updated.id ? updated : item)),
                  )
                }
                onDeleted={(id) =>
                  setQuestions((current) => current.filter((item) => item.id !== id))
                }
              />
            ))
          )}

          <NewQuestionForm
            client={client}
            onCreated={(created) => setQuestions((current) => [...current, created])}
          />
        </div>
      </section>
    </div>
  )
}
