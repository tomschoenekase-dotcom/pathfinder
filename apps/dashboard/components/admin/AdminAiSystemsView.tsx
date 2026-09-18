'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type AiSystems = inferRouterOutputs<AppRouter>['admin']['getAdminAiSystems']
type PlatformWorkerCredential =
  inferRouterOutputs<AppRouter>['admin']['listPlatformWorkerPolicyCredentials'][number]

function formatDate(value: Date | null) {
  return value ? value.toLocaleString() : 'Never'
}

function WorkerCredentialList({ credentials }: { credentials: PlatformWorkerCredential[] }) {
  if (!credentials.length) {
    return (
      <p className="mt-3 text-sm leading-6 text-slate-600">
        No platform-worker credentials have been issued. That is separate from a local Hermes or
        Codex bridge.
      </p>
    )
  }

  return (
    <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
      {credentials.map((credential) => {
        const usable =
          credential.enabled &&
          !credential.revokedAt &&
          (!credential.expiresAt || credential.expiresAt.getTime() > Date.now())
        return (
          <article key={credential.id} className="py-4 first:pt-4 last:pb-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">{credential.label}</h3>
                <p className="mt-1 font-mono text-xs text-slate-600">{credential.workerId}</p>
              </div>
              <p
                className={`text-xs font-semibold ${usable ? 'text-emerald-700' : 'text-slate-600'}`}
              >
                {usable ? 'Enabled' : credential.revokedAt ? 'Revoked' : 'Not enabled'}
              </p>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-600">
              Last used: {formatDate(credential.lastUsedAt)}
              {credential.expiresAt ? ` · Expires: ${formatDate(credential.expiresAt)}` : ''}
            </p>
          </article>
        )
      })}
    </div>
  )
}

function VisitorProviderConnections({
  providers,
}: {
  providers: AiSystems['customerChat']['providerConnections']
}) {
  return (
    <div className="mt-7 max-w-3xl" aria-labelledby="visitor-provider-heading">
      <div>
        <h3 id="visitor-provider-heading" className="text-lg font-semibold text-slate-950">
          Visitor chat providers
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          These connections power public venue chat only. They do not connect Codex, Hermes, the
          Control Room, or any founder-facing agent.
        </p>
      </div>

      <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
        {providers.map((provider) => (
          <article
            key={provider.id}
            className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h4 className="text-sm font-semibold text-slate-950">{provider.name}</h4>
                <span
                  className={`text-xs font-semibold ${
                    provider.configured ? 'text-emerald-700' : 'text-amber-800'
                  }`}
                >
                  {provider.configured ? 'Dashboard key present' : 'Dashboard key missing'}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Server-only Railway variable:{' '}
                <code className="font-mono text-slate-800">{provider.environmentVariable}</code>
              </p>
            </div>
            <p className="text-xs font-medium text-slate-600">
              {provider.configured
                ? 'Eligible to select; web verifies again at dispatch'
                : 'Add key in Railway staging'}
            </p>
          </article>
        ))}
      </div>

      <aside className="mt-4 border-l-2 border-sky-700 pl-4 text-sm leading-6 text-slate-700">
        <p className="font-semibold text-slate-950">Connect or replace a provider</p>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          <li>Create a key in the provider’s own console.</li>
          <li>
            In Railway’s <strong>staging</strong> environment, add the variable shown above to the
            dashboard and web services, then redeploy them.
          </li>
          <li>
            Return here, confirm “Dashboard key present,” then choose an approved model below.
          </li>
        </ol>
        <p className="mt-2 text-xs text-slate-600">
          Torchiko never asks you to paste a provider key into this page. This avoids putting a
          reusable secret in the browser or application database.
        </p>
      </aside>
    </div>
  )
}

function CustomerChatRouting({ customerChat }: { customerChat: AiSystems['customerChat'] }) {
  const client = useTRPCClient()
  const router = useRouter()
  const override = customerChat.workloadOverride
  const [selectedModel, setSelectedModel] = useState(customerChat.effective.primaryModelKey)
  const [reason, setReason] = useState('')
  const [unsafeAcknowledged, setUnsafeAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const selectedOption = customerChat.modelOptions.find((option) => option.key === selectedModel)
  const selectedOptionAvailable = selectedOption?.available === true

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      await client.admin.saveAiWorkloadConfigurationOverride.mutate({
        scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
        expectedRevision: override?.revision ?? null,
        enabled: true,
        values: { primaryModelKey: selectedModel },
        unsafeChangesEnabled: unsafeAcknowledged,
        reason: reason.trim(),
      })
      setStatus('Global guest-chat routing saved. No provider was called from this screen.')
      router.refresh()
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Unable to save global guest-chat routing.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="customer-ai-heading" className="border-t border-slate-200 pt-8">
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-800">
          Customer AI
        </p>
        <h2
          id="customer-ai-heading"
          className="mt-2 text-2xl font-semibold tracking-tight text-slate-950"
        >
          Visitor chat routing
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This changes the global default for the public venue chatbot. It does not configure Tochi,
          an operator agent, or a venue bridge.
        </p>
      </div>

      <VisitorProviderConnections providers={customerChat.providerConnections} />

      <dl className="mt-6 grid gap-x-8 gap-y-4 border-y border-slate-200 py-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Effective route
          </dt>
          <dd className="mt-1 font-semibold text-slate-950">
            {customerChat.effective.provider} / {customerChat.effective.model}
          </dd>
          <dd className="mt-1 text-xs text-slate-600">
            Source: {customerChat.effective.source.toLowerCase()}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Global override
          </dt>
          <dd className="mt-1 font-semibold text-slate-950">
            {override && !override.isTombstone && override.enabled
              ? `Enabled · revision ${override.revision}`
              : 'No enabled override'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Dashboard keys present
          </dt>
          <dd className="mt-1 font-semibold text-slate-950">
            {customerChat.providerConnections.filter((provider) => provider.configured).length} of{' '}
            {customerChat.providerConnections.length} present
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Scoped exceptions
          </dt>
          <dd className="mt-1 font-semibold text-slate-950">
            {customerChat.scopedExceptionCount} enabled client or venue override
            {customerChat.scopedExceptionCount === 1 ? '' : 's'}
          </dd>
        </div>
      </dl>

      <div className="mt-6 max-w-2xl">
        <label className="block text-sm font-semibold text-slate-950" htmlFor="guest-chat-model">
          Default visitor-chat model
        </label>
        <select
          id="guest-chat-model"
          value={selectedModel}
          onChange={(event) => setSelectedModel(event.target.value as typeof selectedModel)}
          className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-950 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
        >
          {customerChat.modelOptions.map((option) => (
            <option key={option.key} value={option.key} disabled={!option.available}>
              {option.provider} / {option.model} · {option.costTier.toLowerCase()}
              {option.available ? '' : ' · unavailable: provider key missing'}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs leading-5 text-slate-600">
          Registered choices only. This page checks the dashboard service. The public web service
          independently verifies its own key before reserving budget or calling a provider, and
          fails closed if it is missing.
        </p>
      </div>

      <div className="mt-5 max-w-2xl space-y-3">
        <label className="block text-sm font-semibold text-slate-950" htmlFor="guest-chat-reason">
          Why are you changing the default?
        </label>
        <textarea
          id="guest-chat-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          className="min-h-24 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
        />
        <label className="flex items-start gap-3 border-l-2 border-amber-400 pl-3 text-sm leading-5 text-slate-700">
          <input
            type="checkbox"
            checked={unsafeAcknowledged}
            onChange={(event) => setUnsafeAcknowledged(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-400 text-sky-700 focus:ring-sky-600"
          />
          <span>
            I understand this changes the default customer-chat model and can affect cost, quality,
            and availability. I have reviewed the provider-key state above.
          </span>
        </label>
        <button
          type="button"
          disabled={busy || !selectedOptionAvailable || !unsafeAcknowledged || !reason.trim()}
          onClick={() => void save()}
          className="inline-flex min-h-11 items-center rounded-lg bg-sky-800 px-4 text-sm font-semibold text-white transition hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {busy ? 'Saving…' : 'Save global chat routing'}
        </button>
        {status ? (
          <p role="status" className="text-sm text-slate-700">
            {status}
          </p>
        ) : null}
        {!selectedOptionAvailable ? (
          <p role="status" className="text-sm text-amber-800">
            This model cannot be selected until its provider key is available.
          </p>
        ) : null}
      </div>

      <aside
        className="mt-8 max-w-3xl border-l-2 border-slate-300 pl-4 text-sm leading-6 text-slate-600"
        aria-label="Current customer AI limits"
      >
        <p className="font-semibold text-slate-900">Current limits</p>
        <p className="mt-1">
          DeepSeek supports approved text-chat models only. OpenRouter and arbitrary provider URLs
          are not admitted yet. Price-tier routing, such as changing models for venues below a
          monthly price, is not implemented. Client and venue overrides can supersede this global
          default.
        </p>
      </aside>
    </section>
  )
}

export function AdminAiSystemsView({
  systems,
  credentials,
}: {
  systems: AiSystems
  credentials: PlatformWorkerCredential[]
}) {
  return (
    <div className="space-y-8">
      <header className="max-w-3xl border-b border-slate-200 pb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-800">
          Founder operations
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">AI systems</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          One place to see the boundary between AI that helps run Torchiko and AI that serves venue
          visitors. Credentials and model routes stay separate on purpose.
        </p>
      </header>

      <section aria-labelledby="operator-ai-heading">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-800">
            Operator AI
          </p>
          <h2
            id="operator-ai-heading"
            className="mt-2 text-2xl font-semibold tracking-tight text-slate-950"
          >
            Founder-facing operating help
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            The Control Room records directions and shows operational state deterministically today.
            It is not an authenticated Codex or Hermes chat.
          </p>
        </div>

        <div className="mt-6 max-w-3xl divide-y divide-slate-200 border-y border-slate-200 text-sm leading-6">
          <div className="py-4">
            <h3 className="font-semibold text-slate-950">Hosted subscription boundary</h3>
            <p className="mt-1 text-slate-600">
              Torchiko cannot borrow your Codex or ChatGPT subscription inside the hosted app. A
              local Hermes or Codex bridge has not been installed yet.
            </p>
          </div>
          <div className="py-4">
            <h3 className="font-semibold text-slate-950">Platform-worker credentials</h3>
            <p className="mt-1 text-slate-600">
              These founder-scoped credentials govern platform-worker policy. They are not venue
              agent bridges, provider API keys, or a way to connect a personal subscription.
            </p>
            <WorkerCredentialList credentials={credentials} />
          </div>
        </div>
      </section>

      <CustomerChatRouting customerChat={systems.customerChat} />
    </div>
  )
}
