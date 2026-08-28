'use client'

import type { ElementType, FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { Building2, Settings, Users } from 'lucide-react'

import { type DashboardTRPCClient, useTRPCClient } from '../../../lib/trpc'
import { ClientTochiPreferenceWorkspace } from '../../../components/ClientTochiPreferenceWorkspace'

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

const ROLE_COLORS: Record<string, string> = {
  OWNER: 'bg-pf-accent/10 text-pf-accent',
  MANAGER: 'bg-pf-primary/10 text-pf-primary',
  STAFF: 'bg-pf-light/20 text-pf-deep/60',
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  INVITED: 'bg-amber-100 text-amber-700',
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
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

function SectionHeader({ icon: Icon, title }: { icon: ElementType; title: string }) {
  return (
    <div className="mb-6 flex items-center gap-2 border-b border-pf-primary/10 pb-4">
      <Icon className="h-5 w-5 text-pf-accent" aria-hidden="true" />
      <h2 className="text-lg font-semibold text-pf-deep">{title}</h2>
    </div>
  )
}

function PlanBadge({ tier }: { tier: string }) {
  const label = tier.charAt(0).toUpperCase() + tier.slice(1)
  const color =
    tier === 'pro'
      ? 'bg-pf-accent/10 text-pf-accent'
      : tier === 'enterprise'
        ? 'bg-pf-primary/20 text-pf-primary'
        : 'bg-pf-light/20 text-pf-deep/60'

  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const label = status.charAt(0) + status.slice(1).toLowerCase()
  const color =
    status === 'ACTIVE'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'SUSPENDED'
        ? 'bg-rose-100 text-rose-700'
        : 'bg-amber-100 text-amber-700'

  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  )
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
    <form
      onSubmit={handleSubmit}
      className="mt-6 rounded-[1.5rem] border border-pf-primary/10 bg-pf-surface p-5"
    >
      <h3 className="mb-4 text-sm font-semibold text-pf-deep">Invite a team member</h3>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label
            htmlFor="invite-email"
            className="mb-1.5 block text-xs font-medium text-pf-deep/60"
          >
            Email address
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="colleague@example.com"
            className="min-h-10 w-full rounded-2xl border border-pf-light px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          />
        </div>
        <div className="w-full sm:w-40">
          <label htmlFor="invite-role" className="mb-1.5 block text-xs font-medium text-pf-deep/60">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value as 'org:admin' | 'org:member')}
            className="min-h-10 w-full rounded-2xl border border-pf-light bg-white px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          >
            {INVITE_ROLE_OPTIONS.map((option) => (
              <option key={option.clerkRole} value={option.clerkRole}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={loading || !email.trim()}
          className="inline-flex min-h-10 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Sending...' : 'Send invite'}
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
      {success ? (
        <p className="mt-2 text-sm text-emerald-600">
          Invite sent — they&apos;ll receive an email shortly. They&apos;ll appear in the list once
          they accept.
        </p>
      ) : null}
    </form>
  )
}

function MemberRow({ member }: { member: SettingsMember }) {
  return (
    <tr>
      <td className="py-3 pr-4">
        <div className="font-medium text-pf-deep">{member.user.fullName ?? member.user.email}</div>
        {member.user.fullName ? (
          <div className="text-xs text-pf-deep/50">{member.user.email}</div>
        ) : null}
      </td>
      <td className="py-3 pr-4">
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
            ROLE_COLORS[member.role] ?? 'bg-pf-light/20 text-pf-deep/60'
          }`}
        >
          {ROLE_LABELS[member.role] ?? member.role}
        </span>
      </td>
      <td className="py-3 pr-4">
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
            STATUS_COLORS[member.status] ?? 'bg-pf-light/20 text-pf-deep/60'
          }`}
        >
          {member.status === 'INVITED' ? 'Pending' : 'Active'}
        </span>
      </td>
      <td className="py-3 text-pf-deep/60">
        {member.joinedAt ? formatDate(member.joinedAt) : '-'}
      </td>
    </tr>
  )
}

function PendingInvitationsTable({
  invitations,
}: {
  invitations: Array<{ id: string; emailAddress: string; role: string }>
}) {
  if (invitations.length === 0) {
    return null
  }

  return (
    <div className="mt-4 overflow-hidden rounded-[1.5rem] border border-pf-light">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Pending team invitations</caption>
        <thead>
          <tr className="border-b border-pf-light bg-pf-surface">
            <th
              scope="col"
              className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-pf-deep/40"
            >
              Email
            </th>
            <th
              scope="col"
              className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-pf-deep/40"
            >
              Role
            </th>
            <th
              scope="col"
              className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-pf-deep/40"
            >
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {invitations.map((invitation) => (
            <tr key={invitation.id} className="border-b border-pf-light/60 last:border-0">
              <td className="px-4 py-3 font-medium text-pf-deep">{invitation.emailAddress}</td>
              <td className="px-4 py-3 text-pf-deep/60">
                {invitation.role === 'org:admin' ? 'Owner' : 'Staff'}
              </td>
              <td className="px-4 py-3">
                <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                  Pending
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function SettingsPage() {
  const client = useTRPCClient()

  const [data, setData] = useState<SettingsData | null>(null)
  const [invitations, setInvitations] = useState<PendingInvitation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function loadSettings() {
    setError(null)

    try {
      const settings = await client.tenant.getSettings.query()
      setData(settings)
      if (settings.canManageTeam) void loadInvitations()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  async function loadInvitations() {
    try {
      const pending = await client.tenant.listPendingInvitations.query()
      setInvitations(pending)
    } catch {
      // Non-critical — the invite form and member list still work without it.
    }
  }

  useEffect(() => {
    void loadSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-4xl space-y-8">
        <section>
          <div className="flex items-center gap-3">
            <Settings className="h-6 w-6 text-pf-accent" aria-hidden="true" />
            <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Settings</h1>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/60">
            Manage organization details, billing visibility, and team access.
          </p>
        </section>

        {error ? (
          <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        <section className="rounded-3xl border border-pf-primary/10 bg-white p-6 shadow-sm">
          <SectionHeader icon={Building2} title="Organization" />

          {loading ? (
            <p className="text-sm text-pf-deep/50">Loading organization settings...</p>
          ) : (
            <dl className="space-y-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                <dt className="w-40 shrink-0 text-sm font-medium text-pf-deep/60">Name</dt>
                <dd className="text-sm text-pf-deep">{data?.tenant.name ?? '-'}</dd>
              </div>
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                <dt className="w-40 shrink-0 text-sm font-medium text-pf-deep/60">Plan</dt>
                <dd>{data?.tenant.planTier ? <PlanBadge tier={data.tenant.planTier} /> : '-'}</dd>
              </div>
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                <dt className="w-40 shrink-0 text-sm font-medium text-pf-deep/60">Status</dt>
                <dd>{data?.tenant.status ? <StatusBadge status={data.tenant.status} /> : '-'}</dd>
              </div>
            </dl>
          )}
        </section>

        <section className="border border-pf-primary/10 bg-white p-6 shadow-sm">
          <ClientTochiPreferenceWorkspace />
        </section>

        <section className="rounded-3xl border border-pf-primary/10 bg-white p-6 shadow-sm">
          <SectionHeader icon={Users} title="Team" />

          {data?.canManageTeam ? (
            <>
              <InviteForm client={client} onInvited={loadInvitations} />
              <PendingInvitationsTable invitations={invitations} />
            </>
          ) : data ? (
            <p className="text-sm leading-6 text-pf-deep/60">
              Owners manage invitations. You can still see who currently has access.
            </p>
          ) : null}

          {loading ? (
            <p className="mt-6 text-sm text-pf-deep/50">Loading team members...</p>
          ) : data?.members && data.members.length > 0 ? (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Current team members</caption>
                <thead>
                  <tr className="border-b border-pf-primary/10 text-left">
                    <th scope="col" className="pb-3 pr-4 font-medium text-pf-deep/50">
                      Member
                    </th>
                    <th scope="col" className="pb-3 pr-4 font-medium text-pf-deep/50">
                      Role
                    </th>
                    <th scope="col" className="pb-3 pr-4 font-medium text-pf-deep/50">
                      Status
                    </th>
                    <th scope="col" className="pb-3 font-medium text-pf-deep/50">
                      Joined
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pf-primary/5">
                  {data.members.map((member) => (
                    <MemberRow key={member.id} member={member} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-6 text-sm text-pf-deep/40">No team members found.</p>
          )}
        </section>
      </div>
    </div>
  )
}
