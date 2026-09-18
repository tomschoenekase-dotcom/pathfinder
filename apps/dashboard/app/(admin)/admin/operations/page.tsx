export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { OperationsAttentionConsole } from '../../../../components/admin/OperationsAttentionConsole'
import { FounderOperatingConversation } from '../../../../components/admin/FounderOperatingConversation'
import { FounderCharacterReviewInbox } from '../../../../components/admin/FounderCharacterReviewInbox'
import { OperationsReadinessSummary } from '../../../../components/admin/OperationsReadinessSummary'
import { ReleaseEvidenceRecorder } from '../../../../components/admin/ReleaseEvidenceRecorder'
import { ReleaseEvidenceSummary } from '../../../../components/admin/ReleaseEvidenceSummary'
import { createAdminCaller } from '../../../../lib/admin-caller'
import { auth } from '@clerk/nextjs/server'

type Cursor = { createdAt: string; id: string }

function cursor(value: string | string[] | undefined): Cursor | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  const separator = raw.indexOf('|')
  if (separator < 1) return undefined
  const createdAt = raw.slice(0, separator)
  const id = raw.slice(separator + 1)
  if (!id || id.length > 191) return undefined
  try {
    return new Date(createdAt).toISOString() === createdAt ? { createdAt, id } : undefined
  } catch {
    return undefined
  }
}

export default async function AdminOperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { userId } = await auth()
  const caller = await createAdminCaller()
  const query = await searchParams
  const view = query.view === 'work' || query.view === 'system' ? query.view : 'now'
  const [data, readiness, releaseEvidence, incident, providerHealth, characterReviews] =
    await Promise.all([
      caller.admin.attentionConsole({
        limit: 10,
        ...(cursor(query.jobsCursor) ? { jobsCursor: cursor(query.jobsCursor) } : {}),
        ...(cursor(query.evaluationsCursor)
          ? { evaluationsCursor: cursor(query.evaluationsCursor) }
          : {}),
        ...(cursor(query.approvalsCursor)
          ? { approvalsCursor: cursor(query.approvalsCursor) }
          : {}),
        ...(cursor(query.supportCursor) ? { supportCursor: cursor(query.supportCursor) } : {}),
        ...(cursor(query.agentsCursor) ? { agentsCursor: cursor(query.agentsCursor) } : {}),
        ...(cursor(query.questionsCursor)
          ? { questionsCursor: cursor(query.questionsCursor) }
          : {}),
        ...(cursor(query.workingAgentsCursor)
          ? { workingAgentsCursor: cursor(query.workingAgentsCursor) }
          : {}),
        ...(cursor(query.blockedAgentsCursor)
          ? { blockedAgentsCursor: cursor(query.blockedAgentsCursor) }
          : {}),
        ...(cursor(query.completedAgentsCursor)
          ? { completedAgentsCursor: cursor(query.completedAgentsCursor) }
          : {}),
        ...(cursor(query.outcomesCursor) ? { outcomesCursor: cursor(query.outcomesCursor) } : {}),
        ...(cursor(query.eventsCursor) ? { eventsCursor: cursor(query.eventsCursor) } : {}),
        ...(cursor(query.platformEventsCursor)
          ? { platformEventsCursor: cursor(query.platformEventsCursor) }
          : {}),
      }),
      caller.admin.operationsReadiness(),
      caller.admin.releaseEvidence({ limit: 5 }),
      caller.admin.getGlobalAiControl(),
      caller.admin.getAiProviderHealthControl(),
      caller.admin.listCharacterCandidateReviews({ limit: 12 }),
    ])

  return (
    <div className="space-y-6">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
          Founder operations
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Founder Control Room
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Talk to Torchiko’s operating snapshot, handle the work that needs you, and inspect deeper
          system evidence without putting every control on one endless page.
        </p>
      </header>

      <nav aria-label="Control Room views" className="flex flex-wrap border-b border-slate-300">
        {(
          [
            ['/admin/operations', 'Now'],
            ['/admin/operations?view=work', 'Work and approvals'],
            ['/admin/operations?view=system', 'System evidence'],
            ['/admin/ai', 'AI systems'],
          ] as const
        ).map(([href, label]) => {
          const active =
            (label === 'Now' && view === 'now') ||
            (label === 'Work and approvals' && view === 'work') ||
            (label === 'System evidence' && view === 'system')
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`min-h-11 border-b-2 px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${active ? 'border-sky-700 text-sky-900' : 'border-transparent text-slate-600 hover:text-slate-950'}`}
            >
              {label}
            </Link>
          )
        })}
      </nav>

      {view === 'now' ? (
        <>
          <FounderOperatingConversation exchanges={data.founderConversation} />
          <OperationsAttentionConsole actorId={userId} data={data} summaryOnly />
        </>
      ) : null}

      {view === 'work' ? <OperationsAttentionConsole actorId={userId} data={data} /> : null}

      {view === 'system' ? (
        <div className="space-y-6">
          <FounderCharacterReviewInbox initial={characterReviews} />

          <section
            aria-label="Global AI incident state"
            className={`rounded-2xl border p-4 text-sm ${incident.paused || incident.malformed ? 'border-rose-200 bg-rose-50 text-rose-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}
          >
            <p className="font-semibold">
              {incident.malformed
                ? 'Global AI incident state needs review'
                : incident.paused
                  ? 'Global AI provider work is paused'
                  : 'Global AI provider work is available'}
            </p>
            <p className="mt-1 opacity-80">
              {incident.reason || 'No incident reason is recorded.'}{' '}
              <Link className="font-semibold underline" href="/admin#incident-control">
                Review incident control
              </Link>
            </p>
          </section>

          {providerHealth.malformed || providerHealth.activeUnhealthyProviders.length > 0 ? (
            <section
              aria-label="AI provider routing health"
              className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
            >
              <p className="font-semibold">
                {providerHealth.malformed
                  ? 'AI provider routing is fail-closed'
                  : `${providerHealth.activeUnhealthyProviders.length} AI provider ${providerHealth.activeUnhealthyProviders.length === 1 ? 'exclusion is' : 'exclusions are'} active`}
              </p>
              <p className="mt-1 opacity-80">
                {providerHealth.malformed
                  ? 'Repair the malformed provider-health control before provider-backed routing resumes.'
                  : `Excluded: ${providerHealth.activeUnhealthyProviders.join(', ')}. Expiry restores eligibility automatically.`}{' '}
                <Link className="font-semibold underline" href="/admin#provider-health-control">
                  Review provider controls
                </Link>
              </p>
            </section>
          ) : null}

          <OperationsReadinessSummary readiness={readiness} />

          <ReleaseEvidenceSummary evidence={releaseEvidence} />

          {releaseEvidence.current ? null : <ReleaseEvidenceRecorder />}
        </div>
      ) : null}
    </div>
  )
}
