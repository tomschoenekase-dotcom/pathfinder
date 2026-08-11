'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  STAFF_INTERVIEW_QUESTION_SETS,
  type StaffInterviewPrivacy,
  type StaffInterviewRole,
} from '@pathfinder/contracts/staff-interview'

import { useTRPCClient } from '../lib/trpc'

type Proposal = {
  id: string
  sourceKind: string
  status: string
  displayName: string
  websiteUri: string | null
  createdAt: Date
  _count: { evidence: number; events: number }
  packageHandoff: { packageDraftId: string; createdAt: Date } | null
}

export function IntakeProposalWorkspace({
  venueId,
  proposals,
  adminTenantId,
}: {
  venueId: string
  proposals: Proposal[]
  adminTenantId?: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [kind, setKind] = useState<'WEBSITE' | 'INTERVIEW'>('WEBSITE')
  const [displayName, setDisplayName] = useState('')
  const [source, setSource] = useState('')
  const [interviewRole, setInterviewRole] = useState<StaffInterviewRole>('EXECUTIVE')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [privacy, setPrivacy] = useState<Record<string, StaffInterviewPrivacy>>({})
  const [consentToUse, setConsentToUse] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const proposal =
        kind === 'WEBSITE'
          ? ({ kind, displayName, websiteUri: source } as const)
          : ({
              kind,
              displayName,
              submission: {
                role: interviewRole,
                consentToUse,
                acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
                answers: STAFF_INTERVIEW_QUESTION_SETS[interviewRole]
                  .filter((question) => answers[question.id]?.trim())
                  .map((question) => ({
                    questionId: question.id,
                    text: answers[question.id]?.trim(),
                    privacy: privacy[question.id] ?? question.defaultPrivacy,
                    skipped: false,
                    redacted: false,
                    uncertain: false,
                    confidence: 0.8,
                  })),
              },
            } as const)
      if (adminTenantId) {
        await client.admin.createIntakeProposal.mutate({
          tenantId: adminTenantId,
          venueId,
          ...proposal,
        })
      } else {
        await client.intake.createProposal.mutate({ venueId, ...proposal })
      }
      setDisplayName('')
      setSource('')
      setAnswers({})
      setPrivacy({})
      setConsentToUse(false)
      setMessage('Draft proposal recorded for review. Nothing was approved, applied, or published.')
      router.refresh()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The proposal was not recorded. No changes were published.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-7">
      <form
        onSubmit={(event) => {
          void submit(event)
        }}
        className="space-y-4 rounded-2xl border border-pf-light bg-white p-5"
      >
        <fieldset disabled={busy}>
          <legend className="font-semibold text-pf-deep">New draft proposal</legend>
          <p className="mt-1 text-sm text-pf-deep/75">
            Capture a website address or a text-only interview. This does not crawl a site or
            publish content.
          </p>
          <div className="mt-4 flex gap-4">
            <label>
              <input
                type="radio"
                checked={kind === 'WEBSITE'}
                onChange={() => {
                  setKind('WEBSITE')
                  setSource('')
                }}
              />{' '}
              Website
            </label>
            <label>
              <input
                type="radio"
                checked={kind === 'INTERVIEW'}
                onChange={() => {
                  setKind('INTERVIEW')
                  setSource('')
                }}
              />{' '}
              Text interview
            </label>
          </div>
          <label className="mt-4 block text-sm font-medium text-pf-deep">
            Proposal name
            <input
              required
              maxLength={255}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            />
          </label>
          {kind === 'WEBSITE' ? (
            <label className="mt-4 block text-sm font-medium text-pf-deep">
              Website URL
              <input
                required
                type="url"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              />
            </label>
          ) : (
            <div className="mt-4 space-y-4">
              <label className="block text-sm font-medium text-pf-deep">
                Interview role
                <select
                  value={interviewRole}
                  onChange={(event) => {
                    setInterviewRole(event.target.value as StaffInterviewRole)
                    setAnswers({})
                    setPrivacy({})
                  }}
                  className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                >
                  {Object.keys(STAFF_INTERVIEW_QUESTION_SETS).map((role) => (
                    <option key={role} value={role}>
                      {role.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-sm text-pf-deep/75">
                Public-candidate answers retain their text. Internal or private answers retain only
                classification metadata and a verification hash; no recording fields are accepted.
              </p>
              {STAFF_INTERVIEW_QUESTION_SETS[interviewRole].map((question) => {
                const privacyOptions = (
                  ['PUBLIC_CANDIDATE', 'INTERNAL_CONTEXT', 'PRIVATE'] as const
                ).slice(
                  ['PUBLIC_CANDIDATE', 'INTERNAL_CONTEXT', 'PRIVATE'].indexOf(
                    question.defaultPrivacy,
                  ),
                )
                return (
                  <div key={question.id} className="rounded-xl border border-pf-light p-4">
                    <label className="block text-sm font-medium text-pf-deep">
                      {question.prompt}
                      <textarea
                        maxLength={20000}
                        rows={3}
                        value={answers[question.id] ?? ''}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [question.id]: event.target.value,
                          }))
                        }
                        className="mt-2 w-full rounded-xl border border-pf-light px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                      />
                    </label>
                    <label className="mt-2 block text-sm text-pf-deep/75">
                      Privacy classification
                      <select
                        value={privacy[question.id] ?? question.defaultPrivacy}
                        onChange={(event) =>
                          setPrivacy((current) => ({
                            ...current,
                            [question.id]: event.target.value as StaffInterviewPrivacy,
                          }))
                        }
                        className="mt-2 min-h-11 w-full rounded-xl border border-pf-light px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent sm:ml-2 sm:mt-0 sm:w-auto"
                      >
                        {privacyOptions.map((option) => (
                          <option key={option} value={option}>
                            {option.replaceAll('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )
              })}
              <label className="flex items-start gap-2 text-sm text-pf-deep">
                <input
                  required
                  type="checkbox"
                  checked={consentToUse}
                  onChange={(event) => setConsentToUse(event.target.checked)}
                  className="mt-1"
                />
                <span>{STAFF_INTERVIEW_CONSENT_TEXT}</span>
              </label>
            </div>
          )}
        </fieldset>
        <button
          disabled={
            busy ||
            !displayName.trim() ||
            (kind === 'WEBSITE'
              ? !source.trim()
              : !consentToUse || !Object.values(answers).some((answer) => answer.trim()))
          }
          className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {busy ? 'Recording…' : 'Record draft proposal'}
        </button>
        <p aria-live="polite" aria-atomic="true" className="text-sm text-pf-deep/75">
          {message}
        </p>
      </form>
      <section aria-labelledby="proposal-history">
        <h2 id="proposal-history" className="text-xl font-semibold text-pf-deep">
          Proposal history
        </h2>
        {proposals.length ? (
          <ul className="mt-3 space-y-3">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{proposal.displayName}</strong>
                  <span>{proposal.status}</span>
                </div>
                <p className="mt-1 text-sm text-pf-deep/75">
                  {proposal.sourceKind} · {proposal._count.evidence} evidence record(s) ·{' '}
                  {proposal.packageHandoff
                    ? `Draft package ${proposal.packageHandoff.packageDraftId}`
                    : 'Awaiting review handoff'}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/75">
            No intake proposals yet.
          </p>
        )}
      </section>
    </div>
  )
}
