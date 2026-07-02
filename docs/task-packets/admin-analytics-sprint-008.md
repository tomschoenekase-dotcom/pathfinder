# Task Packet — Sprint 008: Admin Analytics Tab + Impersonation Fix

> Agent: read this entire document before touching any file.
> Source of truth for architecture: `docs/codebase-overview.md` and `CLAUDE.md`.
> Do not touch files outside the scope listed here.

---

## Background

The admin dashboard currently has a "View analytics →" button on each client detail page
(`/admin/clients/[tenantId]`) that switches the admin's Clerk org context and redirects into
the tenant's own analytics page. This has two problems:

1. **It only works for orgs the admin is a Clerk member of.** The admin account is typically only
   a member of one test/demo org. For all other client orgs the `setActive` call does nothing and
   the redirect lands on the wrong org's data.

2. **It leaks into the tenant UI** — the admin shouldn't have to enter the tenant's dashboard just
   to read their analytics. A dedicated admin analytics view is cleaner, more powerful, and doesn't
   require org membership.

This packet delivers:

- **Phase A**: A new `/admin/clients/[tenantId]/analytics` page (server-rendered, uses
  `adminProcedure` + `withTenantIsolationBypass`, shows sessions, messages, question clusters,
  and recent conversation pairs).
- **Phase B**: A cookie-based admin impersonation system so "View as client" works for any org,
  not just orgs the admin account is already a Clerk member of.

Do Phase A first; Phase B is independent but should be completed in the same sprint.

---

## Phase A — Admin Analytics Tab

### A1. New tRPC procedure: `admin.getClientAnalytics`

**File:** `packages/api/src/routers/admin/_admin.ts`

Add the procedure after `getClientVenue`. Input: `{ tenantId, days? }`. Everything runs inside
`withTenantIsolationBypass`.

```ts
getClientAnalytics: adminProcedure
  .input(
    z.object({
      tenantId: z.string().min(1),
      days: z.number().int().min(1).max(90).default(30),
    }),
  )
  .query(async ({ input }) => {
    return withTenantIsolationBypass(async () => {
      const startDate = new Date()
      startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))
      startDate.setUTCHours(0, 0, 0, 0)

      const [
        totalSessions,
        totalMessages,
        uniqueVisitors,
        recentSessions,
        questionClusters,
      ] = await Promise.all([
        db.visitorSession.count({
          where: { tenantId: input.tenantId, startedAt: { gte: startDate } },
        }),
        db.message.count({
          where: { tenantId: input.tenantId, createdAt: { gte: startDate } },
        }),
        db.visitorSession.findMany({
          where: {
            tenantId: input.tenantId,
            startedAt: { gte: startDate },
            visitorId: { not: null },
          },
          select: { visitorId: true },
          distinct: ['visitorId'],
        }),
        // 20 most recent sessions with their messages
        db.visitorSession.findMany({
          where: { tenantId: input.tenantId, startedAt: { gte: startDate } },
          orderBy: { startedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            startedAt: true,
            endedAt: true,
            messageCount: true,
            visitorId: true,
            messages: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, role: true, content: true, createdAt: true, topic: true },
            },
          },
        }),
        // Top question clusters (content_gap + top_question)
        db.questionCluster.findMany({
          where: { tenantId: input.tenantId, windowStart: { gte: startDate } },
          orderBy: { count: 'desc' },
          take: 20,
          select: {
            id: true,
            kind: true,
            canonicalText: true,
            count: true,
            examples: true,
            windowStart: true,
            venue: { select: { name: true } },
          },
        }),
      ])

      return {
        stats: {
          totalSessions,
          totalMessages,
          uniqueVisitors: uniqueVisitors.length,
        },
        recentSessions,
        questionClusters,
      }
    })
  }),
```

> Note: `recentSessions[].messages` includes the full content of guest messages and AI replies.
> This is intentionally allowed under `adminProcedure` which requires `PLATFORM_ADMIN`. Do not
> expose this data via `tenantProcedure`.

---

### A2. New analytics page

**File to create:** `apps/dashboard/app/(admin)/admin/clients/[tenantId]/analytics/page.tsx`

This is a server component. Call `caller.admin.getClientAnalytics({ tenantId })`. Use
`createAdminCaller` from `apps/dashboard/lib/admin-caller.ts` (same pattern as the client detail
page).

Page layout:

```
← Back to [tenant name]            (link to /admin/clients/[tenantId])

[tenant name] — Analytics (30 days)

[ Total Sessions ]  [ Total Messages ]  [ Unique Visitors ]   ← StatCards (reuse the local component)

── Question clusters ──────────────────────────────────────
Table with columns: Question | Type | Count | Venue | Window
"Type" is kind === 'content_gap' → "Content gap" | 'top_question' → "Top question"
If no clusters: "No question clusters found. Run the analytics enrichment job to populate these."

── Recent conversations ────────────────────────────────────
List of up to 20 sessions. Each session is a collapsible <details> block:

<details>
  <summary>
    [startedAt date/time]  ·  [messageCount] messages  ·  [visitorId truncated or 'Anonymous']
  </summary>
  Conversation transcript: alternating GUEST / AI rows.
  Each row: role badge + message content + timestamp.
</details>

If recentSessions is empty: "No sessions in this period."
```

**Styling**: Follow the existing admin page conventions — `rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm` cards, `text-pf-deep` text, `text-pf-deep/50` secondary. Reuse the `StatCard` function defined in the client detail page by extracting it to a shared helper or just redefining it locally.

---

### A3. Tab navigation on admin client detail pages

Both `/admin/clients/[tenantId]` and `/admin/clients/[tenantId]/analytics` should share a tab bar:

```
[ Overview ]  [ Analytics ]
```

**Approach**: Create a shared layout for the tenant scope.

**File to create:** `apps/dashboard/app/(admin)/admin/clients/[tenantId]/layout.tsx`

```tsx
export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import Link from 'next/link'

// This layout wraps both the detail page and the analytics page.
// It does NOT fetch data — just renders the tab bar.

type Props = {
  children: ReactNode
  params: Promise<{ tenantId: string }>
}

export default async function AdminClientLayout({ children, params }: Props) {
  const { tenantId } = await params

  return (
    <div className="space-y-6">
      <nav className="flex gap-1 border-b border-pf-light pb-0" aria-label="Client sections">
        <AdminTab href={`/admin/clients/${tenantId}`} label="Overview" />
        <AdminTab href={`/admin/clients/${tenantId}/analytics`} label="Analytics" />
      </nav>
      {children}
    </div>
  )
}

// AdminTab must be a client component to use usePathname for active state.
// Extract it to apps/dashboard/components/admin/AdminTab.tsx:
```

**File to create:** `apps/dashboard/components/admin/AdminTab.tsx`

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function AdminTab({ href, label }: { href: string; label: string }) {
  const pathname = usePathname()
  const isActive = pathname === href

  return (
    <Link
      href={href}
      className={[
        'px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px',
        isActive
          ? 'border-pf-accent text-pf-accent'
          : 'border-transparent text-pf-deep/50 hover:text-pf-deep',
      ].join(' ')}
    >
      {label}
    </Link>
  )
}
```

Then update the layout to import `AdminTab` from the components directory.

---

### A4. Remove "View analytics →" button from admin client detail header

**File:** `apps/dashboard/app/(admin)/admin/clients/[tenantId]/page.tsx`

Delete the second `<ViewAsClientButton>` call (the one with `redirectPath="/analytics"` and
`label="View analytics →"`). The tab navigation replaces it.

The first `<ViewAsClientButton tenantId={tenant.id} tenantName={tenant.name} />` stays for now
(Phase B addresses its reliability).

---

### A5. Definition of done — Phase A

- [ ] `admin.getClientAnalytics` procedure exists and typechecks
- [ ] `/admin/clients/[tenantId]/analytics` renders stats, question clusters, and recent sessions
- [ ] Tab bar appears on both the overview and analytics pages with correct active state
- [ ] "View analytics →" button is removed from the client detail header
- [ ] `pnpm typecheck && pnpm test` pass

---

## Phase B — Admin Impersonation via Cookie Override

### Problem

`ViewAsClientButton` calls Clerk's `setActive({ organization: tenantId })`. This only works for
organizations the admin user is a **Clerk member of**. The platform admin is typically only a member
of one or two orgs, so the button silently fails for all other clients.

### Solution

Replace Clerk org switching with a server-set cookie (`pf_admin_tenant`) that the middleware and
tRPC context read to override the active tenant for platform admins. The existing Clerk org context
is ignored when this override cookie is present and the user is a platform admin.

---

### B1. Impersonate API route

**File to create:** `apps/dashboard/app/api/admin/impersonate/route.ts`

```ts
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

const COOKIE_NAME = 'pf_admin_tenant'
const COOKIE_MAX_AGE = 60 * 60 * 8 // 8 hours

export async function POST(req: Request) {
  const { userId, sessionClaims } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'

  if (!isPlatformAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { tenantId } = (await req.json()) as { tenantId?: string }

  const response = NextResponse.json({ ok: true })

  if (!tenantId) {
    // Clear the override — return to admin view
    response.cookies.delete(COOKIE_NAME)
  } else {
    response.cookies.set(COOKIE_NAME, tenantId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })
  }

  return response
}
```

---

### B2. Update `createTRPCContext` to honour the cookie override

**File:** `packages/api/src/context.ts` (or wherever `createTRPCContext` lives — check
`packages/api/src/` for the context file)

Find where `activeTenantId` is set from `auth()`. Add cookie override logic:

```ts
// After resolving `authResult` from Clerk auth():
const isPlatformAdmin =
  (authResult.sessionClaims?.publicMetadata as { platform_role?: string } | undefined)
    ?.platform_role === 'PLATFORM_ADMIN'

// For platform admins, a cookie override lets them view any tenant's data
// without needing to be a Clerk member of that org.
const adminTenantOverride = isPlatformAdmin
  ? (request.cookies?.get?.('pf_admin_tenant')?.value ?? null)
  : null

const activeTenantId = adminTenantOverride ?? authResult.orgId ?? null
```

Look at the actual context file carefully before editing — the exact shape of `authResult` and
how `activeTenantId` is currently set varies. Match the existing pattern, only changing the
`activeTenantId` resolution line.

---

### B3. Update middleware to honour the cookie override for routing

**File:** `apps/dashboard/middleware.ts`

After the `if (!authState.userId)` check, add:

```ts
// For platform admins with an active tenant override cookie, treat them as
// having an org — skip the onboarding redirect.
const adminTenantOverride = req.cookies.get('pf_admin_tenant')?.value
const isPlatformAdmin =
  (authState.sessionClaims?.publicMetadata as { platform_role?: string } | undefined)
    ?.platform_role === 'PLATFORM_ADMIN'

const effectiveOrgId = authState.orgId ?? (isPlatformAdmin ? adminTenantOverride : null)

if (!effectiveOrgId && pathname !== '/onboarding' && !pathname.startsWith('/admin')) {
  const onboardingUrl = new URL('/onboarding', req.url)
  return NextResponse.redirect(onboardingUrl)
}
```

Remove the existing `if (!authState.orgId && ...)` block and replace it with the above.

---

### B4. Refactor `ViewAsClientButton` to use the cookie override

**File:** `apps/dashboard/components/admin/ViewAsClientButton.tsx`

Replace the `setActive` + `window.location.href` approach with a `fetch` call to the impersonate
route:

```tsx
'use client'

type ViewAsClientButtonProps = {
  tenantId: string
  tenantName?: string
  label?: string
}

export function ViewAsClientButton({ tenantId, tenantName, label }: ViewAsClientButtonProps) {
  async function handleViewAs() {
    await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    })
    window.location.href = '/'
  }

  return (
    <button
      type="button"
      onClick={handleViewAs}
      className="rounded-2xl bg-pf-primary px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pf-accent"
    >
      {label ?? `View as ${tenantName ?? 'client'} →`}
    </button>
  )
}
```

Note: the `redirectPath` prop is removed — always navigates to `/` after impersonation so the
dashboard server components pick up the new cookie on fresh load.

---

### B5. Update "Exit client view" in `DashboardShell`

**File:** `apps/dashboard/components/DashboardShell.tsx`

Change `exitClientView`:

```ts
async function exitClientView() {
  await fetch('/api/admin/impersonate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId: null }),
  })
  window.location.href = '/admin'
}
```

Remove the `useOrganizationList` import and `setActive` call from this function (keep
`useOrganizationList` only if it's used elsewhere in the file — it isn't, so remove the import).

The `isPlatformAdmin` / `orgName` detection from `useOrganization()` still works for the sidebar
org name display. But when the admin is impersonating via cookie, `organization?.name` will be
`null` (no Clerk org is active). Add a fallback:

```tsx
// In DashboardShell, also fetch impersonated org name when in cookie-override mode.
// Simplest approach: pass orgName as a prop from the server layout, or read it from the
// tRPC tenant.getSettings query that already runs on the settings page.
// For now, fall back to 'Client workspace' when organization is null and isPlatformAdmin is true.
const orgName = organization?.name ?? (isPlatformAdmin ? 'Client workspace' : 'Your organization')
```

---

### B6. Remove `redirectPath` prop from `ViewAsClientButton` usages

Since Phase B removes `redirectPath`, update `apps/dashboard/app/(admin)/admin/clients/[tenantId]/page.tsx`:

- The remaining `<ViewAsClientButton tenantId={tenant.id} tenantName={tenant.name} />` call is
  already correct (no redirectPath).
- Remove any import of the old `redirectPath` prop type if it remains.

---

### B7. Definition of done — Phase B

- [ ] POST `/api/admin/impersonate` sets / clears the `pf_admin_tenant` cookie
- [ ] `createTRPCContext` uses the cookie override when user is platform admin
- [ ] Middleware allows cookie-admin users to bypass the onboarding redirect
- [ ] "View as client" navigates to `/` and renders that client's dashboard data
- [ ] "Exit client view" clears the cookie and returns to `/admin`
- [ ] Sidebar shows correct org name or "Client workspace" fallback during impersonation
- [ ] `pnpm typecheck && pnpm test` pass
- [ ] Platform admin without the cookie sees normal admin experience (no regression)

---

## Files touched summary

| File                                                                     | Phase | Action                                     |
| ------------------------------------------------------------------------ | ----- | ------------------------------------------ |
| `packages/api/src/routers/admin/_admin.ts`                               | A     | Add `getClientAnalytics` procedure         |
| `apps/dashboard/app/(admin)/admin/clients/[tenantId]/analytics/page.tsx` | A     | Create                                     |
| `apps/dashboard/app/(admin)/admin/clients/[tenantId]/layout.tsx`         | A     | Create                                     |
| `apps/dashboard/components/admin/AdminTab.tsx`                           | A     | Create                                     |
| `apps/dashboard/app/(admin)/admin/clients/[tenantId]/page.tsx`           | A     | Remove "View analytics" button             |
| `apps/dashboard/app/api/admin/impersonate/route.ts`                      | B     | Create                                     |
| `packages/api/src/context.ts`                                            | B     | Add cookie override to activeTenantId      |
| `apps/dashboard/middleware.ts`                                           | B     | Use effectiveOrgId for onboarding redirect |
| `apps/dashboard/components/admin/ViewAsClientButton.tsx`                 | B     | Replace setActive with fetch               |
| `apps/dashboard/components/DashboardShell.tsx`                           | B     | Update exitClientView + orgName fallback   |

## Do not touch

- `packages/db/` schema or migrations (no new tables needed)
- `apps/web/` (no changes)
- `packages/analytics/` (no new events)
- Any file not listed above
