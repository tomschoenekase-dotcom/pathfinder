# PathFinderOS — Platform Architecture

> Version: 1.0  
> Author: Principal Architect  
> Date: 2026-04-11  
> Status: Canonical reference — do not modify without architectural review  
> Intended consumers: engineering leads, coding agents (Codex), AI tooling

---

## 1. Executive Summary

### What This Product Is

PathFinderOS is a multi-tenant SaaS platform for venues, attractions, and local businesses. It provides each client (tenant) with operational tools, analytics, and integrations — while giving the platform owner full visibility and control via an internal admin console. End customers interact with tenants through a public-facing web app (e.g., browsing, booking, checking schedules).

### Recommended Platform Shape

A monorepo containing:
- A **Next.js** public web app (SSR/SSG, SEO-optimized)
- A **Next.js** client dashboard (SPA-style, authenticated)
- A **Next.js** internal admin console (authenticated, platform-owner only)
- A shared **tRPC + Prisma** API layer used by all three surfaces
- A **PostgreSQL** database with row-level tenant isolation
- **BullMQ** for background jobs
- **Clerk** for multi-tenant auth

All three surfaces share one backend but are deployed as separate Next.js apps to allow independent routing, access control, and deployment cadence.

### Highest-Risk Technical Areas

1. **Tenant isolation** — Cross-tenant data leakage would be catastrophic. Must be enforced at the database query layer, not just application logic.
2. **Integration framework** — External business systems (POS, booking, CRM) vary widely in reliability. Poorly designed adapter interfaces will cause compounding tech debt.
3. **Auth and permission model** — Multi-role, multi-tenant auth is easy to get wrong and expensive to refactor. Must be correct from day one.
4. **Analytics data model** — Building analytics on top of OLTP tables does not scale. A clean event log must be laid down early even if reporting is simple initially.
5. **Admin impersonation** — Platform owner accessing tenant data must be audited and scoped. One unlogged admin action in a tenant account is a compliance and trust failure.

---

## 2. Product Assumptions

### Confirmed Facts (from product brief)

- Three surfaces: public web app, client dashboard, internal admin console
- Multi-tenant: many companies/venues share the platform
- Required: multi-tenant auth, analytics/reporting, integration framework, operational visibility
- Architecture will be implemented incrementally by AI coding agents (Codex)
- Goal: strong MVP, modular architecture, minimal future rewrite

### Inferred Assumptions (labeled — resolve if incorrect)

| # | Assumption | Impact if Wrong |
|---|-----------|----------------|
| A1 | Tenants are businesses/venues, not end users. End users belong to a tenant's public audience. | Changes the auth model significantly |
| A2 | Each tenant has their own staff (managers, staff roles) who log into the client dashboard | Roles-per-tenant design is required |
| A3 | The public web app is tenant-branded or white-labeled per tenant (e.g., `venue.pathfinderos.com` or embedded widget) | Changes routing strategy |
| A4 | Integrations connect tenant's external tools (e.g., Square POS, Eventbrite, Shopify) — not platform-level integrations | Integration is per-tenant scoped |
| A5 | The platform owner (you) is the only internal admin user for now | Single-admin-org model for MVP |
| A6 | File uploads (photos, assets) exist but are not a core product feature — they are supporting | Storage can be simple (S3 + signed URLs) |
| A7 | Tenants are billed/subscribed, implying some form of plan/tier gating | Feature flags per tenant must support plan gating |
| A8 | The public web app is primarily read-heavy (browsing/discovery) with some transactional flows (bookings, registrations) | SSR/SSG is the right default |
| A9 | Initial scale: dozens to low hundreds of tenants, not thousands | Row-level isolation in Postgres is sufficient; no need for schema-per-tenant or separate DB-per-tenant at MVP |
| A10 | No native mobile app at MVP | Web-only, responsive |

---

## 3. Recommended Stack

### Frontend Framework
**Next.js 14+ (App Router)**  
All three surfaces. SSR for public app (SEO), app-router RSC for dashboard and admin. Shared component library via a `packages/ui` workspace.  
*Tradeoff: App Router is newer and has rough edges, but RSC reduces client bundle size and aligns with the long-term React direction. Avoids migrating later.*

### Backend Pattern
**tRPC v11 + Prisma ORM**  
tRPC provides end-to-end type-safe API calls between Next.js surfaces and the shared API layer without a REST or GraphQL layer. Prisma handles migrations and type-safe DB access.  
*Tradeoff: tRPC is excellent within the monorepo but awkward for third-party API consumers. Acceptable — external webhooks can be handled by plain Next.js API routes.*

### Database
**PostgreSQL (via Supabase or Railway for hosting)**  
Single database, row-level tenant isolation enforced via a `tenant_id` column on every multi-tenant table and a Prisma middleware that injects tenant context on every query.  
*Tradeoff: Schema-per-tenant is safer for isolation but far more operationally complex. Row-level is sufficient at this scale and avoids migration nightmares.*

### Auth
**Clerk**  
Handles multi-tenant orgs, team invites, user management, JWTs, MFA, and social login out of the box. Clerk's "organizations" map 1:1 to PathFinderOS tenants.  
*Tradeoff: Clerk is opinionated and has monthly costs. The alternative (Auth.js/NextAuth) requires building org/membership logic manually — not worth it given the complexity of multi-tenant auth.*

### File Storage
**AWS S3 (or Cloudflare R2 for cost)**  
Presigned uploads from the client, served via CDN. Never proxy files through the app server.  
*Tradeoff: R2 has no egress fees, making it cheaper for image-heavy tenants. Use R2 unless AWS is already the deployment target.*

### Analytics Tooling
**PostHog (self-hosted or cloud)**  
Product analytics (events, funnels, feature flags, session replay). Runs alongside the platform's own analytics tables which power the client dashboard.  
*Tradeoff: Mixpanel and Amplitude are more polished but cost more and don't support self-hosting. PostHog covers product analytics + feature flags in one tool.*

### Background Jobs
**BullMQ (Redis-backed)**  
Queues, retries, scheduling, and dead-letter visibility. Used for integrations, email, report generation, webhook dispatch.  
*Tradeoff: Inngest is a good managed alternative and removes Redis dependency. Use BullMQ if self-hosting; Inngest if minimizing infra.*

### Admin Tooling
**Custom Next.js admin surface** (no third-party admin panel like Retool)  
Admin console is a first-class surface in the monorepo. This is not a nice-to-have — it is the platform owner's primary operational interface. Building it custom ensures it's always in sync with the data model.  
*Tradeoff: Slower to build than Retool or Adminjs. Worth it because admin needs impersonation, audit logs, and tenant management — things off-the-shelf panels do poorly.*

### Deployment / Infrastructure
**Vercel (app hosting) + Railway or Supabase (PostgreSQL) + Upstash (Redis for BullMQ)**  
Vercel for Next.js apps (preview deploys, edge middleware, instant rollback). Railway for Postgres + Redis if not using Supabase. Upstash for serverless Redis.  
*Tradeoff: Vercel adds cost at scale. Acceptable for MVP. Plan a migration path to self-hosted infra if margins require it later.*

### Integration Layer Strategy
**Provider pattern with a shared adapter interface**  
Each external integration (Square, Eventbrite, etc.) implements a typed `IntegrationAdapter` interface. Integration runs via background jobs. No live synchronous calls to external APIs in the request path.  
*Tradeoff: More upfront design work, but prevents ad-hoc integration spaghetti that would require a full rewrite.*

### Testing / Tooling Baseline
- **Vitest** — unit and integration tests (fast, ESM-native)
- **Playwright** — E2E tests for critical user flows (auth, booking, dashboard)
- **Prisma** test utilities with a separate test database
- **ESLint + Prettier** enforced via CI
- **TypeScript strict mode** — no implicit any, strict null checks
- **Husky + lint-staged** — pre-commit quality gate

---

## 4. Platform Surfaces

### 4.1 Public Web App

**User type:** End customers / general public (unauthenticated or lightly authenticated)

**Key capabilities:**
- Browse venue/attraction listings (tenant-owned content)
- View schedules, events, menus, hours
- Make bookings or registrations (if tenant enables it)
- Contact forms, ticketing, waitlists
- Tenant-branded experience (subdomain or embedded)

**Main data read/written:**
- Reads: `Tenant`, `Listing`, `Event`, `Schedule`, `AvailabilitySlot`
- Writes: `Booking`, `Registration`, `ContactSubmission`, `GuestUser`

**Shared with other surfaces:**
- Reads tenant configuration and content published from the client dashboard
- Booking/registration data surfaces in the client dashboard

**Must remain isolated:**
- No access to tenant staff data, financials, integration credentials, or internal analytics
- Cannot read cross-tenant data under any circumstances
- Public routes must be rate-limited independently from dashboard routes

---

### 4.2 Client / Company Dashboard

**User type:** Tenant staff — owners, managers, front-line operators

**Key capabilities:**
- Manage listings, events, schedules, and published content
- View bookings, registrations, and customer data
- Configure integrations with external tools
- View analytics and operational reports
- Manage team members and assign roles
- Configure tenant settings (branding, notifications, hours)

**Main data read/written:**
- Reads/Writes: all tenant-scoped business objects
- Reads: analytics events aggregated for this tenant
- Writes: integration credentials (encrypted), team invitations

**Shared with other surfaces:**
- Published content flows to public web app
- Operational data (bookings, events) is visible in admin console for support

**Must remain isolated:**
- Strictly scoped to the authenticated tenant — no cross-tenant reads
- Integration credentials must never be returned to the client in plaintext
- Tenant users must not access admin-only metadata (billing internals, platform config)

---

### 4.3 Internal Admin Console

**User type:** Platform owner (you) and any future internal team members

**Key capabilities:**
- View all tenants and their operational state
- Impersonate tenant users for support (with full audit logging)
- Manage tenant feature flags and plan limits
- View platform-wide analytics (usage, revenue proxies, error rates)
- Manually trigger or repair integration jobs
- View and manage background job queues
- View audit logs across all tenants
- Manage platform configuration, announcements, and maintenance windows

**Main data read/written:**
- Reads: all platform data across all tenants
- Writes: `FeatureFlag`, `TenantConfig`, `AuditLog`, `PlatformAnnouncement`

**Shared with other surfaces:**
- Feature flags set here propagate to client dashboard behavior
- Audit logs are written by all surfaces and read here

**Must remain isolated:**
- Accessible only to users with `PLATFORM_ADMIN` role
- Must not be deployed on the same domain as the public app
- All admin actions must be audit-logged with actor identity, timestamp, and changed values
- Impersonation must create a scoped session that expires and cannot escalate to platform-admin

---

## 5. Multi-Tenant Architecture

### Tenant Model

A **tenant** is a single business or venue. Each tenant is created when a company signs up. Internally, a tenant maps to a Clerk Organization and a `Tenant` row in the database.

All user-generated content and operational data carries a `tenant_id` foreign key. The application layer never executes a multi-tenant query without this filter. A Prisma middleware enforces this as a hard constraint — it throws at runtime if a query against a tenanted table omits `tenant_id`.

### Organizations / Workspaces

- **Org = Tenant** — Clerk organizations are the canonical identity of a tenant
- `tenant_id` in the database is the Clerk organization ID (string, UUID format)
- No sub-workspaces at MVP. If a tenant needs departments or locations, model them as `Location` entities under the tenant, not as sub-tenants

### Memberships

- `TenantMembership` joins a `User` to a `Tenant` with a role
- A user can belong to multiple tenants (e.g., a consultant) — each membership has its own role
- Clerk handles invitation flow; the platform mirrors membership in its own `TenantMembership` table for query purposes
- Membership sync from Clerk to the platform DB is handled via Clerk webhooks on `organizationMembership.created/deleted/updated`

### Roles and Permissions

Three tenant-level roles at MVP:

| Role | Description |
|------|-------------|
| `OWNER` | Full tenant access, billing, team management |
| `MANAGER` | Operational access, cannot modify billing or delete tenant |
| `STAFF` | Read-only + limited operational actions (check-ins, etc.) |

One platform-level role:

| Role | Description |
|------|-------------|
| `PLATFORM_ADMIN` | Full platform access — separate from tenant roles |

Permissions are checked server-side in tRPC procedures via a `requireTenantRole(ctx, tenantId, minRole)` helper. Never trust client-sent role claims.

### Tenant Isolation

Enforced at multiple layers:

1. **Prisma middleware** — injects `where: { tenant_id }` on all queries against tenanted tables; throws if absent
2. **tRPC context** — resolves `activeTenantId` from the session on every request; procedures receive it as an immutable context value
3. **API route guards** — no route handler touches tenant data without verifying the caller's membership for that tenant
4. **No shared caches** — Redis keys for tenant data are namespaced as `tenant:{id}:*`

### Feature Flags by Tenant

Feature flags are stored in a `TenantFeatureFlag` table (not a third-party service — PostHog flags are for product analytics only, not authorization gates).

```
TenantFeatureFlag {
  tenant_id
  flag_key        -- e.g., "integrations.square", "analytics.advanced"
  enabled
  metadata        -- JSON, e.g., plan tier, override reason
  set_by          -- platform admin user id
  set_at
}
```

The platform checks `featureEnabled(tenantId, 'flag.key')` in tRPC middleware before executing gated procedures. This is the mechanism for plan-gating features.

### Audit Logging

Every state-modifying action by a tenant user or admin creates an `AuditLog` entry:

```
AuditLog {
  id
  tenant_id       -- null for platform-level actions
  actor_id        -- user who performed the action
  actor_role      -- their role at time of action
  action          -- e.g., "booking.cancelled", "integration.connected"
  target_type     -- entity type
  target_id       -- entity id
  before_state    -- JSON snapshot (optional)
  after_state     -- JSON snapshot (optional)
  ip_address
  user_agent
  created_at
}
```

Audit logs are **append-only** — no updates or deletes, ever. Retained for minimum 2 years.

### Support / Admin Access Boundaries

- Platform admin can view any tenant's data in read-only mode without impersonation
- Impersonation (acting as a tenant user) requires an explicit `AdminImpersonationSession`:
  - Short-lived token (1 hour max)
  - Tied to specific tenant
  - Every action within the impersonation session is logged with `impersonated_by: adminUserId`
  - Cannot be used to access other tenants or the admin console itself

---

## 6. Data Model

### 6.1 Identity and Access

**User**
- Purpose: Platform-level identity, mirrors Clerk user
- Fields: `id` (Clerk user ID), `email`, `full_name`, `avatar_url`, `created_at`, `last_seen_at`
- Relations: has many `TenantMembership`
- MVP criticality: **now**

**Tenant**
- Purpose: A business/venue on the platform
- Fields: `id` (Clerk org ID), `name`, `slug`, `plan_tier`, `status` (active/suspended/trial), `created_at`, `config` (JSON)
- Relations: has many `TenantMembership`, owns all business entities
- MVP criticality: **now**

**TenantMembership**
- Purpose: Links user to tenant with a role
- Fields: `id`, `tenant_id`, `user_id`, `role`, `invited_by`, `joined_at`, `status` (active/invited/removed)
- Relations: belongs to `User`, belongs to `Tenant`
- MVP criticality: **now**

**TenantFeatureFlag**
- Purpose: Per-tenant feature/plan gating
- Fields: `id`, `tenant_id`, `flag_key`, `enabled`, `metadata` (JSON), `set_by`, `set_at`
- MVP criticality: **now**

**AuditLog**
- Purpose: Immutable record of state-changing actions
- Fields: see Section 5
- MVP criticality: **now**

**AdminImpersonationSession**
- Purpose: Track admin impersonation events
- Fields: `id`, `admin_user_id`, `tenant_id`, `impersonated_user_id`, `started_at`, `ended_at`, `reason`, `actions_count`
- MVP criticality: **now**

---

### 6.2 Business Domain

**Listing**
- Purpose: A venue, attraction, product, or service a tenant publishes
- Fields: `id`, `tenant_id`, `name`, `type` (venue/event/service), `description`, `status` (draft/published/archived), `images` (JSON array of storage keys), `metadata` (JSON), `created_at`, `updated_at`
- Relations: has many `Event`, `AvailabilitySlot`, `Booking`
- MVP criticality: **now**

**Event**
- Purpose: A scheduled happening under a listing
- Fields: `id`, `tenant_id`, `listing_id`, `title`, `starts_at`, `ends_at`, `capacity`, `status`, `external_id` (from integration), `metadata` (JSON)
- Relations: belongs to `Listing`, has many `Booking`
- MVP criticality: **now**

**AvailabilitySlot**
- Purpose: Bookable time blocks (for reservations, appointments)
- Fields: `id`, `tenant_id`, `listing_id`, `starts_at`, `ends_at`, `capacity`, `booked_count`, `status`
- MVP criticality: **soon**

**Booking**
- Purpose: A reservation or registration by an end user
- Fields: `id`, `tenant_id`, `listing_id`, `event_id` (nullable), `slot_id` (nullable), `guest_user_id`, `status` (pending/confirmed/cancelled), `notes`, `created_at`, `source` (web/import/integration)
- Relations: belongs to `Listing`, belongs to `GuestUser`
- MVP criticality: **now**

**GuestUser**
- Purpose: Public end-user (not a staff member)
- Fields: `id`, `tenant_id`, `email`, `full_name`, `phone`, `created_at`, `source`
- Note: Guest users are scoped to a tenant — same email at two tenants is two different guest user records
- MVP criticality: **now**

**Location**
- Purpose: Physical or logical sub-locations for a tenant (e.g., multiple venues)
- Fields: `id`, `tenant_id`, `name`, `address` (JSON), `timezone`, `status`
- MVP criticality: **soon**

---

### 6.3 Analytics / Reporting

**AnalyticsEvent**
- Purpose: Append-only event log for business analytics (separate from PostHog product events)
- Fields: `id`, `tenant_id`, `event_type` (e.g., `booking.created`, `listing.viewed`), `actor_id` (nullable), `subject_type`, `subject_id`, `properties` (JSON), `occurred_at`
- Note: This table is the source of truth for the client dashboard's reports. Never query OLTP tables for aggregate reports.
- MVP criticality: **now** (schema only; reports powered by it: **soon**)

**DailyRollup**
- Purpose: Pre-aggregated daily stats per tenant (for fast dashboard queries)
- Fields: `id`, `tenant_id`, `date`, `metric_key`, `value`, `dimensions` (JSON)
- Note: Populated by a nightly background job from `AnalyticsEvent`
- MVP criticality: **soon**

**ReportSnapshot**
- Purpose: On-demand or scheduled report results cached for dashboard display
- Fields: `id`, `tenant_id`, `report_type`, `parameters` (JSON), `result` (JSON), `generated_at`, `expires_at`
- MVP criticality: **later**

---

### 6.4 Integrations

**IntegrationConnection**
- Purpose: A tenant's authenticated connection to an external system
- Fields: `id`, `tenant_id`, `provider` (e.g., `square`, `eventbrite`), `status` (active/error/disconnected), `credentials` (encrypted JSON), `config` (JSON), `last_synced_at`, `error_message`, `created_at`
- MVP criticality: **soon**

**IntegrationSyncLog**
- Purpose: Record of each sync attempt
- Fields: `id`, `connection_id`, `tenant_id`, `sync_type`, `status` (pending/success/partial/failed), `records_processed`, `records_failed`, `error_details` (JSON), `started_at`, `completed_at`
- MVP criticality: **soon**

**IntegrationWebhookEvent**
- Purpose: Inbound webhook events from external providers before processing
- Fields: `id`, `connection_id`, `provider`, `event_type`, `payload` (JSON), `signature_verified`, `status` (received/processed/failed), `received_at`, `processed_at`, `error`
- MVP criticality: **soon**

---

### 6.5 Operations / Admin / Support

**PlatformConfig**
- Purpose: Global platform settings
- Fields: `key`, `value` (JSON), `updated_by`, `updated_at`
- MVP criticality: **now**

**PlatformAnnouncement**
- Purpose: System notices shown to tenants in dashboard
- Fields: `id`, `title`, `body`, `severity` (info/warning/critical), `active`, `starts_at`, `ends_at`, `created_by`
- MVP criticality: **later**

**JobRecord**
- Purpose: Track scheduled/async job outcomes for admin visibility
- Fields: `id`, `tenant_id` (nullable), `job_type`, `job_id` (BullMQ job ID), `status`, `payload` (JSON), `result` (JSON), `error`, `attempts`, `created_at`, `completed_at`
- MVP criticality: **soon**

---

## 7. Integration Framework

### Design Philosophy

Integrations are always async, always scoped to a tenant, and always recoverable. No integration code runs in the request path. The platform treats integrations as unreliable by default.

### Adapter Interface

Every integration provider implements this interface:

```typescript
// pseudocode — not production code

interface IntegrationAdapter {
  provider: string                    // e.g., "square", "eventbrite"
  version: string                     // e.g., "2024-01"

  // Called when tenant connects the integration
  connect(config: ConnectConfig): Promise<ConnectionResult>

  // Called to validate stored credentials are still valid
  validateCredentials(credentials: EncryptedCredentials): Promise<boolean>

  // Full sync of a resource type
  sync(
    connection: IntegrationConnection,
    resourceType: ResourceType,        // e.g., "events", "orders"
    options: SyncOptions
  ): Promise<SyncResult>

  // Handle inbound webhook from the provider
  handleWebhook(
    event: RawWebhookEvent,
    connection: IntegrationConnection
  ): Promise<WebhookHandleResult>

  // Verify webhook signature
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
    secret: string
  ): boolean

  // Map provider data to platform model
  mapToInternal<T>(providerRecord: unknown): T

  // Gracefully disconnect
  disconnect(connection: IntegrationConnection): Promise<void>
}
```

### Connection / Auth Model

- OAuth2 providers: platform stores `access_token` + `refresh_token`, encrypted at rest using AES-256 with a per-deployment master key
- API key providers: store key encrypted at rest
- Credentials are **never** returned to the client — only connection status and last-synced time
- Token refresh is handled by a scheduled job before expiry, not on-demand

### Sync Model

Syncs run as BullMQ jobs with the following lifecycle:

1. Job enqueued with `{ connectionId, tenantId, resourceType, syncType: 'full' | 'delta' }`
2. Job fetches connection + credentials
3. Adapter's `sync()` is called — pages through provider API
4. Each record is upserted into the platform DB using `external_id` + `provider` as the deduplication key
5. `IntegrationSyncLog` is written with outcome
6. `AnalyticsEvent` emitted: `integration.sync.completed` or `integration.sync.failed`

Delta syncs use a `since` cursor (stored in `IntegrationConnection.config`).

### Webhook Model

1. Provider sends POST to `/api/webhooks/{provider}/{connectionId}`
2. Signature verified **before** any DB read
3. Raw event stored in `IntegrationWebhookEvent` with `status: received`
4. BullMQ job enqueued to process it asynchronously
5. Response `200 OK` returned immediately (within 200ms) — never block on processing
6. Processing job calls adapter's `handleWebhook()`, updates event status

### Retry Strategy

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 30 seconds |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |

After 5 failures: job moves to dead-letter queue, `IntegrationConnection.status` set to `error`, tenant notified in dashboard, `JobRecord` flagged for admin visibility.

### Error Visibility

- All sync failures are queryable by admin via `JobRecord` + `IntegrationSyncLog`
- Tenant sees a simplified status in their dashboard ("Last synced 3h ago — 2 errors")
- Detailed error JSON stored in `IntegrationSyncLog.error_details` — visible to admin, not to tenant

### Manual Admin Repair Flow

Admin console exposes:
- View all failed jobs for a connection
- Re-enqueue a specific failed sync or webhook job
- Force full re-sync for a connection
- Manually override connection status (e.g., force-reconnect prompt)
- View raw error payload

### Observability

- Every job start/complete/fail emits a structured log line: `{ level, job_type, connection_id, tenant_id, duration_ms, status, error? }`
- BullMQ metrics (queue depth, failed count) exposed as a platform health check endpoint
- A platform dashboard widget shows real-time integration queue health

### Versioning / Extensibility

- Each adapter has a `version` field — breaking provider API changes create a new adapter version
- `IntegrationConnection` stores `adapter_version` — allows migrating connections to new adapter versions independently
- Adding a new provider = create a new file implementing `IntegrationAdapter`, register it in `integrationRegistry`

---

## 8. Analytics Architecture

### Two Separate Concerns

Do not conflate **product analytics** (how users use the platform) with **business analytics** (what tenants care about operationally). They serve different audiences, different latencies, and different query patterns.

### Product Analytics (PostHog)

- **What it tracks:** platform usage — page views, button clicks, feature adoption, funnel dropoffs, session replays
- **Who sees it:** platform owner only, via PostHog dashboard
- **What lives here:** `$pageview`, `feature_used`, `integration_connected`, `dashboard_visited`
- **Implementation:** PostHog JS snippet in all three surfaces, server-side event capture for critical flows
- **Do not store:** PII beyond what PostHog's data policies allow; no business transaction data

### Business / Operational Analytics (Platform Tables)

- **What it tracks:** things tenants care about — bookings, revenue proxies, event attendance, integration errors
- **Source of truth:** `AnalyticsEvent` table — append-only, immutable, tenant-scoped
- **Who sees it:** tenant users (in client dashboard) and platform admin (in admin console)

#### Event Strategy

Every significant business action emits an `AnalyticsEvent` row from the server side (never trust client-sent events for business analytics):

```
booking.created       { booking_id, listing_id, guest_id, source }
booking.cancelled     { booking_id, reason }
listing.published     { listing_id, listing_type }
event.created         { event_id, listing_id }
integration.connected { provider }
integration.sync.*    { connection_id, records_processed }
member.invited        { invited_user_id, role }
```

#### What Powers the Client Dashboard

- **Real-time widgets:** query `AnalyticsEvent` directly for recent activity (last 24h)
- **Trend charts:** query `DailyRollup` for historical data (pre-aggregated nightly)
- **Reports:** query `DailyRollup` or generate `ReportSnapshot` for longer date ranges
- Rule: no OLTP joins in analytics queries — use the event log or rollups

#### What Powers the Admin Console

- Tenant health overview: last_active, bookings_7d, sync_errors_open
- Platform usage: active tenants, new tenants, integration adoption rates
- Job queue health: failed jobs, dead-letter count
- Sources: a platform-level `AnalyticsEvent` aggregate view (all tenants) + `JobRecord` + `IntegrationSyncLog`

---

## 9. Background Jobs

### Job Categories

#### 1. Integration Syncs
- **Trigger:** Scheduled (cron per connection) or manual (admin/tenant-triggered)
- **Purpose:** Pull data from external providers into platform tables
- **Failure modes:** Provider API down, expired credentials, rate limits, schema changes
- **Admin visibility:** `IntegrationSyncLog`, `JobRecord` with error details, dead-letter queue

#### 2. Webhook Processing
- **Trigger:** Inbound POST to webhook endpoint
- **Purpose:** Process inbound provider events asynchronously
- **Failure modes:** Malformed payload, unmapped event type, DB write failure
- **Admin visibility:** `IntegrationWebhookEvent` status, retry count, raw error

#### 3. Analytics Rollups
- **Trigger:** Nightly cron (00:30 UTC)
- **Purpose:** Aggregate `AnalyticsEvent` rows into `DailyRollup` for fast dashboard queries
- **Failure modes:** Query timeout on large tenant data, partial writes
- **Admin visibility:** Job record per run; alert if last rollup is >26h old

#### 4. Token Refresh
- **Trigger:** Scheduled (every 30 minutes), checks credentials expiring within 1 hour
- **Purpose:** Refresh OAuth tokens before expiry to avoid sync failures
- **Failure modes:** Provider refresh endpoint down, revoked token, user disconnected app
- **Admin visibility:** Connection status turns `error`, tenant sees reconnect prompt

#### 5. Email / Notification Dispatch
- **Trigger:** System events (booking confirmed, invitation sent, error alerts)
- **Purpose:** Deliver transactional emails via SendGrid/Resend
- **Failure modes:** Delivery failures, invalid address, provider rate limit
- **Admin visibility:** Delivery status in `JobRecord`; failed emails are not silently dropped

#### 6. Booking / Slot Expiry
- **Trigger:** Scheduled (every 5 minutes)
- **Purpose:** Cancel held/unconfirmed bookings after TTL expiry, release slots
- **Failure modes:** Race conditions on slot availability
- **Admin visibility:** Count of expired bookings per run in `JobRecord`

#### 7. Report Generation
- **Trigger:** Tenant-requested or scheduled (monthly report)
- **Purpose:** Build `ReportSnapshot` from rollup data
- **Failure modes:** Timeout on large date ranges
- **Admin visibility:** Job record + snapshot status

---

## 10. Security Baseline

### Auth / Session Model

- All sessions are Clerk-issued JWTs, verified server-side on every request via Clerk's `auth()` helper
- JWTs expire in 1 hour and are refreshed silently by Clerk's client SDK
- `activeTenantId` is resolved from the JWT org claim — never from a client-sent parameter
- Sessions are stateless (JWT) — no session table to manage

### Permission Enforcement

- Permissions checked in tRPC procedure middleware, never in UI components
- Pattern: `requireRole(ctx, 'MANAGER')` is the first line of any mutating procedure
- Resource-level checks: before any entity read/write, verify `entity.tenant_id === ctx.activeTenantId`
- Platform admin role is a separate Clerk claim checked at the admin surface's root middleware
- No permission logic in frontend code — UI adapts to what the server returns, not what it assumes

### Tenant Isolation

- Prisma middleware appends `where: { tenant_id: ctx.activeTenantId }` to all tenanted queries
- This middleware throws (not silently skips) if `activeTenantId` is missing in a context that requires it
- Full test coverage required on the middleware itself — this is the most critical security control in the system

### Secrets Handling

- Integration credentials encrypted with AES-256-GCM before storage, using an environment-provided master key
- No secrets in git history or logs — structured logging sanitizes all payloads before writing
- All environment secrets managed via platform hosting provider's secret manager (Vercel env vars or Railway secrets), not `.env` files in repo
- `.env.example` in repo contains only key names, no values

### Webhook Verification

- Every inbound webhook verified by the adapter's `verifyWebhookSignature()` before the payload is read
- Verification uses HMAC-SHA256 or provider-specific scheme (Stripe-style)
- Unverified payloads are rejected with `401` — not processed, not stored
- The raw body buffer is preserved before any JSON parsing for signature verification

### Auditability

- `AuditLog` is written for all CREATE, UPDATE, DELETE on business entities
- `AuditLog` is written for all admin actions including reads that involve sensitive data
- Logs are append-only — no soft-deletes, no updates
- `AdminImpersonationSession` captures full scope and duration of every impersonation event

### Admin Impersonation Safety

- Impersonation creates a scoped token with explicit `tenant_id` binding — cannot escalate
- Every action within an impersonation session carries `impersonated_by` in the audit log
- Impersonation sessions expire after 1 hour with no renewal
- Impersonation events emit a real-time notification in the admin console (visible to other admins if multiple)
- Impersonating to access another admin's account is architecturally impossible (tenant_id binding)

### Rate Limits

- Public API routes: 60 req/min per IP
- Auth endpoints: 10 req/min per IP
- Dashboard API routes: 300 req/min per tenant
- Webhook endpoints: 500 req/min per provider+connection (providers can burst)
- Limits enforced via Vercel edge middleware or Upstash Redis rate limiter

### Logging Guidelines

- All logs are structured JSON
- Every log line includes: `{ timestamp, level, service, request_id, tenant_id?, user_id?, action }`
- PII (email, name, phone) must not appear in log messages — use IDs only
- Error logs include stack trace but sanitize any request body that might contain credentials
- Logs shipped to a log aggregator (Datadog, Axiom, or Logtail) — not retained on app server

---

## 11. MVP Cut

### Must-Have for MVP

- [ ] Multi-tenant auth via Clerk (orgs, memberships, roles)
- [ ] Tenant onboarding flow (sign up → create org → first listing)
- [ ] Listing management (create, edit, publish, archive)
- [ ] Basic booking/registration (create, confirm, cancel)
- [ ] Client dashboard shell with navigation and auth-gated routes
- [ ] Public web app (tenant-branded listing pages, booking form)
- [ ] Internal admin console with tenant list, tenant detail, and audit log view
- [ ] `AnalyticsEvent` table and server-side emit on key actions
- [ ] `AuditLog` table and writes on all mutations
- [ ] `TenantFeatureFlag` table and enforcement middleware
- [ ] Background job infrastructure (BullMQ + Redis)
- [ ] Email dispatch (booking confirmation, team invitation)
- [ ] File upload to S3/R2 (listing images)
- [ ] Security baseline (rate limits, tenant isolation middleware, webhook verification scaffolding)
- [ ] One integration (suggest: a simple calendar or webhook-based provider to validate the framework)
- [ ] Deployment pipeline (Vercel + Railway, preview deploys on PR)

### Should-Have After MVP

- [ ] `AvailabilitySlot` model and slot-based booking
- [ ] Multi-location support (`Location` entity)
- [ ] Analytics dashboard in client surface (powered by `DailyRollup`)
- [ ] Nightly analytics rollup job
- [ ] Token refresh job for OAuth integrations
- [ ] Admin impersonation flow
- [ ] 2–3 additional integration providers
- [ ] Tenant plan tier enforcement via feature flags
- [ ] Booking/slot expiry job
- [ ] PostHog integration (product analytics)
- [ ] Admin job queue visibility (dead-letter, manual re-enqueue)

### Later / Scale Features

- [ ] `ReportSnapshot` and scheduled report generation
- [ ] Advanced analytics (cohorts, funnels) in client dashboard
- [ ] Webhook delivery from platform to tenant (outbound webhooks)
- [ ] Guest user portal (return to manage bookings)
- [ ] Public API for tenants (REST + API keys)
- [ ] Custom domain support (per-tenant vanity domains)
- [ ] Sub-locations and multi-property tenants
- [ ] Mobile-optimized public app (PWA or separate React Native surface)
- [ ] Automated billing integration (Stripe subscriptions tied to plan tiers)
- [ ] Multi-region deployment / data residency

---

## 12. Build Order

### Phase 0 — Repo Foundation (Week 1)
**Goal:** Working monorepo with tooling, CI, and deployable skeleton apps

**Deliverables:**
- Turborepo monorepo with `apps/web`, `apps/dashboard`, `apps/admin`, `packages/ui`, `packages/db`, `packages/config`
- TypeScript strict mode, ESLint, Prettier, Husky configured across all packages
- Prisma schema with `User`, `Tenant`, `TenantMembership` and initial migration
- Clerk integrated in all three apps (middleware, auth context)
- Vercel project per app, linked to repo with preview deploys
- Railway (or Supabase) Postgres and Upstash Redis provisioned
- CI pipeline: type-check, lint, test on every PR

**Dependencies:** None  
**Validation:** All three apps deploy to Vercel. Auth flow works (sign in, sign out). DB migration runs cleanly.

---

### Phase 1 — Auth and Tenancy (Week 2)
**Goal:** Multi-tenant auth fully wired; permissions enforced

**Deliverables:**
- Tenant creation flow (sign up → Clerk org → `Tenant` row)
- `TenantMembership` sync from Clerk webhooks
- tRPC context resolves `activeTenantId` and `callerRole` on every request
- Tenant isolation Prisma middleware (throws on missing tenant context)
- `TenantFeatureFlag` table and `featureEnabled()` utility
- `AuditLog` table with write helper
- `requireRole()` and `requirePlatformAdmin()` tRPC middleware
- Team invitation flow (Clerk invite → membership created)

**Dependencies:** Phase 0  
**Validation:** A user can create a tenant, invite a team member, log in as that member, and be denied access to another tenant's data. Platform admin role blocks non-admin users from admin console.

---

### Phase 2 — Core Business Objects (Weeks 3–4)
**Goal:** Listings and bookings functional end-to-end

**Deliverables:**
- `Listing`, `Event`, `GuestUser`, `Booking` schema + migrations
- Listing CRUD in tRPC with role enforcement
- Client dashboard: listings list, create/edit listing form, image upload
- Public web app: listing detail page (SSR), booking form
- Booking creation flow (guest user created or matched, booking confirmed)
- `AnalyticsEvent` emitted on key actions (booking.created, listing.published)
- Email job: booking confirmation dispatch
- BullMQ worker infrastructure running (even if jobs are minimal)

**Dependencies:** Phase 1  
**Validation:** A tenant can publish a listing. A public user can view it and create a booking. The booking appears in the client dashboard. An analytics event row is written.

---

### Phase 3 — Admin Console and Observability (Week 5)
**Goal:** Platform owner has operational visibility

**Deliverables:**
- Admin console: tenant list, tenant detail page, audit log viewer
- Admin console: `JobRecord` list with status and error detail
- Admin impersonation session (scoped, audited, expires)
- Platform health check endpoint (DB, Redis, queue depth)
- Structured logging in place across all services
- Admin console: feature flag management per tenant

**Dependencies:** Phase 2  
**Validation:** Platform admin can view all tenants, see their bookings and audit log, impersonate a tenant user, and see the impersonation event logged. Job failures appear in admin console.

---

### Phase 4 — Integration Framework (Weeks 6–7)
**Goal:** Integration adapter pattern functional with one real provider

**Deliverables:**
- `IntegrationAdapter` interface (TypeScript) finalized
- `IntegrationConnection`, `IntegrationSyncLog`, `IntegrationWebhookEvent` schema
- Integration registry (maps `provider` string to adapter class)
- Encrypted credential storage (AES-256-GCM)
- BullMQ workers for sync and webhook processing jobs
- Retry strategy implemented
- One real adapter implemented (e.g., a simple webhook-based provider or Google Calendar)
- Client dashboard: integration connect/disconnect flow
- Admin console: integration error visibility, manual re-sync trigger

**Dependencies:** Phase 3  
**Validation:** Tenant can connect an integration. A sync runs. Records appear in the platform DB. A forced sync failure appears in admin console and can be re-triggered manually.

---

### Phase 5 — Analytics and Polish (Week 8)
**Goal:** Dashboard is useful; platform is stable enough for first tenants

**Deliverables:**
- Nightly rollup job producing `DailyRollup` rows
- Client dashboard analytics widgets (bookings over time, listing views)
- PostHog installed on all surfaces
- Rate limits enforced on all surfaces
- Webhook signature verification for the live integration
- Token refresh job for OAuth integrations
- Full E2E test suite covering: sign up, create listing, make booking, view analytics

**Dependencies:** Phase 4  
**Validation:** Client dashboard shows meaningful analytics. Rate limiter rejects abuse. Nightly job runs and populates rollup. PostHog shows events in product dashboard.

---

## 13. Main Risks and How to Prevent Them

### Risk 1: Tenant Isolation Failure
**Impact:** Critical — cross-tenant data leak destroys trust  
**Prevention:**
- Prisma middleware is the canonical enforcement point — test it in isolation with adversarial inputs
- Integration tests must assert that querying as Tenant A never returns Tenant B data
- Code review rule: any new tRPC procedure must demonstrate tenant context is used
- Never pass raw SQL to Prisma's `$queryRaw` without explicit `tenant_id` in the WHERE clause

### Risk 2: Integration Framework Becomes Ad-Hoc
**Impact:** High — each integration adds complexity without the adapter pattern; impossible to maintain at 10+ providers  
**Prevention:**
- Finalize and commit the `IntegrationAdapter` interface before writing any provider code
- First integration must be a strict implementation of the interface — no shortcuts
- Code review gate: any new integration that doesn't implement the interface is rejected

### Risk 3: Auth Token / Credential Leakage
**Impact:** Critical — platform stores OAuth tokens for tenant integrations  
**Prevention:**
- Encryption-at-rest is non-negotiable; test the encrypt/decrypt cycle in unit tests
- Audit all tRPC procedures that return connection data — none may return raw credentials
- Add a CI check that scans for known credential field names in API responses

### Risk 4: Architectural Drift by Coding Agents
**Impact:** High — Codex implementing tasks without understanding architecture will create inconsistency  
**Prevention:**
- This document is the authoritative reference; task packets for Codex must link to relevant sections
- Each task packet must specify: which tRPC router to add procedures to, which Prisma models to touch, which middleware to apply
- Codex must not create new patterns (new auth flows, new job patterns) without explicit instruction; it should extend existing ones

### Risk 5: Analytics Tables Overloaded with Ad-Hoc Queries
**Impact:** Medium — OLTP tables queried for reports will degrade at scale  
**Prevention:**
- Establish the rule in Phase 2: dashboard components may only query `AnalyticsEvent` or `DailyRollup`, not `Booking` or `Listing` for aggregates
- Code review gate: any dashboard query against OLTP tables for aggregate data is rejected

### Risk 6: BullMQ Jobs Failing Silently
**Impact:** Medium — broken integrations go unnoticed, tenant data falls behind  
**Prevention:**
- Every job writes a `JobRecord` — this is not optional
- Failed jobs after max retries must update `IntegrationConnection.status` to `error` and surface in admin console
- Set up an alert on dead-letter queue depth > 0

### Risk 7: Admin Console Deployed Incorrectly (Public-Facing)
**Impact:** High — admin console must never be accessible without platform-admin auth  
**Prevention:**
- Admin app deployed on a separate domain (e.g., `admin.pathfinderos.com`) with its own Vercel project
- Root middleware on the admin app rejects any session without `PLATFORM_ADMIN` claim before rendering any page
- CSP headers on admin app block embedding

---

## 14. Final Recommendation

### Architecture in Plain English

Build a TypeScript monorepo with three Next.js apps sharing a single tRPC + Prisma backend against a single PostgreSQL database. Use Clerk for multi-tenant auth — it solves the hard problems (org management, invitations, JWT) without requiring you to build them. Enforce tenant isolation at the Prisma middleware layer so it's impossible to bypass with a missed if-check. Use BullMQ for all async work from day one. Build the admin console as a first-class surface, not an afterthought. Lay the analytics event table down in Phase 2 even though you won't query it heavily until Phase 5 — retrofitting event capture is painful.

### What to Avoid

- **Do not** build a REST API layer. tRPC + direct Next.js routes is sufficient and faster to develop.
- **Do not** use schema-per-tenant isolation. Row-level with Prisma middleware is correct for this scale.
- **Do not** let Codex create ad-hoc patterns. Every task packet must reference this document and extend established patterns.
- **Do not** store analytics in OLTP tables and query them directly in dashboards. The `AnalyticsEvent` table is the boundary.
- **Do not** build the admin console with a third-party tool (Retool, Adminjs). Custom is worth the investment given the impersonation and audit requirements.
- **Do not** skip the `AuditLog` or `JobRecord` tables to move faster. They are cheap to implement early and painful to add retroactively.

### What Should Happen Next Before Coding Begins

1. **Resolve open assumptions** (see section below)
2. **Confirm stack choices** — specifically Clerk vs. alternative, Vercel vs. alternative
3. **Create the Turborepo monorepo skeleton** (Phase 0) and confirm it deploys cleanly before any feature work
4. **Write the first task packet for Codex** covering Phase 0, linking to this document and specifying exact file structure
5. **Lock the `IntegrationAdapter` interface** as a TypeScript file in `packages/integrations` before any provider is implemented

---

## Open Questions to Resolve Before Implementation

1. **A3 — Tenant branding model:** Will tenants have subdomains (`venuename.pathfinderos.com`), a single public app with slug-based routing (`pathfinderos.com/venues/venuename`), or an embeddable widget? This affects Next.js routing strategy, middleware configuration, and how `tenant_id` is resolved on the public app.

2. **A7 — Billing integration:** Is Stripe (subscription billing) in scope for MVP or post-MVP? If post-MVP, the plan tier on `Tenant` is set manually by admin for now — that is fine, but it should be stated explicitly so Codex doesn't scaffold Stripe prematurely.

3. **Integration launch provider:** Which specific integration provider is the first one to implement in Phase 4? Having a confirmed first provider allows the adapter interface to be validated against a real API before it's declared canonical.

4. **Guest user auth:** Can end customers (public users) create accounts to manage their bookings across sessions, or are bookings lookup-only (via confirmation email/link)? This affects whether `GuestUser` needs a full auth flow or just an email-based lookup token.

5. **Admin team size:** Is the internal admin console single-user (you only) for the foreseeable future, or should it support inviting additional platform staff? This affects whether `PLATFORM_ADMIN` is a hard-coded single user or a manageable role.
