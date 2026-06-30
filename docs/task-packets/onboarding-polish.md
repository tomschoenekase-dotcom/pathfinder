# Task Packet: Onboarding Polish — Branded Org Creation + Welcome Email

## Scope

Two self-contained deliverables:

1. **Branded org-creation step** — replace the stock Clerk `<CreateOrganization>` widget on `/onboarding` with an in-design-system form.
2. **Welcome email** — send a transactional welcome email via Resend when a new operator creates their first org.

Run `pnpm install && pnpm typecheck && pnpm lint && pnpm test` from the repo root before marking done.

---

## Part 1 — Branded Org-Creation Step

### Problem

`apps/dashboard/app/onboarding/page.tsx` renders Clerk's generic `<CreateOrganization>` widget for users with no org. It breaks visual continuity: the user sees PathFinder's polished design system, then a stock Clerk modal.

### What to build

Replace the `<CreateOrganization>` block with an inline branded form using existing Tailwind classes. The `<OrganizationList>` block (used by the platform-admin multi-org picker) stays untouched.

### Behaviour spec

- Single text input: label **"Organization name"**, helper text: `"This is typically your company or venue operator name."`
- Submit button: **"Get started →"**, disabled + shows spinner during submission
- On submit: call `clerk.createOrganization({ name })`, then `setActive({ organization: newOrg.id })`, then `router.replace('/')`
- Inline error paragraph below the form if creation fails (reuse `text-rose-600` pattern already in the file)
- The input auto-focuses on mount (`autoFocus`)
- "Sign out" escape link is preserved exactly as-is
- The loading state shown while memberships are loading (`isLoaded` false) is preserved exactly as-is

### File to edit

`apps/dashboard/app/onboarding/page.tsx`

### Implementation notes

**Clerk APIs** — import from `@clerk/nextjs`:

- `useClerk` → exposes `clerk.createOrganization({ name: string })` which returns the new org object
- `useOrganizationList` (already imported) → exposes `setActive`

**State needed in the new form component:**

```ts
const [orgName, setOrgName] = useState('')
const [isCreating, setIsCreating] = useState(false)
const [createError, setCreateError] = useState<string | null>(null)
```

**Submit handler:**

```ts
async function handleCreate(e: FormEvent) {
  e.preventDefault()
  if (!orgName.trim()) return
  setIsCreating(true)
  setCreateError(null)
  try {
    const org = await clerk.createOrganization({ name: orgName.trim() })
    await setActive!({ organization: org.id })
    router.replace('/')
  } catch (err) {
    setCreateError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    setIsCreating(false)
  }
}
```

**Styling** — match the surrounding card exactly. The input should use:

```
className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
```

The submit button:

```
className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
```

**Remove imports** that are no longer used after removing `<CreateOrganization>`: `CreateOrganization` from `@clerk/nextjs`.

**Add imports**: `useState`, `FormEvent` from `react`; `useClerk` from `@clerk/nextjs`.

### No new files needed

This is a single-file edit.

---

## Part 2 — Welcome Email

### Architecture

```
Clerk webhook (organizationMembership.created, role=org:admin)
  └─▶ apps/dashboard webhook route
        ├─▶ handleClerkEvent()  [existing, unchanged]
        └─▶ enqueueWelcomeEmail()  [new]
              └─▶ send-email BullMQ queue
                    └─▶ apps/workers processor
                          └─▶ Resend API → inbox
```

**Trigger choice rationale:** `organizationMembership.created` with `role === 'org:admin'` fires when the org creator gets owner membership — always within the same webhook batch as `organization.created`. The event payload already contains the user's email address and display name, so no Clerk API lookup is needed.

### 2a — `packages/jobs/src/queues.ts`

Add three constants:

```ts
export const SEND_EMAIL_QUEUE = 'send-email'
export const SEND_WELCOME_EMAIL_JOB = 'send-welcome-email'
export const SEND_WELCOME_EMAIL_RETRY_BACKOFF = 'send-welcome-email-retry'
```

### 2b — `packages/jobs/src/types.ts`

Add:

```ts
export type SendWelcomeEmailJobPayload = {
  tenantId: string
  to: string
  recipientName: string | null
  orgName: string
}
```

### 2c — `packages/jobs/src/enqueue.ts`

Add constants and type to the existing import blocks, then add:

```ts
const sendWelcomeEmailJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: SEND_WELCOME_EMAIL_RETRY_BACKOFF },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

export async function enqueueWelcomeEmail(payload: SendWelcomeEmailJobPayload): Promise<void> {
  await getQueue(SEND_EMAIL_QUEUE).add(SEND_WELCOME_EMAIL_JOB, payload, {
    ...sendWelcomeEmailJobOptions,
    jobId: `send-welcome-email:${payload.tenantId}`,
  })

  logger.info({
    action: 'jobs.send-welcome-email.enqueued',
    tenantId: payload.tenantId,
  })
}
```

### 2d — `apps/dashboard/app/api/webhooks/clerk/route.ts`

Import `enqueueWelcomeEmail` from `@pathfinder/jobs`.

Inside the existing `try` block, after `await handleClerkEvent(event)`, add:

```ts
if (event.type === 'organizationMembership.created' && event.data.role === 'org:admin') {
  const email = event.data.public_user_data.email_addresses?.[0]?.email_address
  if (email) {
    const recipientName =
      [event.data.public_user_data.first_name, event.data.public_user_data.last_name]
        .filter(Boolean)
        .join(' ') || null

    await enqueueWelcomeEmail({
      tenantId: event.data.organization.id,
      to: email,
      recipientName,
      orgName: event.data.organization.name ?? '',
    })
  }
}
```

This stays inside the existing `catch` so any enqueue failure still returns `200 OK` — Clerk must not retry because of our internal errors.

### 2e — `packages/config/src/env.ts`

Add two optional vars to `envSchema`:

```ts
RESEND_FROM_EMAIL: z.string().optional(),
DASHBOARD_URL: z.string().optional(),
```

`RESEND_API_KEY` is already present as optional. Do not make any of these required — the processor fails open if they are missing.

### 2f — `apps/workers/package.json`

Add to `dependencies`:

```json
"resend": "^4.0.0"
```

Run `pnpm install` after editing.

### 2g — `apps/workers/src/processors/send-welcome-email.ts` (new file)

```ts
import { Resend } from 'resend'

import { env, logger } from '@pathfinder/config'
import { updateJobRecord, writeJobRecord } from '@pathfinder/db'
import type { SendWelcomeEmailJobPayload } from '@pathfinder/jobs'

let resendClient: Resend | null = null

function getResendClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY)
  return resendClient
}

function buildEmailHtml(
  recipientName: string | null,
  orgName: string,
  dashboardUrl: string,
): string {
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi there,'
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#1a1a2e;">
  <h1 style="font-size:24px;font-weight:600;margin-bottom:8px;">Welcome to PathFinder</h1>
  <p style="margin:0 0 16px;">${greeting}</p>
  <p style="margin:0 0 16px;">
    <strong>${orgName}</strong> is set up and ready. Head to your dashboard to create your first
    venue and start building your AI guide.
  </p>
  <a href="${dashboardUrl}"
     style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
            padding:12px 24px;border-radius:9999px;font-size:14px;font-weight:500;">
    Open dashboard →
  </a>
  <p style="margin:32px 0 0;font-size:12px;color:#6b7280;">
    You're receiving this because you just created a PathFinder account.
  </p>
</body>
</html>`.trim()
}

export async function processSendWelcomeEmailJob(
  payload: SendWelcomeEmailJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: 'send-email',
    jobName: 'send-welcome-email',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const resend = getResendClient()

    if (!resend) {
      logger.warn({
        action: 'workers.send-welcome-email.skipped',
        reason: 'RESEND_API_KEY not configured',
        tenantId: payload.tenantId,
      })
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }

    const fromEmail = env.RESEND_FROM_EMAIL ?? 'noreply@pathfinder.ai'
    const dashboardUrl = env.DASHBOARD_URL ?? 'https://dashboard.pathfinder.ai'

    await resend.emails.send({
      from: `PathFinder <${fromEmail}>`,
      to: payload.to,
      subject: 'Welcome to PathFinder',
      html: buildEmailHtml(payload.recipientName, payload.orgName, dashboardUrl),
    })

    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.send-welcome-email.sent',
      tenantId: payload.tenantId,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    throw error
  }
}
```

### 2h — `apps/workers/src/index.ts`

**Imports to add** from `@pathfinder/jobs`:

- `SEND_EMAIL_QUEUE`
- `SEND_WELCOME_EMAIL_JOB`
- `SEND_WELCOME_EMAIL_RETRY_BACKOFF`
- `type SendWelcomeEmailJobPayload`

**Import to add** from local processors:

```ts
import { processSendWelcomeEmailJob } from './processors/send-welcome-email'
```

**Backoff function to add** (follow the same pattern as the others — only 3 attempts so fewer cases):

```ts
function getSendWelcomeEmailBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    default:
      return -1
  }
}
```

**Handler to add:**

```ts
async function handleSendEmailQueueJob(job: Job<SendWelcomeEmailJobPayload>) {
  if (job.name === SEND_WELCOME_EMAIL_JOB) {
    await processSendWelcomeEmailJob(job.data, job.id)
    return
  }
  throw new Error(`Unsupported send-email job: ${job.name}`)
}
```

**Inside `startWorkers()`**, add after the existing workers:

```ts
const sendEmailWorker = new Worker(SEND_EMAIL_QUEUE, handleSendEmailQueueJob, {
  connection,
  concurrency: 4,
  settings: {
    backoffStrategy: (attemptsMade, type) => {
      if (type === SEND_WELCOME_EMAIL_RETRY_BACKOFF) {
        return getSendWelcomeEmailBackoffDelay(attemptsMade)
      }
      return 0
    },
  },
})
```

Wire event listeners:

```ts
sendEmailWorker.on('completed', handleCompletedJob)
sendEmailWorker.on('failed', handleFailedJob)
```

Add `sendEmailWorker` to the `shutdown` `Promise.allSettled` array.

Add `sendEmailWorker` to the returned object.

Update the `logger.info` queues array at startup to include `SEND_EMAIL_QUEUE`.

### 2i — Clerk dashboard config

Verify that `organizationMembership.created` is checked in your Clerk webhook subscription (Clerk dashboard → Webhooks → your endpoint → subscribed events). The `ClerkWebhookEvent` union already includes this event type so it will be handled even if no change is needed in code.

### 2j — Environment variables to add in Railway

| Variable            | Where           | Value                                           |
| ------------------- | --------------- | ----------------------------------------------- |
| `RESEND_API_KEY`    | workers service | from Resend dashboard → API Keys                |
| `RESEND_FROM_EMAIL` | workers service | a verified sender address on your Resend domain |
| `DASHBOARD_URL`     | workers service | e.g. `https://dashboard.pathfinder.ai`          |

`RESEND_FROM_EMAIL` must be from a domain you have verified in Resend. During development you can use Resend's test address (`delivered@resend.dev`) or your personal email on a free Resend account.

---

## Tests

### Part 1

No new test file needed. Typecheck catches the removed `CreateOrganization` import.

### Part 2 — `apps/workers/src/processors/send-welcome-email.test.ts` (new file)

Write a Vitest unit test file covering:

1. **Happy path** — mock `resend.emails.send` to resolve, assert it was called with `to`, `subject: 'Welcome to PathFinder'`, and an `html` string that includes the org name.
2. **Missing API key** — set `env.RESEND_API_KEY` to `undefined`, assert `resend.emails.send` is NOT called and job record status is `COMPLETE` (fail-open).
3. **Resend throws** — mock `resend.emails.send` to reject, assert the processor re-throws so BullMQ retries and job record status is `FAILED`.

Mock `writeJobRecord` and `updateJobRecord` from `@pathfinder/db` using `vi.mock`.

---

## Definition of Done

- [ ] `/onboarding` page shows a branded form (no Clerk widget) for new users
- [ ] Org creation submits, activates the org, and redirects to `/` correctly
- [ ] `SEND_EMAIL_QUEUE` worker is registered and running in the workers service
- [ ] A new operator signup triggers a welcome email delivered to their inbox
- [ ] If `RESEND_API_KEY` is absent, the worker logs a warning and marks the job complete without throwing
- [ ] `pnpm typecheck` passes with no new errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (new processor tests green)
