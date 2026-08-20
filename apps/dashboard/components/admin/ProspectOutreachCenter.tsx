'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Mail, ShieldCheck } from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'

type Campaigns = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspectCampaigns']['query']>
>
type Readiness = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['getProspectOutreachReadiness']['query']>
>

export function ProspectOutreachCenter({
  fixture,
}: { fixture?: { campaigns: Campaigns; readiness: Readiness } } = {}) {
  const client = useTRPCClient()
  const [campaigns, setCampaigns] = useState<Campaigns>(fixture?.campaigns ?? [])
  const [readiness, setReadiness] = useState<Readiness | null>(fixture?.readiness ?? null)
  useEffect(() => {
    if (!fixture)
      void Promise.all([
        client.admin.listProspectCampaigns.query(),
        client.admin.getProspectOutreachReadiness.query(),
      ]).then(([nextCampaigns, nextReadiness]) => {
        setCampaigns(nextCampaigns)
        setReadiness(nextReadiness)
      })
  }, [client, fixture])
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
            Human-controlled delivery
          </p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Outreach center</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Agents can research and draft. You review frozen messages, approve an exact recipient
            batch, then explicitly release only that batch.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href="/api/integrations/gmail/oauth/start"
            className="rounded-xl border border-sky-300 px-4 py-2.5 text-center text-sm font-semibold text-sky-800"
          >
            Connect Gmail
          </a>
          <Link
            href="/admin/prospects"
            className="rounded-xl bg-sky-600 px-4 py-2.5 text-center text-sm font-semibold text-white"
          >
            Build a cohort
          </Link>
        </div>
      </div>
      <section className="grid gap-3 md:grid-cols-3" aria-label="Outreach readiness">
        <ReadinessCard
          title="Agent boundary"
          ready={
            readiness?.policy.agentsMayDraft === true && readiness?.policy.agentsMaySend === false
          }
          detail="Draft access only; approve and send tools are absent."
        />
        <ReadinessCard
          title="Outbound provider"
          ready={readiness?.deliveryEnabled === true && readiness?.providerConfigured === true}
          detail={
            readiness?.deliveryEnabled
              ? 'Server delivery control is active; exact Gmail mailbox health still applies.'
              : 'Dark by default. No delivery can occur.'
          }
        />
        <ReadinessCard
          title="Gmail synchronization"
          ready={
            readiness?.accounts?.some(
              (account) =>
                account.connectionStatus === 'CONNECTED' &&
                Boolean(account.lastSuccessfulSyncAt) &&
                !account.healthErrorCode,
            ) === true
          }
          detail={
            readiness?.accounts?.length
              ? `${readiness.accounts.length} mailbox account${readiness.accounts.length === 1 ? '' : 's'} registered.`
              : 'No Gmail mailbox is connected. Provider fixtures do not count as configuration.'
          }
        />
      </section>
      {readiness?.accounts?.length ? (
        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          aria-labelledby="mailbox-health-heading"
        >
          <h2 id="mailbox-health-heading" className="font-semibold text-slate-950">
            Gmail mailbox health
          </h2>
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {readiness.accounts.map((account) => (
              <li key={account.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-slate-950">{account.mailboxAddress}</p>
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-700">
                    {account.connectionStatus}
                  </span>
                </div>
                <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                  <div>
                    <dt className="font-bold text-slate-800">Last sync</dt>
                    <dd>
                      {account.lastSuccessfulSyncAt
                        ? new Date(account.lastSuccessfulSyncAt).toLocaleString()
                        : 'Never'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold text-slate-800">Last reconciliation</dt>
                    <dd>
                      {account.lastReconciliationAt
                        ? new Date(account.lastReconciliationAt).toLocaleString()
                        : 'Never'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold text-slate-800">Watch expiration</dt>
                    <dd>
                      {account.watchExpiration
                        ? new Date(account.watchExpiration).toLocaleString()
                        : 'Not active'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold text-slate-800">Delivery</dt>
                    <dd>
                      {account.deliveryEnabled && !account.pausedAt ? 'eligible' : 'paused/off'}
                    </dd>
                  </div>
                </dl>
                {account.healthErrorSummary ? (
                  <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">
                    {account.healthErrorCode ? `${account.healthErrorCode}: ` : ''}
                    {account.healthErrorSummary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4">
          <Mail className="h-4 w-4 text-sky-700" />
          <h2 className="font-semibold text-slate-950">Campaigns</h2>
        </div>
        {!campaigns.length ? (
          <div className="p-12 text-center">
            <p className="font-semibold text-slate-900">No campaigns yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Select a filtered cohort in the prospect directory to start one.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {campaigns.map((campaign) => (
              <li key={campaign.id}>
                <Link
                  href={`/admin/prospects/outreach/${campaign.id}`}
                  className="grid gap-3 px-5 py-4 hover:bg-sky-50/40 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div>
                    <p className="font-semibold text-slate-950">{campaign.name}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {campaign._count.members} recipients · {campaign._count.drafts} drafts ·{' '}
                      {campaign._count.sendBatches} batches
                    </p>
                  </div>
                  <span className="self-center rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
                    {campaign.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ReadinessCard({
  title,
  ready,
  detail,
}: {
  title: string
  ready: boolean
  detail: string
}) {
  return (
    <article
      className={`rounded-2xl border p-5 shadow-sm ${ready ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}
    >
      <div className="flex items-center gap-2">
        {ready ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-700" />
        ) : (
          <AlertTriangle className="h-5 w-5 text-amber-700" />
        )}
        <h2 className="font-semibold text-slate-950">{title}</h2>
      </div>
      <p className="mt-2 text-sm leading-5 text-slate-600">{detail}</p>
      {title === 'Agent boundary' ? <ShieldCheck className="mt-3 h-4 w-4 text-slate-400" /> : null}
    </article>
  )
}
