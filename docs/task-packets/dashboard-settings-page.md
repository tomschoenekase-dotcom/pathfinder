# Task Packet: Dashboard Settings Page

## Scope

Build a `/settings` page in `apps/dashboard` with two sections:

1. **Organization** — read-only display of org name, plan tier, status, and next payment due date. Platform admins get an inline date editor for the payment due field.
2. **Team** — table of active and invited members sourced from the database, plus an invite-by-email form that calls the Clerk org invite API (the existing webhook then auto-syncs the new membership to the DB).

Run `pnpm install && pnpm typecheck && pnpm lint && pnpm test` from the repo root before marking done.

---

## Part 1 — Schema: add `next_payment_due` to tenants

### 1a — `packages/db/prisma/schema.prisma`

Add one optional field to the `Tenant` model, immediately after `config`:

```prisma
nextPaymentDue  DateTime?  @map("next_payment_due")
```

The full model block should look like:

```prisma
model Tenant {
  id              String             @id
  name            String
  slug            String             @unique
  planTier        String             @default("free") @map("plan_tier")
  status          TenantStatus       @default(ACTIVE)
  config          Json               @default("{}")
  nextPaymentDue  DateTime?          @map("next_payment_due")
  createdAt       DateTime           @default(now()) @map("created_at")
  updatedAt       DateTime           @updatedAt @map("updated_at")
  // ... relations unchanged
}
```

### 1b — Migration

Create `packages/db/prisma/migrations/20260630000000_add_tenant_next_payment_due/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "next_payment_due" TIMESTAMP(3);
```

---

## Part 2 — tRPC: `tenant` router

### 2a — `packages/api/src/routers/tenant.ts` (new file)

```ts
import { TRPCError } from '@trpc/server'

import { db } from '@pathfinder/db'

import { router } from '../core'
import { tenantProcedure } from '../trpc'

export const tenantRouter = router({
  /**
   * Returns the current tenant's settings and full (non-removed) member list.
   * Used exclusively by the /settings page.
   */
  getSettings: tenantProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.session.activeTenantId

    const [tenant, members] = await Promise.all([
      db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          planTier: true,
          status: true,
          nextPaymentDue: true,
        },
      }),
      db.tenantMembership.findMany({
        where: { tenantId, status: { not: 'REMOVED' } },
        select: {
          id: true,
          role: true,
          status: true,
          joinedAt: true,
          createdAt: true,
          user: {
            select: { id: true, email: true, fullName: true, avatarUrl: true },
          },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
    ])

    if (!tenant) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found' })
    }

    return { tenant, members }
  }),
})
```

### 2b — `packages/api/src/root.ts`

Add the import and register the router:

```ts
import { tenantRouter } from './routers/tenant'
```

Add `tenant: tenantRouter` to the `appRouter` object. The final router object:

```ts
export const appRouter = router({
  admin: adminRouter,
  analytics: analyticsRouter,
  chat: chatRouter,
  knowledge: knowledgeRouter,
  operationalUpdate: operationalUpdateRouter,
  tenant: tenantRouter,
  venue: venueRouter,
  place: placeRouter,
  health: publicProcedure.query(() => ({
    ok: true,
    scope: 'public',
  })),
})
```

---

## Part 3 — tRPC: admin mutation to set payment due date

### 3a — `packages/api/src/routers/admin/_admin.ts`

Add to the `adminRouter` object (after the existing `listClients` procedure):

```ts
/**
 * Platform-admin-only mutation to set or clear a tenant's next payment due
 * date. Visible to the operator in their /settings page (read-only). Admin
 * sets it from the same page when viewing as the tenant.
 */
setTenantPaymentDue: adminProcedure
  .input(
    z.object({
      tenantId: z.string().min(1),
      nextPaymentDue: z.string().datetime().nullable(),
    }),
  )
  .mutation(async ({ input }) => {
    await withTenantIsolationBypass(async () => {
      await db.tenant.update({
        where: { id: input.tenantId },
        data: {
          nextPaymentDue: input.nextPaymentDue ? new Date(input.nextPaymentDue) : null,
        },
      })
    })

    return { ok: true }
  }),
```

No additional imports needed — `z`, `db`, `withTenantIsolationBypass`, and `adminProcedure` are already in scope.

---

## Part 4 — Dashboard nav: add Settings link

### 4a — `apps/dashboard/components/DashboardShell.tsx`

Add `Settings` from `lucide-react` to the existing icon import:

```ts
import {
  Bot,
  ChartColumn,
  Home,
  LogOut,
  Megaphone,
  Palette,
  Settings,
  ShieldCheck,
} from 'lucide-react'
```

Add one entry to the `navigationItems` array, at the end (before the `as const`):

```ts
{ href: '/settings', label: 'Settings', icon: Settings },
```

No other changes to this file.

---

## Part 5 — Settings page

### 5a — `apps/dashboard/app/(app)/settings/page.tsx` (new file)

```tsx
'use client'

import { useState } from 'react'
import { useOrganization, useUser } from '@clerk/nextjs'
import { Settings, Users, Building2, CalendarClock } from 'lucide-react'

import { api } from '@/lib/trpc/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

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

// Map from UI role selection to Clerk org role
const INVITE_ROLE_OPTIONS = [
  { label: 'Manager', clerkRole: 'org:admin' },
  { label: 'Staff', clerkRole: 'org:member' },
]

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-pf-primary/10 pb-4 mb-6">
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
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}
    >
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
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}
    >
      {label}
    </span>
  )
}

// Admin-only inline editor for next payment due date
function PaymentDateEditor({
  tenantId,
  currentDate,
  onUpdated,
}: {
  tenantId: string
  currentDate: Date | null
  onUpdated: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(
    currentDate ? new Date(currentDate).toISOString().slice(0, 10) : '',
  )

  const setPaymentDue = api.admin.setTenantPaymentDue.useMutation({
    onSuccess: () => {
      onUpdated()
      setEditing(false)
    },
  })

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-pf-deep">
          {currentDate ? formatDate(currentDate) : <span className="text-pf-deep/40">Not set</span>}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-medium text-pf-accent hover:underline"
        >
          {currentDate ? 'Edit' : 'Set date'}
        </button>
        {currentDate ? (
          <button
            type="button"
            onClick={() => setPaymentDue.mutate({ tenantId, nextPaymentDue: null })}
            className="text-xs font-medium text-rose-500 hover:underline"
          >
            Clear
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!value) return
        setPaymentDue.mutate({
          tenantId,
          nextPaymentDue: new Date(value).toISOString(),
        })
      }}
    >
      <input
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-xl border border-pf-light px-3 py-1.5 text-sm text-pf-deep outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
      />
      <button
        type="submit"
        disabled={!value || setPaymentDue.isPending}
        className="rounded-full bg-pf-primary px-3 py-1.5 text-xs font-medium text-white transition hover:bg-pf-accent disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="text-xs text-pf-deep/50 hover:text-pf-deep"
      >
        Cancel
      </button>
    </form>
  )
}

// Invite form — calls Clerk org invite API; webhook auto-syncs to DB
function InviteForm({ onInvited }: { onInvited: () => void }) {
  const { organization } = useOrganization()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('org:member')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!organization || !email.trim()) return
    setLoading(true)
    setError(null)
    setSuccess(false)
    try {
      await organization.inviteMember({ emailAddress: email.trim(), role })
      setEmail('')
      setSuccess(true)
      onInvited()
      setTimeout(() => setSuccess(false), 4000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invite. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-6 rounded-2xl border border-pf-primary/10 bg-pf-surface p-5"
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
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            className="min-h-10 w-full rounded-2xl border border-pf-light px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          />
        </div>
        <div className="w-36">
          <label htmlFor="invite-role" className="mb-1.5 block text-xs font-medium text-pf-deep/60">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="min-h-10 w-full rounded-2xl border border-pf-light bg-white px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          >
            {INVITE_ROLE_OPTIONS.map((opt) => (
              <option key={opt.clerkRole} value={opt.clerkRole}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={loading || !email.trim()}
          className="inline-flex min-h-10 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Sending…' : 'Send invite'}
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
      {success ? (
        <p className="mt-2 text-sm text-emerald-600">
          Invite sent — they'll receive an email shortly.
        </p>
      ) : null}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { user } = useUser()
  const isPlatformAdmin =
    (user?.publicMetadata as { platform_role?: unknown } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'

  const { data, refetch } = api.tenant.getSettings.useQuery()

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* Page header */}
      <div className="mb-8 flex items-center gap-3">
        <Settings className="h-6 w-6 text-pf-accent" aria-hidden="true" />
        <h1 className="text-2xl font-bold text-pf-deep">Settings</h1>
      </div>

      {/* Organization section */}
      <section className="mb-10 rounded-3xl border border-pf-primary/10 bg-white p-6 shadow-sm">
        <SectionHeader icon={Building2} title="Organization" />

        <dl className="space-y-4">
          <div className="flex items-center gap-4">
            <dt className="w-40 shrink-0 text-sm font-medium text-pf-deep/60">Name</dt>
            <dd className="text-sm text-pf-deep">{data?.tenant.name ?? '—'}</dd>
          </div>
          <div className="flex items-center gap-4">
            <dt className="w-40 shrink-0 text-sm font-medium text-pf-deep/60">Plan</dt>
            <dd>{data?.tenant.planTier ? <PlanBadge tier={data.tenant.planTier} /> : '—'}</dd>
          </div>
          <div className="flex items-center gap-4">
            <dt className="w-40 shrink-0 text-sm font-medium text-pf-deep/60">Status</dt>
            <dd>{data?.tenant.status ? <StatusBadge status={data.tenant.status} /> : '—'}</dd>
          </div>
          <div className="flex items-start gap-4">
            <dt className="w-40 shrink-0 text-sm font-medium text-pf-deep/60">
              <span className="flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                Next payment due
              </span>
            </dt>
            <dd className="text-sm">
              {data && isPlatformAdmin ? (
                <PaymentDateEditor
                  tenantId={data.tenant.id}
                  currentDate={data.tenant.nextPaymentDue ?? null}
                  onUpdated={() => void refetch()}
                />
              ) : (
                <span className="text-pf-deep">
                  {data?.tenant.nextPaymentDue ? (
                    formatDate(data.tenant.nextPaymentDue)
                  ) : (
                    <span className="text-pf-deep/40">—</span>
                  )}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* Team section */}
      <section className="rounded-3xl border border-pf-primary/10 bg-white p-6 shadow-sm">
        <SectionHeader icon={Users} title="Team" />

        {/* Members table */}
        {data?.members && data.members.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-pf-primary/10 text-left">
                  <th className="pb-3 pr-4 font-medium text-pf-deep/50">Member</th>
                  <th className="pb-3 pr-4 font-medium text-pf-deep/50">Role</th>
                  <th className="pb-3 pr-4 font-medium text-pf-deep/50">Status</th>
                  <th className="pb-3 font-medium text-pf-deep/50">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-pf-primary/5">
                {data.members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 pr-4">
                      <div className="font-medium text-pf-deep">
                        {m.user.fullName ?? m.user.email}
                      </div>
                      {m.user.fullName ? (
                        <div className="text-xs text-pf-deep/50">{m.user.email}</div>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_COLORS[m.role] ?? 'bg-pf-light/20 text-pf-deep/60'}`}
                      >
                        {ROLE_LABELS[m.role] ?? m.role}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[m.status] ?? 'bg-pf-light/20 text-pf-deep/60'}`}
                      >
                        {m.status === 'INVITED' ? 'Pending' : 'Active'}
                      </span>
                    </td>
                    <td className="py-3 text-pf-deep/60">
                      {m.joinedAt ? formatDate(m.joinedAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-pf-deep/40">No team members found.</p>
        )}

        {/* Invite form */}
        <InviteForm onInvited={() => void refetch()} />
      </section>
    </div>
  )
}
```

---

## Part 6 — `apps/dashboard/app/(app)/settings/` directory

The file created in Part 5 is the only file needed in the new directory. No `layout.tsx` is required — the existing `(app)/layout.tsx` wraps it automatically.

---

## Clerk configuration check

Verify that invitations are enabled for your Clerk organization (Clerk dashboard → Configure → Organizations → enable "Invitations"). If the `organization.inviteMember()` call returns an error about invitations not being enabled, this is the fix.

---

## Tests

### `packages/api/src/routers/tenant.test.ts` (new file)

Write a Vitest unit test covering `tenant.getSettings`:

1. **Happy path** — mock `db.tenant.findUnique` and `db.tenantMembership.findMany` to return valid data; assert both tenant fields and members array are returned.
2. **Tenant not found** — mock `db.tenant.findUnique` to return `null`; assert a `TRPCError` with code `NOT_FOUND` is thrown.
3. **Excludes removed members** — assert the `where` clause passed to `findMany` filters `status: { not: 'REMOVED' }`.

Mock `@pathfinder/db` with `vi.mock`.

---

## Definition of Done

- [ ] `packages/db/prisma/schema.prisma` has `nextPaymentDue` on `Tenant`
- [ ] Migration `20260630000000_add_tenant_next_payment_due` applies cleanly
- [ ] `tenant.getSettings` tRPC query returns tenant + member list
- [ ] `admin.setTenantPaymentDue` mutation writes the date and bypasses isolation
- [ ] Settings nav item appears in the dashboard sidebar
- [ ] `/settings` page renders the Organization section with name, plan badge, status badge, and next payment due
- [ ] Platform admins see an inline date editor for next payment due; operators see read-only text
- [ ] Team table lists all non-removed members with role and status badges
- [ ] Invite form sends a Clerk org invite; success/error messages display correctly
- [ ] After a successful invite, the member list refreshes (refetch on invite)
- [ ] `pnpm typecheck` passes with no new errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (new router tests green)
