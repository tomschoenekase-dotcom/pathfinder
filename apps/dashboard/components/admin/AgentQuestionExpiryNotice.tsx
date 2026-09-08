import Link from 'next/link'

export function AgentQuestionExpiryNotice({
  tenantId,
  venueId,
  agentRunId,
}: {
  tenantId: string
  venueId: string
  agentRunId?: string | null | undefined
}) {
  const base = `/admin/clients/${encodeURIComponent(tenantId)}/venues/${encodeURIComponent(venueId)}/agents`
  return (
    <div
      className="mt-4 border-l-2 border-amber-400 pl-4 text-sm leading-6 text-slate-800"
      role="status"
    >
      <p className="font-semibold">Response window closed</p>
      <p>
        {agentRunId
          ? 'Review the linked run. If it is still blocked, cancel it before starting a replacement task.'
          : 'This question can no longer be answered. Start a new task if the question still needs work.'}
      </p>
      <Link
        className="inline-flex min-h-11 items-center font-semibold text-sky-800 underline underline-offset-4"
        href={agentRunId ? `${base}/runs/${encodeURIComponent(agentRunId)}` : `${base}#new-task`}
      >
        {agentRunId ? 'Open linked run' : 'Start a new task'}
      </Link>
    </div>
  )
}
