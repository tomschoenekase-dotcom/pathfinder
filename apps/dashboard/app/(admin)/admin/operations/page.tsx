export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { OperationsAttentionConsole } from '../../../../components/admin/OperationsAttentionConsole'
import { FounderOperatingConversation } from '../../../../components/admin/FounderOperatingConversation'
import { FounderCharacterReviewInbox } from '../../../../components/admin/FounderCharacterReviewInbox'
import { BotMakerWorkspace } from '../../../../components/admin/BotMakerWorkspace'
import { OperationsReadinessSummary } from '../../../../components/admin/OperationsReadinessSummary'
import { ReleaseEvidenceRecorder } from '../../../../components/admin/ReleaseEvidenceRecorder'
import { ReleaseEvidenceSummary } from '../../../../components/admin/ReleaseEvidenceSummary'
import { GlobalAiIncidentControl } from '../../../../components/admin/GlobalAiIncidentControl'
import { AiProviderHealthControl } from '../../../../components/admin/AiProviderHealthControl'
import { OperationsAnchorRedirect } from '../../../../components/admin/OperationsAnchorRedirect'
import { createAdminCaller } from '../../../../lib/admin-caller'
import { auth } from '@pathfinder/auth/server'

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
  const view =
    query.view === 'work' || query.view === 'bot-maker' || query.view === 'system'
      ? query.view
      : 'now'
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
          System operations
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Inspect work, controls, and evidence. Your decisions are gathered on the Needs you home.
        </p>
      </header>

      <nav aria-label="Control Room views" className="flex flex-wrap border-b border-slate-300">
        {(
          [
            ['/admin/operations', 'Overview'],
            ['/admin/operations?view=work', 'Work and approvals'],
            ['/admin/operations?view=bot-maker', 'Bot Maker'],
            ['/admin/operations?view=system', 'System evidence'],
          ] as const
        ).map(([href, label]) => {
          const active =
            (label === 'Overview' && view === 'now') ||
            (label === 'Work and approvals' && view === 'work') ||
            (label === 'Bot Maker' && view === 'bot-maker') ||
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
          <OperationsAnchorRedirect />
          <FounderOperatingConversation exchanges={data.founderConversation} />
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-950">Work that needs you</h2>
            <p className="mt-1 text-sm text-slate-600">
              Questions, approvals and exceptions are gathered on one home.
            </p>
            <Link
              href="/admin"
              className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-sky-800 underline underline-offset-4"
            >
              Open Needs you
            </Link>
            <nav
              aria-label="Detailed work"
              className="flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-100 pt-3 text-sm"
            >
              <Link
                href="/admin/operations?view=work#needs-you-heading"
                className="text-slate-700 underline"
              >
                Questions
              </Link>
              <Link
                href="/admin/operations?view=work#approval-attention-heading"
                className="text-slate-700 underline"
              >
                Approvals
              </Link>
              <Link
                href="/admin/operations?view=work#ai-workforce"
                className="text-slate-700 underline"
              >
                Agent runs
              </Link>
            </nav>
          </section>
        </>
      ) : null}

      {view === 'work' ? <OperationsAttentionConsole actorId={userId} data={data} /> : null}

      {view === 'bot-maker' ? (
        <BotMakerWorkspace
          reviewInbox={<FounderCharacterReviewInbox initial={characterReviews} />}
        />
      ) : null}

      {view === 'system' ? (
        <div className="space-y-6">
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
              <Link
                className="font-semibold underline"
                href="/admin/operations?view=system#incident-control"
              >
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
                <Link
                  className="font-semibold underline"
                  href="/admin/operations?view=system#provider-health-control"
                >
                  Review provider controls
                </Link>
              </p>
            </section>
          ) : null}

          <section id="incident-control" className="scroll-mt-36">
            <GlobalAiIncidentControl
              initialState={{
                paused: incident.paused,
                reason: incident.reason,
                configured: incident.configured,
                malformed: incident.malformed,
                updatedAt: incident.updatedAt?.toISOString() ?? null,
                updatedBy: incident.updatedBy,
              }}
            />
          </section>
          <section id="provider-health-control" className="scroll-mt-36">
            <AiProviderHealthControl
              initialState={{
                overrides: providerHealth.overrides.map((override) => ({
                  ...override,
                  expiresAt: override.expiresAt.toISOString(),
                })),
                activeUnhealthyProviders: providerHealth.activeUnhealthyProviders,
                configured: providerHealth.configured,
                malformed: providerHealth.malformed,
                updatedAt: providerHealth.updatedAt?.toISOString() ?? null,
                updatedBy: providerHealth.updatedBy,
              }}
            />
          </section>

          <OperationsReadinessSummary readiness={readiness} />

          <ReleaseEvidenceSummary evidence={releaseEvidence} />

          {releaseEvidence.current ? null : <ReleaseEvidenceRecorder />}
        </div>
      ) : null}
    </div>
  )
}
