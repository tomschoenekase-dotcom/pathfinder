# Task Packet: Dashboard Polish — Sprint 007

Eight self-contained UI/UX fixes for the dashboard app and one analytics backend change.
Each fix is labeled with its risk level: **Low** (UI-only), **Medium** (UI + API), **High** (auth/infra).

Work through them in the order listed. Run `pnpm install && pnpm typecheck && pnpm lint && pnpm test` from the repo root before marking done.

---

## Fix 1 — Guest Chat Link on Overview Page (Low)

### Problem

The main overview page (`/`) has no direct link to the live guest chat URL. Operators must navigate into a venue's detail page to find the "Test AI chat" button.

### What to build

Add an "Open guest chat" button to the `DashboardOverview` component header area. Show it only when `NEXT_PUBLIC_WEB_URL` is set and at least one venue exists.

### Files to edit

**`apps/dashboard/app/(app)/page.tsx`**

After computing `stats`, build a `chatUrl` value:

```ts
const firstVenue = venues[0] ?? null
const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? null
const chatUrl = firstVenue && webUrl ? `${webUrl}/${firstVenue.slug}/chat` : null
```

Pass it to `DashboardOverview`:

```tsx
return <DashboardOverview stats={stats} chatUrl={chatUrl} />
```

**`apps/dashboard/components/DashboardOverview.tsx`**

1. Add `chatUrl?: string | null` to `DashboardOverviewProps`:

```ts
type DashboardOverviewProps = {
  stats: { ... }
  chatUrl?: string | null
}
```

2. Destructure `chatUrl` from props in `DashboardOverview`.

3. In the `<section>` that wraps the org name heading (line 109), add the button after the description paragraph:

```tsx
{
  chatUrl ? (
    <a
      href={chatUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-4 inline-flex min-h-10 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
    >
      Open guest chat →
    </a>
  ) : null
}
```

### No new files needed

---

## Fix 2 — Manager Summaries: Admin → Dashboard Link (Low)

### Problem

The admin can trigger a digest for a client and view stats, but there is no shortcut to navigate directly into that client's analytics page to see the generated digest. After clicking "View as {Client}", the admin lands on `/` and must navigate to Analytics manually.

### What to build

1. Modify `ViewAsClientButton` to support an optional redirect path.
2. Add a second "View analytics →" action button on the admin client detail page that switches org context and routes to `/analytics`.

### Files to edit

**`apps/dashboard/components/admin/ViewAsClientButton.tsx`**

Add an optional `redirectPath?: string` prop and use it in `router.push`:

```ts
type ViewAsClientButtonProps = {
  tenantId: string
  tenantName: string
  redirectPath?: string
}

export function ViewAsClientButton({ tenantId, tenantName, redirectPath = '/' }: ViewAsClientButtonProps) {
  ...
  async function handleViewAs() {
    if (!setActive) return
    await setActive({ organization: tenantId })
    router.push(redirectPath)
  }
  ...
}
```

**`apps/dashboard/app/(admin)/admin/clients/[tenantId]/page.tsx`**

In the `<header>` section where `ViewAsClientButton` already renders (line 69), add a second button:

```tsx
<div className="flex flex-wrap items-center gap-3">
  <ViewAsClientButton tenantId={tenant.id} tenantName={tenant.name} />
  <ViewAsClientButton tenantId={tenant.id} tenantName="analytics" redirectPath="/analytics" />
</div>
```

The second button will render as "View analytics →" using the existing button styles. Override its visible label by editing `ViewAsClientButton` to accept a `label?: string` prop that overrides the `View as {tenantName} →` default:

```tsx
// In ViewAsClientButton
label?: string
// In JSX
{label ?? `View as ${tenantName} →`}
```

Call the second button as:

```tsx
<ViewAsClientButton tenantId={tenant.id} redirectPath="/analytics" label="View analytics →" />
```

### No new files needed

---

## Fix 3 — Replace "Returning Visitors" with Avg. Messages/Session (Medium)

### Problem

The "Returning visitors" stat (guests seen on 2+ distinct days) is almost always zero for small operators and provides little actionable insight. A better signal is **average messages per session**, which shows how engaged guests are in their conversations.

### What to build

1. Extend `getVisitorStats` in the analytics router to return `avgMessagesPerSession`.
2. Replace the "Returning visitors" card with "Avg. messages/session" in the analytics page.

### Files to edit

**`packages/api/src/routers/analytics.ts`** — `getVisitorStats` procedure (starts at line 329)

Add a `_avg` aggregate query inside the existing `Promise.all`:

```ts
const [identifiedSessions, totalSessions, messageAggregate] = await Promise.all([
  ctx.db.visitorSession.findMany({ ... }),           // unchanged
  ctx.db.visitorSession.count({ ... }),               // unchanged
  ctx.db.visitorSession.aggregate({
    where: {
      tenantId: ctx.session.activeTenantId,
      startedAt: { gte: startDate },
    },
    _avg: { messageCount: true },
  }),
])
```

Update the return value (remove `returningVisitors`, add `avgMessagesPerSession`):

```ts
return {
  uniqueVisitors: daysByVisitor.size,
  avgMessagesPerSession: Math.round((messageAggregate._avg.messageCount ?? 0) * 10) / 10,
  totalSessions,
}
```

You may also remove the `returningVisitors` computation loop (lines 359–362) since it is no longer returned.

**`apps/dashboard/app/(app)/analytics/page.tsx`** — `VisitorStatsCards` component (starts at line 278)

Update the component signature and cards array:

```ts
function VisitorStatsCards({
  stats,
}: {
  stats: { uniqueVisitors: number; avgMessagesPerSession: number; totalSessions: number }
}) {
  const cards = [
    { label: 'Unique visitors', value: stats.uniqueVisitors, hint: 'Distinct devices (30 days)' },
    {
      label: 'Avg. messages / session',
      value: stats.avgMessagesPerSession.toFixed(1),
      hint: 'Conversation depth (30 days)',
    },
    { label: 'Total sessions', value: stats.totalSessions, hint: 'Chat visits (30 days)' },
  ]
  ...
}
```

The `toFixed(1)` call returns a `string`, which the existing `{card.value}` renders fine.

### Tests

Update the `getVisitorStats` test if one exists to assert that `avgMessagesPerSession` is returned and `returningVisitors` is not. Check `packages/api/src/routers/analytics.test.ts` for existing coverage.

---

## Fix 4 — Remove Redundant "AI Controls" Button from Venue Detail (Low)

### Problem

The venue detail page (`/venues/[venueId]`) has an "AI Controls" button in the top-right action bar that links to `/ai-controls?venue=...`. This is redundant because "AI Controls" is a persistent sidebar nav item visible on every page.

### What to build

Remove the `AI Controls` Link block from the action bar.

### File to edit

**`apps/dashboard/app/(app)/venues/[venueId]/page.tsx`**

Delete lines 117–122 (the `AI Controls` `<Link>` block):

```tsx
// DELETE this block:
<Link
  href={`/ai-controls?venue=${venue.id}`}
  className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
>
  AI Controls
</Link>
```

Leave the remaining buttons untouched: "Edit venue", "Knowledge Base", "Test AI chat", "Add guide item".

### No new files needed

---

## Fix 5 — Improve Color Picker Error Reporting (Low)

### Problem

The "Save design" button in `ChatDesignForm` swallows all errors and shows a generic "Failed to save. Please try again." message. If the logged-in user is `STAFF` role (not `MANAGER` or `OWNER`), the `updateChatDesign` procedure returns a `FORBIDDEN` error but the UI gives no indication that it's a permissions issue. This makes it look like the color picker is broken.

### What to build

Show the actual error message from TRPC instead of the hardcoded generic string.

### File to edit

**`apps/dashboard/components/ChatDesignForm.tsx`** — `handleSave` function (lines 61–81)

Replace the `catch` block:

```ts
} catch (err: unknown) {
  const message =
    err instanceof Error && err.message
      ? err.message
      : 'Failed to save. Please try again.'
  setSaveError(message)
}
```

TRPC client errors surface `err.message` as the procedure's error message (e.g., "You don't have permission to perform this action"). This makes the failure reason visible to the operator.

### No new files needed

---

## Fix 6 — Remove Logo URL Input (Logo Upload Not Yet Built) (Low)

### Problem

The "Your logo URL" input in the Chatbot Design form requires operators to host their own image and paste a URL, which is fragile and unfamiliar. File upload storage is not yet built (per CLAUDE.md "not built" list), so the field should be removed entirely until a proper upload flow is implemented.

### What to build

Remove the logo URL section from the form. Do not include `chatLogoUrl` in the save payload so the field is omitted from the update (Zod schema marks it `.optional()`, so omitting it means "leave unchanged" in the DB).

The banner URL input (`chatBannerUrl`) stays — only the logo is removed.

### File to edit

**`apps/dashboard/components/ChatDesignForm.tsx`**

**Step A — Remove state variable**

Delete line 51:

```ts
// DELETE:
const [chatLogoUrl, setChatLogoUrl] = useState(venue?.chatLogoUrl ?? '')
```

**Step B — Remove from handleSave payload**

In `handleSave` (lines 68–74), remove the `chatLogoUrl` line from the mutate call:

```ts
await client.venue.updateChatDesign.mutate({
  venueId: venue.id,
  chatTheme,
  chatAccentColor: isHexColor(chatAccentColor) ? chatAccentColor : null,
  // chatLogoUrl: removed — not passing means Prisma leaves it unchanged
  chatBannerUrl: chatBannerUrl.trim() || null,
})
```

**Step C — Remove the UI section**

Delete lines 148–179 (the entire `<div>` block for "Your logo URL", including the preview `<img>`).

### TypeScript note

After removing `chatLogoUrl` from state and the mutate call, run `pnpm typecheck` to verify no remaining references. The `Venue` type in the component props still includes `chatLogoUrl?: string | null` — leave it (it is part of the props type from the API) but it will simply be unused.

---

## Fix 7 — Team Invite: Show Pending Invitations + Webhook Setup (Medium)

### Problem

When an operator invites a team member:

1. The invited person is sent to Clerk's hosted join page — this is expected Clerk behavior, but the invite URL can be improved.
2. The settings page does not show the invite as "pending" until the person accepts and the Clerk webhook fires. The member list appears empty/unchanged after sending the invite, which looks broken.
3. After acceptance, the `organizationMembership.created` webhook syncs the user to the DB correctly, but the settings page is a client component that loaded once and does not auto-refresh.

### Root cause of "name not showing"

`syncMembershipCreated` in `packages/db/src/helpers/membership-sync.ts` only sets `fullName` from the webhook payload's `first_name + last_name`. If the new user hasn't filled in their name in Clerk, `fullName` is null and the settings page falls back to showing their email address (line 292 of settings page: `member.user.fullName ?? member.user.email`). This is correct behavior — emails always show. The "name not showing" issue resolves once the invited user updates their Clerk profile.

### What to build

**A — Show pending invitations in the settings team table**

Use Clerk's `useOrganization` hook to pull pending invitations client-side and render them in the team table with a "Pending" badge.

**File: `apps/dashboard/app/(app)/settings/page.tsx`**

1. Import additional Clerk hooks:

   ```ts
   import { useOrganization, useUser } from '@clerk/nextjs'
   ```

   (`useOrganization` is already imported; verify `invitations` is destructured from it.)

2. In `SettingsPage`, destructure `invitations` from `useOrganization`:

   ```ts
   const { organization, invitations } = useOrganization({ invitations: true })
   ```

   The `{ invitations: true }` option loads the invitation list.

3. After the `<InviteForm />` renders (around line 459), add a "Pending invitations" subsection above the existing members table:

   ```tsx
   {
     invitations && invitations.data && invitations.data.length > 0 ? (
       <div className="mt-4 overflow-hidden rounded-[1.5rem] border border-pf-light">
         <table className="w-full text-left text-sm">
           <thead>
             <tr className="border-b border-pf-light bg-pf-surface">
               <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-pf-deep/40">
                 Email
               </th>
               <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-pf-deep/40">
                 Role
               </th>
               <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-pf-deep/40">
                 Status
               </th>
             </tr>
           </thead>
           <tbody>
             {invitations.data.map((inv) => (
               <tr key={inv.id} className="border-b border-pf-light/60 last:border-0">
                 <td className="px-4 py-3 font-medium text-pf-deep">{inv.emailAddress}</td>
                 <td className="px-4 py-3 text-pf-deep/60">
                   {inv.role === 'org:admin' ? 'Manager' : 'Staff'}
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
     ) : null
   }
   ```

4. Add a "Refresh members" button beside the "Team" section header so operators can reload the DB member list after an acceptance:

   In the `<SectionHeader>` area for the team section, add:

   ```tsx
   <button
     type="button"
     onClick={() => {
       void loadSettings()
     }}
     className="ml-auto text-xs font-medium text-pf-primary hover:text-pf-accent"
   >
     Refresh
   </button>
   ```

**B — Clerk dashboard configuration (manual step for operator)**

In the Clerk dashboard:

1. Go to **User & Authentication → Email, Phone, Username**.
2. Under **Invitations**, set the **Redirect URL after invitation acceptance** to: `https://pathfinder-production-fcdd.up.railway.app/sign-up` (or the current production URL).
3. Verify that the following webhook events are subscribed on the webhook endpoint:
   - `organization.created`
   - `organizationMembership.created`
   - `organizationMembership.updated`
   - `organizationMembership.deleted`

These events are already handled by `handleClerkEvent` in `packages/db/src/helpers/membership-sync.ts`. If any are missing from the Clerk webhook subscription, add them — no code change needed.

---

## Fix 8 — Sign-Out Error (High)

### Problem

Clicking "Sign out" in the dashboard sidebar causes a server-side crash on Railway production. After signing out, Clerk redirects to `/sign-in` (configured in `apps/dashboard/app/layout.tsx` line 21: `afterSignOutUrl="/sign-in"`). The `/sign-in` page at `apps/dashboard/app/(auth)/sign-in/[[...sign-in]]/page.tsx` exists but crashes in production.

### Root cause analysis

The `(auth)` route group has no `layout.tsx` file of its own. The auth pages fall through to the root `apps/dashboard/app/layout.tsx` which exports `dynamic = 'force-dynamic'` at the module level, meaning Next.js forces all pages through the same dynamic context. On Railway, this can fail if Clerk environment variables are not resolved correctly during SSR for an unauthenticated context, or if the `PathFinderBrand` import chain has a production-only import error.

### What to build

**A — Add a standalone auth layout**

Create `apps/dashboard/app/(auth)/layout.tsx`:

```tsx
import type { ReactNode } from 'react'
import { Plus_Jakarta_Sans } from 'next/font/google'

import '../globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
})

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="font-jakarta antialiased">{children}</body>
    </html>
  )
}
```

This layout is intentionally minimal: no `ClerkProvider`, no `force-dynamic`, no shared imports that could crash. The Clerk `<SignIn>` component inside the auth page provides its own Clerk context via the publishable key from `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.

**B — Make `afterSignOutUrl` configurable**

In `apps/dashboard/app/layout.tsx`, change the hardcoded `/sign-in` to an env var:

```tsx
<ClerkProvider afterSignOutUrl={process.env.NEXT_PUBLIC_AFTER_SIGN_OUT_URL ?? '/sign-in'}>
```

**C — Add env var in Railway**

In the Railway dashboard service for `apps/dashboard`, add:

| Variable                         | Value                                                       |
| -------------------------------- | ----------------------------------------------------------- |
| `NEXT_PUBLIC_AFTER_SIGN_OUT_URL` | `https://pathfinder-production-fcdd.up.railway.app/sign-in` |

Using an absolute URL avoids Clerk's behavior of constructing the URL from the request origin, which can differ in Railway's edge proxy setup. Long-term, when a marketing website exists, change this to the marketing site's URL.

**D — Simplify the sign-in page as a fallback**

If the crash persists after adding the auth layout, simplify `apps/dashboard/app/(auth)/sign-in/[[...sign-in]]/page.tsx` to remove the `PathFinderBrand` header:

```tsx
import { SignIn } from '@clerk/nextjs'

export default function DashboardSignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <SignIn />
    </main>
  )
}
```

A plain gray background removes any dependency on `@pathfinder/ui` or CSS custom properties that might not be initialised before the auth layout loads.

### Risk note

This is the most infra-sensitive fix. Deploy to Railway and immediately test sign-out in a private browser window after completing it. If the auth layout causes a double `<html>` tag issue (Next.js App Router error), check that the `(auth)` layout is not nested inside a parent layout that also renders `<html>`. In this repo, the `(auth)` segment sits directly under `app/`, so it would replace — not nest — the root layout for those routes.

---

## Definition of Done

- [ ] Fix 1: "Open guest chat →" button appears on the overview page when `NEXT_PUBLIC_WEB_URL` is set
- [ ] Fix 2: Admin client detail page shows "View analytics →" button that enters client view and routes to `/analytics`
- [ ] Fix 3: Analytics page shows "Avg. messages / session" stat card instead of "Returning visitors"
- [ ] Fix 4: Venue detail page no longer shows "AI Controls" button in the action bar
- [ ] Fix 5: `ChatDesignForm` shows the real error message (e.g., "You don't have permission") instead of generic text
- [ ] Fix 6: "Your logo URL" section is removed from the Chatbot Design form
- [ ] Fix 7: Settings team table shows pending invitations (from Clerk) alongside accepted members
- [ ] Fix 8: Sign out no longer causes a server-side crash; user is redirected to the sign-in page cleanly
- [ ] `pnpm typecheck` passes with no new errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
