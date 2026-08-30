import React from 'react'

type EvidenceItem = {
  label: string
  reference: string
  summary: string | null
  kind: EvidenceKind | null
  timestampSeconds: number | null
}

type EvidenceKind =
  | 'SOURCE_LINK'
  | 'DOCUMENT_EXCERPT'
  | 'PHOTO'
  | 'VIDEO_TIMESTAMP'
  | 'MAP'
  | 'CANDIDATE_ENTITY'

type CandidateEntity = {
  label: string
  entityType: string | null
  reference: string | null
  summary: string | null
}

type AnswerConsequence = { answer: string; consequence: string }

const evidenceKinds = new Set<EvidenceKind>([
  'SOURCE_LINK',
  'DOCUMENT_EXCERPT',
  'PHOTO',
  'VIDEO_TIMESTAMP',
  'MAP',
  'CANDIDATE_ENTITY',
])

function evidenceItems(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    if (typeof record.label !== 'string' || typeof record.reference !== 'string') return []
    return [
      {
        label: record.label,
        reference: record.reference,
        summary: typeof record.summary === 'string' ? record.summary : null,
        kind:
          typeof record.kind === 'string' && evidenceKinds.has(record.kind as EvidenceKind)
            ? (record.kind as EvidenceKind)
            : null,
        timestampSeconds:
          typeof record.timestampSeconds === 'number' &&
          Number.isInteger(record.timestampSeconds) &&
          record.timestampSeconds >= 0
            ? record.timestampSeconds
            : null,
      },
    ]
  })
}

function proposedFields(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, fieldValue]) => {
    if (key === 'candidateEntities' || key === 'answerConsequences') return []
    if (fieldValue === null) return [[key, 'Not specified']]
    if (typeof fieldValue === 'boolean') return [[key, fieldValue ? 'Yes' : 'No']]
    if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
      if (key === 'confidence' && fieldValue >= 0 && fieldValue <= 1) {
        return [[key, `${Math.round(fieldValue * 100)}%`]]
      }
      return [[key, fieldValue.toLocaleString()]]
    }
    return typeof fieldValue === 'string' ? [[key, fieldValue]] : []
  })
}

function candidateEntities(value: unknown): CandidateEntity[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const candidates = (value as Record<string, unknown>).candidateEntities
  if (!Array.isArray(candidates)) return []
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const record = candidate as Record<string, unknown>
    if (typeof record.label !== 'string') return []
    return [
      {
        label: record.label,
        entityType: typeof record.entityType === 'string' ? record.entityType : null,
        reference: typeof record.reference === 'string' ? record.reference : null,
        summary: typeof record.summary === 'string' ? record.summary : null,
      },
    ]
  })
}

function answerConsequences(value: unknown): AnswerConsequence[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const consequences = (value as Record<string, unknown>).answerConsequences
  if (!Array.isArray(consequences)) return []
  return consequences.flatMap((consequence) => {
    if (!consequence || typeof consequence !== 'object' || Array.isArray(consequence)) return []
    const record = consequence as Record<string, unknown>
    return typeof record.answer === 'string' && typeof record.consequence === 'string'
      ? [{ answer: record.answer, consequence: record.consequence }]
      : []
  })
}

function fieldLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/^./u, (letter) => letter.toUpperCase())
}

function isPublicUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isSafeLink(value: string) {
  return isPublicUrl(value) || value.startsWith('/')
}

function evidenceKindLabel(kind: EvidenceKind | null) {
  if (!kind) return null
  return fieldLabel(kind)
}

function timestampLabel(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  return hours
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`
    : `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export function AgentQuestionEvidence({
  evidence,
  proposedAnswer,
}: {
  evidence: unknown
  proposedAnswer: unknown
}) {
  const items = evidenceItems(evidence)
  const proposal = proposedFields(proposedAnswer)
  const candidates = candidateEntities(proposedAnswer)
  const consequences = answerConsequences(proposedAnswer)
  if (
    items.length === 0 &&
    proposal.length === 0 &&
    candidates.length === 0 &&
    consequences.length === 0
  )
    return null

  return (
    <aside
      aria-label="Question decision evidence"
      className="mt-3 space-y-3 rounded-xl border border-sky-200 bg-sky-50/70 p-3"
    >
      {items.length ? (
        <section>
          <p className="text-xs font-bold uppercase tracking-wide text-sky-950">Evidence</p>
          <ul className="mt-2 space-y-2 text-sm text-slate-700">
            {items.map((item, index) => (
              <li key={`${item.reference}:${index}`} className="rounded-lg bg-white p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-slate-900">{item.label}</p>
                  {evidenceKindLabel(item.kind) ? (
                    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-wide text-sky-900">
                      {evidenceKindLabel(item.kind)}
                    </span>
                  ) : null}
                  {item.kind === 'VIDEO_TIMESTAMP' && item.timestampSeconds !== null ? (
                    <span className="text-xs font-semibold tabular-nums text-slate-500">
                      at {timestampLabel(item.timestampSeconds)}
                    </span>
                  ) : null}
                </div>
                {item.kind === 'PHOTO' && isSafeLink(item.reference) ? (
                  <a href={item.reference} target="_blank" rel="noreferrer" className="mt-2 block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.reference}
                      alt={item.label}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="max-h-52 w-full rounded-lg border border-slate-200 bg-slate-100 object-cover"
                    />
                  </a>
                ) : null}
                {isSafeLink(item.reference) ? (
                  <a
                    className="mt-0.5 block break-all text-sky-800 underline decoration-sky-300 underline-offset-2"
                    href={item.reference}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.reference}
                  </a>
                ) : (
                  <code className="mt-0.5 block break-all text-xs text-slate-600">
                    {item.reference}
                  </code>
                )}
                {item.summary ? <p className="mt-1 leading-5">{item.summary}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proposal.length ? (
        <section>
          <p className="text-xs font-bold uppercase tracking-wide text-sky-950">
            Proposed interpretation
          </p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            {proposal.map(([key, value]) => (
              <div key={key} className="rounded-lg bg-white p-2">
                <dt className="text-xs font-semibold text-slate-500">{fieldLabel(key)}</dt>
                <dd className="mt-0.5 break-words text-sm text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {candidates.length ? (
        <section>
          <p className="text-xs font-bold uppercase tracking-wide text-sky-950">
            Candidate entities
          </p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {candidates.map((candidate, index) => (
              <li
                key={`${candidate.reference ?? candidate.label}:${index}`}
                className="rounded-lg bg-white p-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900">{candidate.label}</p>
                  {candidate.entityType ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-wide text-slate-600">
                      {candidate.entityType}
                    </span>
                  ) : null}
                </div>
                {candidate.summary ? (
                  <p className="mt-1 text-sm leading-5 text-slate-700">{candidate.summary}</p>
                ) : null}
                {candidate.reference ? (
                  isSafeLink(candidate.reference) ? (
                    <a
                      className="mt-1 block break-all text-xs text-sky-800 underline"
                      href={candidate.reference}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {candidate.reference}
                    </a>
                  ) : (
                    <code className="mt-1 block break-all text-xs text-slate-600">
                      {candidate.reference}
                    </code>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {consequences.length ? (
        <section>
          <p className="text-xs font-bold uppercase tracking-wide text-sky-950">
            What each answer changes
          </p>
          <dl className="mt-2 space-y-2">
            {consequences.map((consequence, index) => (
              <div
                key={`${consequence.answer}:${index}`}
                className="rounded-lg bg-white p-2 text-sm"
              >
                <dt className="font-semibold text-slate-900">{consequence.answer}</dt>
                <dd className="mt-0.5 leading-5 text-slate-700">{consequence.consequence}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <p className="text-xs leading-5 text-sky-950/75">
        Review aid only. Answering this question does not approve, apply, or publish a change.
      </p>
    </aside>
  )
}
