'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  STAFF_INTERVIEW_QUESTION_SETS,
  type StaffInterviewPrivacy,
  type StaffInterviewRole,
  type StaffInterviewSubmission,
} from '@pathfinder/contracts/staff-interview'

import { browserUuid } from '../lib/browser-uuid'

type AnswerDraft = {
  mode: 'ANSWER' | 'SKIP' | 'REDACT'
  text: string
  privacy: StaffInterviewPrivacy
  uncertain: boolean
  confidence: number
}

function draftsFor(role: StaffInterviewRole): Record<string, AnswerDraft> {
  return Object.fromEntries(
    STAFF_INTERVIEW_QUESTION_SETS[role].map((question) => [
      question.id,
      {
        mode: 'ANSWER',
        text: '',
        privacy: question.defaultPrivacy,
        uncertain: false,
        confidence: 0.8,
      },
    ]),
  )
}

function hasMeaningfulDrafts(
  draftsByRole: Partial<Record<StaffInterviewRole, Record<string, AnswerDraft>>>,
): boolean {
  return Object.entries(draftsByRole).some(([role, drafts]) =>
    Object.entries(drafts ?? {}).some(([questionId, draft]) => {
      const question = STAFF_INTERVIEW_QUESTION_SETS[role as StaffInterviewRole].find(
        (candidate) => candidate.id === questionId,
      )
      return Boolean(
        draft.text ||
        draft.mode !== 'ANSWER' ||
        draft.privacy !== question?.defaultPrivacy ||
        draft.uncertain ||
        draft.confidence !== 0.8,
      )
    }),
  )
}

export function StaffInterviewCapture({
  disabled,
  clientFacing = false,
  onSubmit,
  onDirtyChange,
}: {
  disabled: boolean
  clientFacing?: boolean
  onSubmit: (input: {
    displayName: string
    requestId: string
    submission: StaffInterviewSubmission
  }) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [role, setRole] = useState<StaffInterviewRole>('EXECUTIVE')
  const [displayName, setDisplayName] = useState('')
  const [draftsByRole, setDraftsByRole] = useState<
    Partial<Record<StaffInterviewRole, Record<string, AnswerDraft>>>
  >(() => ({ EXECUTIVE: draftsFor('EXECUTIVE') }))
  const [consent, setConsent] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(browserUuid)
  const submittingRef = useRef(false)
  const questions = STAFF_INTERVIEW_QUESTION_SETS[role]
  const drafts = draftsByRole[role] ?? draftsFor(role)
  const dirty = Boolean(displayName || consent || hasMeaningfulDrafts(draftsByRole))

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  const incomplete = useMemo(
    () =>
      questions.some((question) => {
        const draft = drafts[question.id]
        return !draft || (draft.mode === 'ANSWER' && !draft.text.trim())
      }),
    [drafts, questions],
  )

  function update(questionId: string, patch: Partial<AnswerDraft>) {
    setRequestId(browserUuid())
    setDraftsByRole((current) => {
      const roleDrafts = current[role] ?? draftsFor(role)
      return {
        ...current,
        [role]: {
          ...roleDrafts,
          [questionId]: { ...roleDrafts[questionId]!, ...patch },
        },
      }
    })
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (submittingRef.current) return
    setMessage(null)
    if (incomplete || !consent || !displayName.trim()) {
      setMessage(
        'Complete every question with an answer, explicit skip, or redaction, then accept consent.',
      )
      return
    }
    const answers = questions.map((question) => {
      const draft = drafts[question.id]!
      return {
        questionId: question.id,
        ...(draft.mode === 'ANSWER' ? { text: draft.text.trim() } : {}),
        privacy: draft.privacy,
        skipped: draft.mode === 'SKIP',
        redacted: draft.mode === 'REDACT',
        uncertain: draft.uncertain,
        confidence: draft.confidence,
      }
    })
    submittingRef.current = true
    try {
      await onSubmit({
        displayName: displayName.trim(),
        requestId,
        submission: {
          role,
          consentToUse: true,
          acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
          answers,
        },
      })
      setDisplayName('')
      setDraftsByRole((current) => ({ ...current, [role]: draftsFor(role) }))
      setConsent(false)
      setRequestId(browserUuid())
    } catch {
      // The parent announces the failure; retain this request key and form for an exact retry.
    } finally {
      submittingRef.current = false
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={disabled} className="space-y-5">
        <legend className="font-semibold text-pf-deep">
          {clientFacing ? 'Share staff knowledge' : 'Text-only staff interview'}
        </legend>
        <p className="text-sm leading-6 text-pf-deep/75">
          {clientFacing
            ? 'Written answers help the Torchiko team understand your venue. Choose how each answer may be used; skipped or redacted answers retain no text. This form does not accept recordings.'
            : 'Public-candidate text may be reviewed. Internal and private text is converted to evidence hashes only; skipped and redacted answers retain no text. No recording, audio, or video is accepted.'}
        </p>
        <label className="block text-sm font-medium text-pf-deep">
          Interview name
          <input
            required
            maxLength={255}
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value)
              setRequestId(browserUuid())
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          />
        </label>
        <label className="block text-sm font-medium text-pf-deep">
          Staff role
          <select
            value={role}
            onChange={(event) => {
              const nextRole = event.target.value as StaffInterviewRole
              setRole(nextRole)
              setDraftsByRole((current) =>
                current[nextRole] ? current : { ...current, [nextRole]: draftsFor(nextRole) },
              )
              setRequestId(browserUuid())
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            {Object.keys(STAFF_INTERVIEW_QUESTION_SETS).map((option) => (
              <option key={option} value={option}>
                {option.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <ol className="space-y-4" aria-label={`${role.replaceAll('_', ' ')} interview questions`}>
          {questions.map((question, index) => {
            const draft = drafts[question.id]!
            const privacyOptions = (
              ['PUBLIC_CANDIDATE', 'INTERNAL_CONTEXT', 'PRIVATE'] as const
            ).slice(
              ['PUBLIC_CANDIDATE', 'INTERNAL_CONTEXT', 'PRIVATE'].indexOf(question.defaultPrivacy),
            )
            return (
              <li key={question.id} className="rounded-xl border border-pf-light p-4">
                <fieldset>
                  <legend className="text-sm font-medium text-pf-deep">
                    {index + 1}. {question.prompt}{' '}
                    <span className="text-xs font-normal text-pf-deep/60">
                      ({question.required ? 'required context' : 'optional context'})
                    </span>
                  </legend>
                  <div className="mt-3 flex flex-wrap gap-4 text-sm">
                    {(['ANSWER', 'SKIP', 'REDACT'] as const).map((mode) => (
                      <label key={mode} className="flex min-h-11 items-center gap-2">
                        <input
                          type="radio"
                          name={`${question.id}-mode`}
                          checked={draft.mode === mode}
                          onChange={() =>
                            update(question.id, { mode, text: mode === 'ANSWER' ? draft.text : '' })
                          }
                        />
                        {mode === 'ANSWER'
                          ? 'Provide answer'
                          : mode === 'SKIP'
                            ? 'Explicitly skip'
                            : 'Redact'}
                      </label>
                    ))}
                  </div>
                  {draft.mode === 'ANSWER' ? (
                    <label className="mt-2 block text-sm text-pf-deep">
                      Written answer
                      <textarea
                        required
                        maxLength={20000}
                        rows={4}
                        value={draft.text}
                        onChange={(event) => update(question.id, { text: event.target.value })}
                        className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                      />
                    </label>
                  ) : (
                    <p className="mt-2 text-sm text-pf-deep/65">
                      {draft.mode === 'SKIP'
                        ? clientFacing
                          ? 'This question will be marked as skipped without retaining an answer.'
                          : 'The manifest will record an explicit refusal without text.'
                        : clientFacing
                          ? 'This answer will be redacted without retaining its text.'
                          : 'The manifest will record redaction without text or a text hash.'}
                    </p>
                  )}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm text-pf-deep">
                      Privacy
                      <select
                        value={draft.privacy}
                        onChange={(event) =>
                          update(question.id, {
                            privacy: event.target.value as StaffInterviewPrivacy,
                          })
                        }
                        className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
                      >
                        {privacyOptions.map((option) => (
                          <option key={option} value={option}>
                            {clientFacing
                              ? option === 'PUBLIC_CANDIDATE'
                                ? 'May be used for visitors'
                                : option === 'INTERNAL_CONTEXT'
                                  ? 'Torchiko team only'
                                  : 'Private—do not retain the text'
                              : option.replaceAll('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm text-pf-deep">
                      Confidence
                      <select
                        value={draft.confidence}
                        onChange={(event) =>
                          update(question.id, { confidence: Number(event.target.value) })
                        }
                        className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
                      >
                        <option value={1}>High</option>
                        <option value={0.8}>Medium</option>
                        <option value={0.5}>Low</option>
                      </select>
                    </label>
                  </div>
                  <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-pf-deep">
                    <input
                      type="checkbox"
                      checked={draft.uncertain}
                      onChange={(event) => update(question.id, { uncertain: event.target.checked })}
                    />
                    Mark this response uncertain for reviewer attention
                  </label>
                </fieldset>
              </li>
            )
          })}
        </ol>
        <label className="flex items-start gap-2 text-sm text-pf-deep">
          <input
            required
            type="checkbox"
            checked={consent}
            onChange={(event) => {
              setConsent(event.target.checked)
              setRequestId(browserUuid())
            }}
            className="mt-1"
          />
          <span>{STAFF_INTERVIEW_CONSENT_TEXT}</span>
        </label>
      </fieldset>
      <button
        type="submit"
        disabled={disabled || incomplete || !consent || !displayName.trim()}
        className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {disabled
          ? clientFacing
            ? 'Sharing…'
            : 'Recording…'
          : clientFacing
            ? 'Share staff answers'
            : 'Record review proposal'}
      </button>
      <p aria-live="polite" className="text-sm text-rose-700">
        {message}
      </p>
    </form>
  )
}
