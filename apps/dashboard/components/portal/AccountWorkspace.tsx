'use client'

import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

import { type DashboardTRPCClient, useTRPCClient } from '../../lib/trpc'
import {
  BoundedClientRequestError,
  runBoundedClientRequest,
} from '../../lib/bounded-client-request'
import { ClientBillingPanel } from '../billing/ClientBillingPanel'
import { ClientTochiPreferenceWorkspace } from '../ClientTochiPreferenceWorkspace'
import {
  PortalNotice,
  PortalPage,
  PortalSection,
  portalButtonPrimary,
  portalButtonSecondary,
  portalInput,
} from './PortalPrimitives'

const SETTINGS_READ_TIMEOUT_MS = 15_000

type SettingsData = Awaited<ReturnType<DashboardTRPCClient['tenant']['getSettings']['query']>>
type SettingsMember = SettingsData['members'][number]
type PendingInvitation = Awaited<
  ReturnType<DashboardTRPCClient['tenant']['listPendingInvitations']['query']>
>[number]

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  STAFF: 'Staff',
}

const INVITE_ROLE_OPTIONS = [
  { label: 'Owner', clerkRole: 'org:admin' },
  { label: 'Staff', clerkRole: 'org:member' },
]

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function getErrorMessage(error: unknown) {
  if (error instanceof BoundedClientRequestError) {
    return 'Your account details couldn’t be loaded. Refresh and try again.'
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return 'Something went wrong. Please try again.'
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function InviteForm({
  client,
  onInvited,
}: {
  client: DashboardTRPCClient
  onInvited: () => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'org:admin' | 'org:member'>('org:member')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim()) return

    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      await client.tenant.inviteMember.mutate({ emailAddress: email.trim(), role })
      setEmail('')
      setSuccess(true)
      await onInvited()
      window.setTimeout(() => setSuccess(false), 6000)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 rounded-lg border border-tk-rule bg-white p-4">
      <h3 className="text-sm font-semibold">Invite someone</h3>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="invite-email" className="mb-1 block text-sm text-tk-soft">
            Email address
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="colleague@example.com"
            className={portalInput}
          />
        </div>
        <div className="w-full sm:w-36">
          <label htmlFor="invite-role" className="mb-1 block text-sm text-tk-soft">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value as 'org:admin' | 'org:member')}
            className={portalInput}
          >
            {INVITE_ROLE_OPTIONS.map((option) => (
              <option key={option.clerkRole} value={option.clerkRole}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={loading || !email.trim()} className={portalButtonPrimary}>
          {loading ? 'Sending…' : 'Send invite'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-tk-danger">
          {error}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="mt-2 text-sm text-tk-moss">
          Invite sent. They’ll appear below once they accept.
        </p>
      ) : null}
    </form>
  )
}

function TeamList({
  members,
  invitations,
}: {
  members: SettingsMember[]
  invitations: PendingInvitation[]
}) {
  return (
    <ul className="mt-4 divide-y divide-tk-rule rounded-lg border border-tk-rule bg-white">
      {members.map((member) => (
        <li key={member.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {member.user.fullName ?? member.user.email}
            </p>
            {member.user.fullName ? (
              <p className="truncate text-[0.8rem] text-tk-soft">{member.user.email}</p>
            ) : null}
          </div>
          <p className="text-sm text-tk-soft">
            {ROLE_LABELS[member.role] ?? member.role}
            {member.status === 'INVITED'
              ? ' · Invited'
              : member.joinedAt
                ? ` · Joined ${formatDate(member.joinedAt)}`
                : ''}
          </p>
        </li>
      ))}
      {invitations.map((invitation) => (
        <li key={invitation.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold">{invitation.emailAddress}</p>
          <p className="text-sm text-tk-soft">
            {invitation.role === 'org:admin' ? 'Owner' : 'Staff'} · Invitation pending
          </p>
        </li>
      ))}
    </ul>
  )
}

export function AccountWorkspace({
  paymentAvailable,
  reportsAvailable,
}: {
  paymentAvailable: boolean
  reportsAvailable: boolean
}) {
  const client = useTRPCClient()

  const [data, setData] = useState<SettingsData | null>(null)
  const [invitations, setInvitations] = useState<PendingInvitation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const settingsGeneration = useRef(0)
  const invitationsGeneration = useRef(0)
  const settingsReadAbort = useRef<AbortController | null>(null)
  const invitationsReadAbort = useRef<AbortController | null>(null)

  async function loadSettings() {
    const generation = ++settingsGeneration.current
    settingsReadAbort.current?.abort()
    const controller = new AbortController()
    settingsReadAbort.current = controller
    setError(null)

    try {
      const settings = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SETTINGS_READ_TIMEOUT_MS,
        request: (signal) => client.tenant.getSettings.query(undefined, { signal }),
      })
      if (settingsGeneration.current !== generation) return
      setData(settings)
      if (settings.canManageTeam) void loadInvitations()
    } catch (err) {
      if (settingsGeneration.current === generation && !controller.signal.aborted)
        setError(getErrorMessage(err))
    } finally {
      if (settingsReadAbort.current === controller) settingsReadAbort.current = null
      if (settingsGeneration.current === generation) setLoading(false)
    }
  }

  async function loadInvitations() {
    const generation = ++invitationsGeneration.current
    invitationsReadAbort.current?.abort()
    const controller = new AbortController()
    invitationsReadAbort.current = controller
    try {
      const pending = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SETTINGS_READ_TIMEOUT_MS,
        request: (signal) => client.tenant.listPendingInvitations.query(undefined, { signal }),
      })
      if (invitationsGeneration.current === generation) setInvitations(pending)
    } catch {
      // Non-critical — the invite form and member list still work without it.
    } finally {
      if (invitationsReadAbort.current === controller) invitationsReadAbort.current = null
    }
  }

  useEffect(() => {
    void loadSettings()
    return () => {
      settingsGeneration.current += 1
      invitationsGeneration.current += 1
      settingsReadAbort.current?.abort()
      invitationsReadAbort.current?.abort()
      settingsReadAbort.current = null
      invitationsReadAbort.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PortalPage title="Account" description="Your organization, team, billing and invoices.">
      <div className="space-y-5">
        {error ? (
          <PortalNotice tone="error" role="alert">
            {error}
          </PortalNotice>
        ) : null}

        <PortalSection id="organization-heading" title="Organization">
          {loading ? (
            <p className="mt-3 text-sm text-tk-soft" role="status">
              Loading…
            </p>
          ) : (
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="text-tk-soft">Name</dt>
              <dd className="break-words font-semibold">{data?.tenant.name ?? '—'}</dd>
              <dt className="text-tk-soft">Plan</dt>
              <dd>{data?.tenant.planTier ? titleCase(data.tenant.planTier) : '—'}</dd>
              <dt className="text-tk-soft">Status</dt>
              <dd>{data?.tenant.status ? titleCase(data.tenant.status) : '—'}</dd>
            </dl>
          )}
        </PortalSection>

        {paymentAvailable ? (
          <div id="payment" className="scroll-mt-20">
            <ClientBillingPanel />
          </div>
        ) : null}

        <PortalSection
          id="team-heading"
          title="Team"
          description={
            data && !data.canManageTeam
              ? 'Owners manage invitations. You can see who has access.'
              : 'Everyone here can use this portal. Owners handle billing and invitations.'
          }
        >
          {data?.canManageTeam ? <InviteForm client={client} onInvited={loadInvitations} /> : null}
          {loading ? (
            <p className="mt-3 text-sm text-tk-soft" role="status">
              Loading team…
            </p>
          ) : data?.members.length ? (
            <TeamList members={data.members} invitations={invitations} />
          ) : (
            <p className="mt-3 text-sm text-tk-soft">No team members found.</p>
          )}
        </PortalSection>

        {reportsAvailable ? (
          <PortalSection
            id="reports-heading"
            title="Reports"
            description="Summaries Torchiko has published for your venue."
          >
            <Link href="/weekly-reports" className={`${portalButtonSecondary} mt-3`}>
              Open reports
            </Link>
          </PortalSection>
        ) : null}

        <section className="rounded-xl border border-tk-rule bg-tk-card p-5 sm:p-6">
          <ClientTochiPreferenceWorkspace />
        </section>
      </div>
    </PortalPage>
  )
}
