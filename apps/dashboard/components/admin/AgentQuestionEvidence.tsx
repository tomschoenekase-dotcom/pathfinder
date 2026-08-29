import React from 'react'

type EvidenceItem = {
  label: string
  reference: string
  summary: string | null
}

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
      },
    ]
  })
}

function proposedFields(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, fieldValue]) => {
    if (fieldValue === null) return [[key, 'Not specified']]
    if (typeof fieldValue === 'boolean') return [[key, fieldValue ? 'Yes' : 'No']]
    if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
      return [[key, fieldValue.toLocaleString()]]
    }
    return typeof fieldValue === 'string' ? [[key, fieldValue]] : []
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

export function AgentQuestionEvidence({
  evidence,
  proposedAnswer,
}: {
  evidence: unknown
  proposedAnswer: unknown
}) {
  const items = evidenceItems(evidence)
  const proposal = proposedFields(proposedAnswer)
  if (items.length === 0 && proposal.length === 0) return null

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
                <p className="font-semibold text-slate-900">{item.label}</p>
                {isPublicUrl(item.reference) ? (
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

      <p className="text-xs leading-5 text-sky-950/75">
        Review aid only. Answering this question does not approve, apply, or publish a change.
      </p>
    </aside>
  )
}
