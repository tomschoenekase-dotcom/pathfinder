# PathFinderOS — B2B Platform Build Plan

> Implementation blueprint for evolving PathFinderOS from a single-admin prototype into a
> multi-tenant SaaS platform that venue companies can operate themselves.
>
> Written for use by Codex as a phased engineering guide.
> Status: Planning document — do not begin implementation until phases are confirmed.

---

## 1. Executive Summary

PathFinderOS began as an AI chatbot embedded in physical venues — helping guests navigate zoos,
botanical gardens, and similar attractions by answering questions, recommending nearby places, and
surfacing photo cards with directions. The core AI (RAG + embeddings), the admin backend, and the
lightweight visual layer (photo cards + native maps deep links) are already built and working.

The next phase converts this from a single-operator system into a multi-tenant SaaS platform with
two levels of user:

- **Platform Admin (you):** sees and controls everything across all tenants.
- **Company Admin (the venue/client):** manages only their own venues, places, analytics, and AI
  behavior settings.

The goal is a product that a real venue company can sign up for, configure their content, review
analytics about guest behavior, and make real-time operational adjustments — without requiring
your direct involvement in their day-to-day operations.

This document defines the architecture, data model, product screens, analytics design, AI
influence system, operational update system, implementation phases, and Codex task breakdown
needed to get there.

---

## 2. Product Architecture Overview

### 2.1 Shift from Single-Admin to Multi-Tenant

Today the system has one layer: you (the platform operator) manage everything. The new platform
introduces a clean separation between the platform layer and the tenant layer.

```
┌──────────────────────────────────────────┐
│          Platform Admin Console          │  (apps/admin — already scoped this way)
│  Manage tenants, view all venues,        │
│  monitor platform health, support ops    │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│         Company Admin Dashboard          │  (apps/dashboard — to be built/expanded)
│  Manage own venues, places, analytics,   │
│  AI controls, operational alerts         │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│            Guest Web App                 │  (apps/web — already exists)
│  Chat, place cards, directions           │
└──────────────────────────────────────────┘
```

Every piece of tenant data is scoped to a `tenant_id`. The tenant isolation Prisma middleware
already enforces this at the DB layer. The dashboard app surfaces only data belonging to the
authenticated tenant. The platform admin console has bypass access for support purposes.

### 2.2 Role Hierarchy

| Role | Scope | Access |
|------|-------|--------|
| `PLATFORM_ADMIN` | Entire platform | All tenants, all data, global settings |
| `OWNER` | One tenant | Full access to that tenant's data and settings |
| `MANAGER` | One tenant | Operational CRUD — cannot manage billing, cannot delete tenant |
| `STAFF` | One tenant | Read + limited operational actions (publish alerts, mark closures) |

A user may belong to multiple tenants (Clerk org membership). The active tenant for any request
is determined by the Clerk JWT org claim — never a URL param or request body field.

This maps to the existing `requireRole` / `requireTenantRole` system already in `packages/auth`.

---

## 3. Core Platform Modules

### Module 1 — Authentication and Authorization
- Clerk organizations = tenants (already wired)
- Role metadata on Clerk org membership (already wired)
- `requireAuth` → `requireTenant` → `requireRole` procedure chain (already wired)
- Dashboard middleware enforces org membership before any route renders
- Platform admin check (`PLATFORM_ADMIN` in Clerk public metadata) gates `apps/admin`

**New work:** Invitation flow — company admin can invite staff/manager users to their org from
within the dashboard. This wraps Clerk's invitation API.

### Module 2 — Tenant / Company Management
- Tenant record: company name, billing status, plan tier, active flag, created date
- Venue records are scoped to a tenant
- Platform admin can create tenants, suspend them, impersonate them
- Company admin can edit their own company profile (name, contact info, logo)

### Module 3 — Venue and Place Content Management
- Already exists in the admin backend; needs to be surfaced in the company dashboard
- Company admin sees only their own venues and places
- CRUD for venues and places with the same field set as today
- Bulk photo URL management
- Operational status per place (open / closed / modified hours / notice)

### Module 4 — Analytics and Event Tracking
- Capture guest interaction events (chat messages, card views, directions opens, session start/end)
- Store in `AnalyticsEvent` table (already defined in architecture) as append-only rows
- Roll up into `DailyRollup` for efficient dashboard queries
- Company dashboard surfaces: top asked-about places, popular categories, session counts,
  directions clicks, busiest hours, most-asked questions

### Module 5 — AI Influence and Control System
- Structured rules that shape how the AI ranks and surfaces places during RAG retrieval
- Three categories: Promotions (boost a place), Restrictions (suppress or block), Contextual
  Modifiers (time/weather/event conditions)
- Rules are tenant-scoped, have explicit priority levels, and can be time-bounded
- Applied at query time during the system prompt assembly step — not injected raw

### Module 6 — Operational Updates System
- Short-lived notices about real-world conditions: closures, crowding, events, weather guidance
- Company staff can create and publish these from the dashboard in under 30 seconds
- Notices have: scope (venue or specific place), severity, message, expiry time
- Active notices are injected into the AI context and shown as a banner in the guest web app
- Notices expire automatically; staff can manually deactivate

### Module 7 — Reporting and Dashboard Views
- Overview: session count, top places, total directions opens, AI query volume this week
- Places: per-place engagement table sorted by questions, card clicks, directions
- Conversations: sample recent sessions (anonymized), most-asked question phrases
- AI Controls: active promotions, active restrictions, pending operational updates
- Settings: venue profile, user/team management, API keys (future), billing (future)

### Module 8 — Audit Logs
- Every content change, role change, AI rule creation/deletion, and operational update writes to
  `AuditLog` via `writeAuditLog()`
- Audit log is append-only (enforced by architecture)
- Platform admin can view full audit history; company admin can view their own tenant's history

---

## 4. Multi-Tenant Data Model

This section defines the conceptual schema. Actual Prisma migrations follow the numbered
sequence in `implementation-plan.md` Section 5.

### 4.1 Companies / Tenants

```
Tenant {
  id            String    (Clerk org ID)
  name          String
  slug          String    (unique — used in public URLs like /forest-hall/chat)
  planTier      Enum      FREE | STARTER | PRO | ENTERPRISE
  status        Enum      ACTIVE | SUSPENDED | TRIAL
  createdAt     DateTime
  -- no updatedAt on tenant itself; changes go through AuditLog
}
```

### 4.2 Users

Clerk manages user identity and org membership. The local `User` table mirrors essential fields:

```
User {
  id            String    (Clerk user ID)
  email         String    (for display only — never logged or sent to analytics)
  tenantId      String?   (nullable — platform admin has no tenant)
  role          Enum      STAFF | MANAGER | OWNER
  createdAt     DateTime
}
```

A user can have multiple memberships (Clerk handles the multi-org state). The `User` row here
is per-tenant context, not a global identity record.

### 4.3 Venues

```
Venue {
  id            String    (cuid)
  tenantId      String    (FK → Tenant)
  name          String
  slug          String    (unique within tenant)
  description   String?
  address       String?
  lat           Float?
  lng           Float?
  timezone      String    (IANA tz string — important for scheduled rules)
  status        Enum      ACTIVE | INACTIVE | SETUP
  createdAt     DateTime
  updatedAt     DateTime
}
```

### 4.4 Places

```
Place {
  id            String
  tenantId      String    (FK → Tenant — redundant with venueId but required for isolation)
  venueId       String    (FK → Venue)
  name          String
  description   String?
  category      String?
  tags          String[]
  lat           Float?
  lng           Float?
  photoUrl      String?
  hours         String?
  isFeatured    Boolean   default false
  status        Enum      OPEN | CLOSED | MODIFIED | UNKNOWN
  statusNote    String?   (short override message, e.g. "Closed for maintenance today")
  embedding     vector(1536)?
  createdAt     DateTime
  updatedAt     DateTime
}
```

### 4.5 Analytics Events

```
AnalyticsEvent {
  id            String
  tenantId      String    (FK → Tenant)
  venueId       String    (FK → Venue)
  sessionId     String    (anonymous guest session UUID)
  eventType     String    (see Section 6.1 for enum)
  placeId       String?   (nullable — not all events are about a specific place)
  metadata      Json?     (structured payload — see Section 6)
  occurredAt    DateTime  (client time)
  receivedAt    DateTime  (server time)
  -- no updatedAt, no delete — append-only
}
```

### 4.6 AI Campaigns / Influence Rules

```
AIRule {
  id            String
  tenantId      String
  venueId       String?   (null = venue-wide)
  type          Enum      PROMOTION | RESTRICTION | CONTEXTUAL_MODIFIER | HARD_EXCLUSION
  subjectType   Enum      PLACE | CATEGORY | TAG | VENUE_WIDE
  subjectId     String?   (placeId, category string, or tag string)
  priority      Int       (1–10, higher = stronger influence)
  instruction   String    (structured prose, max 200 chars — see Section 7)
  conditions    Json?     (optional time/weather/event conditions — see Section 7.4)
  startsAt      DateTime?
  expiresAt     DateTime?
  isActive      Boolean   default true
  createdBy     String    (userId)
  createdAt     DateTime
  updatedAt     DateTime
}
```

### 4.7 Operational Updates

```
OperationalUpdate {
  id            String
  tenantId      String
  venueId       String
  placeId       String?   (null = venue-wide)
  severity      Enum      INFO | WARNING | CLOSURE | REDIRECT
  title         String    (short — shown as banner headline, max 60 chars)
  body          String?   (optional detail, max 300 chars)
  redirectTo    String?   (placeId or free-text suggestion if severity = REDIRECT)
  expiresAt     DateTime  (required — must set expiry on creation)
  isActive      Boolean   default true
  createdBy     String    (userId)
  createdAt     DateTime
  -- no updatedAt: deactivate and recreate instead of mutating active notices
}
```

### 4.8 Sessions

```
GuestSession {
  id            String    (UUID — set client-side, no PII)
  tenantId      String
  venueId       String
  startedAt     DateTime
  lastSeenAt    DateTime
  messageCount  Int       default 0
  -- never store IP, device fingerprint, or any PII
}
```

### 4.9 Daily Rollup

```
DailyRollup {
  id            String
  tenantId      String
  venueId       String
  date          DateTime  (date only — midnight UTC)
  metric        String    (e.g. 'sessions', 'messages', 'card_clicks', 'directions_opens')
  placeId       String?
  category      String?
  value         Int
  -- populated nightly by a worker job; never mutated — insert new row if correction needed
}
```

---

## 5. Company-Facing Dashboard Design

The dashboard is `apps/dashboard`. It authenticates via Clerk and resolves the active tenant from
the Clerk JWT org claim. All data is fetched via tRPC procedures in `packages/api`.

### 5.1 Navigation Structure

```
Dashboard
├── Overview
├── Venues
│   └── [venue] → Places
│       └── [place] → Edit Place
├── Analytics
│   ├── Overview
│   ├── Places
│   └── Conversations
├── AI Controls
│   ├── Promotions & Priorities
│   ├── Restrictions & Exclusions
│   └── Contextual Rules
├── Operational Updates
│   ├── Active Alerts
│   └── Create Alert
└── Settings
    ├── Company Profile
    ├── Team Members
    └── Billing (stub for now)
```

### 5.2 Screen Descriptions

**Overview Dashboard**
Key metrics for the last 7 days: total sessions, total messages sent to AI, directions clicks,
top 3 most-asked-about places. A "health" strip showing any active operational alerts and
any expiring AI rules.

**Venues / Places Management**
Table of venues. Drill into a venue to see its places list. Each place row shows: name, category,
status badge (OPEN/CLOSED/MODIFIED), last-updated date, quick-edit inline action.
Place edit form: all fields from the current admin system + status + statusNote + photoUrl.

**Analytics — Overview**
Session volume chart (7/30/90 day), messages per day, directions opens per day.
Top 10 places by questions asked. Top 5 categories by engagement.

**Analytics — Places**
Per-place table: questions asked, card views, directions opens, estimated avg dwell interest
(proxy via repeated mentions in sessions). Sortable. Exportable to CSV.

**Analytics — Conversations**
Most frequent question patterns (clustered by semantic similarity — aggregate, not individual
transcripts). Session count by hour of day (heat map). No PII, no individual session replay.

**AI Controls — Promotions & Priorities**
List of active promotion rules. Create/edit form: pick a place or category, write the
promotional instruction (guided by character limit and template hints), set optional time bounds,
set priority. Preview of how the rule will appear in the AI system prompt.

**AI Controls — Restrictions & Exclusions**
Same pattern for restriction and hard-exclusion rules. Exclusions show a clear warning that
the place will be entirely hidden from AI recommendations.

**Operational Updates**
Active alerts shown as a prioritized list with countdown timers to expiry. Create form: pick
venue/place, severity, title (60 char), optional body, expiry (presets: 1h, 4h, end of day,
custom). One-click deactivate on any active alert.

**Settings — Team Members**
List of users in the org with their roles. Invite by email (wraps Clerk invitation). Remove
user. Change role (OWNER only).

---

## 6. Analytics Design

### 6.1 Events to Capture

| Event Type | Trigger | Payload Fields |
|------------|---------|----------------|
| `session.started` | Guest opens chat page | venueId, sessionId, timestamp |
| `session.ended` | Page unload / 30-min idle | venueId, sessionId, durationSeconds (approx) |
| `message.sent` | Guest sends chat message | sessionId, messageLength, isFirstMessage |
| `message.received` | AI response returned | sessionId, responseMs, placeIdsReturned[] |
| `place_card.viewed` | Place card rendered in chat | sessionId, placeId |
| `place_card.clicked` | Guest taps a place card | sessionId, placeId |
| `directions.opened` | Guest taps Directions button | sessionId, placeId |
| `operational_update.viewed` | Active banner shown to guest | sessionId, updateId |

**What is NOT captured:** message content (the actual question text), user identity, IP address,
device type, or location coordinates from the guest device.

### 6.2 Metrics Derivable from Events

| Metric | Derived From |
|--------|-------------|
| Session count | COUNT DISTINCT sessionId per day |
| Avg messages per session | messages / sessions |
| Most-asked-about places | COUNT place_card.viewed grouped by placeId |
| Directions conversion rate | directions.opened / place_card.clicked |
| Busiest hours | session.started by hour of day |
| Avg session duration | session.ended.durationSeconds avg |
| Cold-start sessions | sessions with only 1 message |
| AI response latency | message.received.responseMs percentiles |

### 6.3 Dwell Time / Engagement Estimation

Do not claim to measure actual physical dwell time — the app has no location access.

Instead, use **session interaction depth** as a proxy for interest:
- A place mentioned or clicked 3+ times in one session = strong interest signal
- A place that drives a directions open = confirmed action intent
- A session with 8+ messages = high-engagement visit

Surface these in analytics as "high-interest places" and "action-intent rate" rather than
labeling them as dwell time, which would be misleading.

### 6.4 MVP vs Later Analytics

**MVP analytics (build now):**
- Session count, message count, directions opens — daily chart
- Top 10 places by card views
- Top 5 categories by engagement
- Active operational alerts summary

**V1.5 analytics:**
- Most-asked question patterns (semantic clustering of message text — requires NLP post-processing)
- Busiest hours heat map
- Per-place conversion funnel (card viewed → card clicked → directions opened)
- Week-over-week trend indicators

**Later / enterprise:**
- Cohort retention (do visitors return?)
- A/B testing for AI promotion rules
- Export to CSV / data warehouse integration
- Anomaly detection (sudden drop in a popular place)

### 6.5 Privacy and Interpretation Caveats

- No PII is stored. Session IDs are random UUIDs with no link to identity.
- "Most-asked-about" is a proxy for interest, not importance or revenue impact.
- Session count does not equal unique visitors — a single visitor could open multiple sessions.
- Message volumes spike when the AI gives a confusing answer. High volume is not purely positive.
- Warn operators of these caveats in the dashboard UI with brief tooltip text.

---

## 7. AI Influence / Control System Design

This system allows company admins to shape AI behavior in bounded, structured ways without
directly editing prompts or injecting arbitrary text.

### 7.1 Design Principles

1. **No raw prompt injection.** Companies never write directly into the system prompt.
2. **Bounded natural language.** Instruction fields are constrained by templates and character
   limits. The system assembles a controlled prompt segment from structured fields.
3. **Trust gradient.** Promotions and priority boosts are soft signals. Hard exclusions are hard.
   The AI still uses its judgment within those bounds.
4. **Expiry is mandatory for temporary rules.** Permanent rules require explicit confirmation.
5. **Transparency.** Company admin can always see exactly what rules are active and preview how
   they translate to AI context.

### 7.2 Rule Types

**PROMOTION**
Boosts a place, category, or tag in AI ranking and encourages mention when relevant.
Example instruction: "Highlight our new ice cream stand — mention it when guests are near the
east section or asking about food."
- Cannot claim false facts about the place
- Cannot suppress competitor places (that requires a RESTRICTION rule separately)
- Priority 1–10: 10 = strong recommendation bias, 1 = mild preference

**RESTRICTION**
Reduces likelihood of the AI recommending a place or category. Does not fully exclude.
Example: "Deprioritize the east parking lot area — it is crowded this weekend."
- Used for temporary soft suppression
- AI may still mention if directly asked by name

**HARD_EXCLUSION**
Completely removes a place from AI responses. The place will not be recommended or mentioned.
Example: "Do not mention the construction zone near the north entrance."
- Use sparingly — a hard exclusion on a place the guest explicitly asks about will result in
  the AI saying it doesn't have information about it, which may confuse guests.
- Requires MANAGER or OWNER role to create.

**CONTEXTUAL_MODIFIER**
A rule that only activates under specific conditions (time of day, day of week, weather flag,
active event).
Example: "If weather is bad, favor indoor attractions in all recommendations."
- Conditions are structured fields (see Section 7.4), not free text.
- The system evaluates the condition at query time before injecting the rule.

### 7.3 How Rules Are Applied at Query Time

At the start of every chat message processing:

1. Query all active `AIRule` records for the venue (cached with a 60-second TTL in Redis).
2. Evaluate conditions on CONTEXTUAL_MODIFIER rules — drop any that don't match current context.
3. Sort remaining rules by priority descending.
4. Assemble a structured "AI guidance" block from the rules:

```
--- Venue Guidance ---
[PROMOTION P:9] Ice cream stand: Highlight our new ice cream stand — mention it when guests
are near the east section or asking about food.
[RESTRICTION P:6] East parking lot: Deprioritize — crowded this weekend.
[EXCLUSION] Construction zone north entrance: Do not mention.
--- End Guidance ---
```

5. Inject this block into the system prompt after the venue context and before the guest's
   message. Cap at 800 tokens regardless of number of rules (truncate lower-priority rules first).

### 7.4 Condition Fields for Contextual Modifiers

```json
{
  "timeOfDay": { "from": "08:00", "to": "12:00" },
  "daysOfWeek": ["saturday", "sunday"],
  "weatherFlag": "rain",
  "activeEventId": "event_abc123"
}
```

- `timeOfDay` and `daysOfWeek` are evaluated against the venue's configured timezone.
- `weatherFlag` requires a weather integration or a manual "weather override" toggle in the
  dashboard (MVP: manual toggle; V1.5: automated via weather API).
- `activeEventId` links to a future Event table (not MVP).

### 7.5 Company Admin UI for Creating Rules

A guided form with:
- Subject picker: select venue-wide, category, or specific place
- Rule type selector with explanatory tooltip for each type
- Instruction textarea: max 200 chars, live preview of how it renders in the AI block
- Priority slider (1–10) with label hints ("subtle nudge" → "strong preference")
- Condition builder: optional, collapsible section
- Date/time range pickers for start/expiry
- Preview panel showing the assembled AI guidance block
- Confirm step for HARD_EXCLUSION type (requires typing "CONFIRM")

### 7.6 Safety Constraints

- No rule may claim factual information about a place that contradicts its stored data.
- Instructions are sanitized: no HTML, no prompt-injection patterns (strip delimiter characters).
- Maximum 20 active rules per venue (prevents prompt bloat and gaming).
- Platform admin can view and override any tenant's rules.
- Any rule modification is logged to AuditLog.

---

## 8. Operational Updates System

Operational updates are short-lived, real-world notices about conditions that affect guest
routing right now. They are separate from AI influence rules because they are reactive
(something just happened) rather than strategic (we want to promote X for a month).

### 8.1 Design Goals

- A staff member should be able to publish a closure notice in under 30 seconds.
- Updates expire automatically — no stale notices left on indefinitely.
- The AI must consume these as hard facts, not suggestions.
- The guest web app must surface active notices as visible UI, not just AI behavior changes.

### 8.2 Severity Levels

| Severity | Meaning | AI Treatment |
|----------|---------|-------------|
| INFO | General notice (event starting soon, tip) | Added to context as advisory |
| WARNING | Degraded condition (reduced hours, limited access) | AI notes the condition when relevant |
| CLOSURE | Place or area fully closed | AI will not route guests there; says it's closed if asked |
| REDIRECT | Closed + send guests somewhere else | AI proactively suggests the redirect target |

### 8.3 Active Notice Injection

At query time, after loading AI rules:

1. Load all active, non-expired `OperationalUpdate` records for the venue.
2. Format as a structured block:

```
--- Active Conditions ---
[CLOSURE] Reptile House: Closed for cleaning until 3 PM today.
[REDIRECT] North food stand → South Café: North food stand closed all day; direct guests to
South Café near the main fountain.
[WARNING] East trail: Muddy conditions — advise appropriate footwear.
--- End Conditions ---
```

3. Inject after the AI guidance block, before the guest message.
4. For CLOSURE and REDIRECT — mark affected placeIds as excluded from RAG results before
   semantic search runs (not just a prompt note — actually exclude from the retrieval step).

### 8.4 Guest Web App Surface

- A dismissible banner at the top of the chat page shows: title of highest-severity active alert.
- If multiple alerts active: "X active venue alerts" with an expand option.
- Banner updates in real-time via a lightweight polling endpoint (every 60 seconds).

### 8.5 Expiry and Lifecycle

- Expiry is required on creation. Minimum 15 minutes, maximum 7 days.
- Quick presets: 1 hour, 4 hours, end of today (midnight in venue timezone), custom.
- System auto-deactivates at `expiresAt`. No cron needed if checked at query time — but a
  cleanup worker should run nightly to set `isActive = false` on expired rows.
- Staff can manually deactivate any active update at any time.
- Updates are never mutated after creation. To extend: deactivate the old one, create a new one.
  This preserves the audit trail.

### 8.6 Roles

- `STAFF` can create INFO and WARNING updates.
- `MANAGER` can create any severity including CLOSURE and REDIRECT.
- `OWNER` can deactivate any update regardless of who created it.

---

## 9. Implementation Phases

### Phase 1 — Tenant Foundation Hardening
**Objective:** Ensure the existing multi-tenant data layer is production-ready before building
any new surfaces on top of it.

**Why it matters:** Everything in subsequent phases depends on reliable tenant isolation. Any
gaps here are security vulnerabilities that become harder to close later.

**Deliverables:**
- Tenant isolation middleware at 100% branch coverage (CI gate)
- Auth guards (`requireAuth`, `requireTenant`, `requireRole`) tested across all existing routers
- `session.ts` fully implemented and tested in `packages/auth`
- All existing routers using `tenantProcedure` where applicable
- Migration 007: confirm `tenant_id` on all tenanted tables

**Dependencies:** Migrations 001–006 already applied.
**Acceptance criteria:** `turbo run test` passes with zero failures; tenant isolation middleware
coverage report shows 100% branch coverage.

---

### Phase 2 — Company Dashboard Shell
**Objective:** Stand up the `apps/dashboard` Next.js app with auth, routing, and a functional
navigation shell. No real data yet — placeholder views are fine.

**Why it matters:** Establishes the deployment and auth boundary for all company-facing work.

**Deliverables:**
- `apps/dashboard` Next.js 15 App Router app created
- Clerk auth middleware protecting all routes
- Navigation shell matching Section 5.1 structure
- Active tenant resolved from Clerk org claim on every request
- Placeholder pages for all nav items
- Deployed to staging environment

**Dependencies:** Phase 1 complete.
**Acceptance criteria:** A Clerk org member can sign in, see the correct tenant resolved, navigate
all sections without errors. A non-org-member cannot access any protected page.

---

### Phase 3 — Content Management (Venues and Places)
**Objective:** Port the existing admin content management experience into the company dashboard,
scoped to the authenticated tenant's data only.

**Why it matters:** This is the first real business value for the company admin — they can manage
their own content without needing your involvement.

**Deliverables:**
- Venues list and edit pages in `apps/dashboard`
- Places list and edit pages per venue
- All tRPC procedures already in `packages/api/src/routers/venue.ts` and `place.ts` reused
  (no new procedures needed — just new UI calling existing procedures)
- Place status field (OPEN/CLOSED/MODIFIED/UNKNOWN) and statusNote added via migration 008
- Photo URL management in place edit form
- Embedding regeneration triggered on place save

**Dependencies:** Phase 2 complete; migration 007 applied.
**Acceptance criteria:** A MANAGER-role user can create, edit, and update places for their venue.
A STAFF-role user sees places but cannot delete them. A user from a different tenant cannot
access this venue's data (verified by test).

---

### Phase 4 — Operational Updates System
**Objective:** Build the full operational update system — creation, active notice injection into
AI context, and guest web app banner.

**Why it matters:** This is the highest-urgency real-world need for venue operators. A closure
notice that doesn't reach the AI or the guest immediately is a product failure.

**Deliverables:**
- Migration 009: `OperationalUpdate` table
- tRPC procedures: `operationalUpdate.create`, `operationalUpdate.list`, `operationalUpdate.deactivate`
- Dashboard UI: Operational Updates section (active list + create form)
- Chat router updated to load and inject active notices into AI system prompt
- RAG retrieval step excludes CLOSURE and REDIRECT places from semantic search results
- Guest web app banner showing highest-severity active alert
- Worker job: nightly cleanup of expired updates (sets `isActive = false`)
- Role enforcement: STAFF limited to INFO/WARNING; MANAGER can create CLOSURE/REDIRECT

**Dependencies:** Phase 3 complete.
**Acceptance criteria:**
- Create a CLOSURE notice → AI stops routing guests to that place within 60 seconds.
- Notice auto-expires at `expiresAt` time.
- STAFF user cannot create a CLOSURE notice (returns FORBIDDEN).
- Banner visible in guest web app within 60 seconds of creation.

---

### Phase 5 — Analytics Event Capture
**Objective:** Instrument the guest web app and chat router to emit analytics events. Build the
backend storage and daily rollup worker.

**Why it matters:** Without event data flowing, the analytics dashboard in Phase 6 has nothing
to show. Capture must start early so operators have data by the time the dashboard ships.

**Deliverables:**
- Migration 010: `AnalyticsEvent` table, `GuestSession` table, `DailyRollup` table
- `packages/analytics/src/events.ts` updated with all event types from Section 6.1
- Chat router emits: `message.sent`, `message.received`, `place_card.viewed`
- Guest web app emits (via tRPC mutation, not direct DB call): `session.started`,
  `session.ended`, `place_card.clicked`, `directions.opened`
- Daily rollup worker job: aggregates previous day's events into `DailyRollup` rows, runs at
  1 AM venue-local time
- `emitEvent()` failures are swallowed and logged — never surface to guest or fail the chat

**Dependencies:** Phase 3 complete.
**Acceptance criteria:**
- Send a chat message → `message.sent` and `message.received` rows appear in `AnalyticsEvent`.
- Click Directions → `directions.opened` row appears.
- Daily rollup job runs → `DailyRollup` rows exist for the previous day.
- No analytics failure causes a 500 in the chat flow.

---

### Phase 6 — Analytics Dashboard
**Objective:** Build the analytics views in the company dashboard using `DailyRollup` data.

**Why it matters:** This is the first place company admins can see that the product is generating
value for them. It is a retention driver and a key moment in the sales demo.

**Deliverables:**
- tRPC procedures: `analytics.overview`, `analytics.placeBreakdown`, `analytics.sessionTrend`
  (all query `DailyRollup`, never OLTP tables)
- Dashboard Analytics Overview page: session chart, message count, directions opens, top places
- Dashboard Analytics Places page: per-place engagement table, sortable
- Analytics procedures enforce tenant scope (standard `tenantProcedure`)

**Dependencies:** Phase 5 complete with at least 2 days of event data.
**Acceptance criteria:**
- Overview shows correct session count matching event table for the test tenant.
- A user from Tenant A cannot see Tenant B's analytics (verified by test).
- All queries use `DailyRollup`, not raw `AnalyticsEvent` table scans.

---

### Phase 7 — AI Influence / Control System
**Objective:** Build the AI rule system — creation UI, rule storage, and injection into the chat
prompt pipeline.

**Why it matters:** This is a key differentiator. Venue operators need a way to keep the AI
aligned with real-world business priorities without requiring developer involvement.

**Deliverables:**
- Migration 011: `AIRule` table
- tRPC procedures: `aiRule.create`, `aiRule.list`, `aiRule.update`, `aiRule.delete`
- Dashboard AI Controls section: promotions list, restrictions list, exclusions list, create form
- Chat router updated to load active rules, evaluate conditions, assemble guidance block,
  inject into system prompt
- Redis caching of active rules per venue (60-second TTL)
- Rule count enforcement (max 20 active rules per venue)
- Input sanitization on instruction field
- All rule changes logged to AuditLog

**Dependencies:** Phase 5 complete (Redis already in use for session caching).
**Acceptance criteria:**
- Create a PROMOTION rule for a place → that place appears more prominently in AI response for
  a relevant guest question.
- Create a HARD_EXCLUSION → place does not appear in AI response even when directly relevant.
- Instruction field rejects HTML and prompt-delimiter characters.
- AuditLog row written on every rule create/update/delete.

---

### Phase 8 — Team Management and Invitations
**Objective:** Let company admins manage their own team without needing platform admin involvement.

**Why it matters:** A venue company needs to be able to add and remove staff independently.

**Deliverables:**
- Dashboard Settings → Team Members page
- List org members with roles (read from Clerk org membership)
- Invite user by email (wraps Clerk invitation API via `packages/auth`)
- Change role (OWNER only — wraps Clerk org membership update)
- Remove user (OWNER only)
- Invite and role-change actions logged to AuditLog

**Dependencies:** Phase 2 complete.
**Acceptance criteria:**
- OWNER sends invitation → invited user receives Clerk invitation email.
- MANAGER cannot change roles or remove users (returns FORBIDDEN).
- Role change reflected on next request from that user.

---

## 10. Codex Task Breakdown

Tasks are ordered within each phase. Each task should be a self-contained unit of work.

### Phase 1 Tasks

| Task | Description |
|------|-------------|
| P1-T1 | Audit all existing tRPC procedures — confirm each uses the correct base procedure type; fix any that use `publicProcedure` where `tenantProcedure` is required |
| P1-T2 | Write missing forbidden-path tests for any procedure that lacks one |
| P1-T3 | Bring tenant isolation middleware to 100% branch coverage; add CI gate |
| P1-T4 | Verify `session.ts` in `packages/auth` handles all edge cases; fill gaps |

### Phase 2 Tasks

| Task | Description |
|------|-------------|
| P2-T1 | Scaffold `apps/dashboard` Next.js 15 app with Clerk auth middleware |
| P2-T2 | Build navigation shell and layout component |
| P2-T3 | Implement active tenant resolution from Clerk JWT in tRPC context for dashboard |
| P2-T4 | Add placeholder pages for all nav sections |
| P2-T5 | Configure deployment pipeline for `apps/dashboard` |

### Phase 3 Tasks

| Task | Description |
|------|-------------|
| P3-T1 | Write migration 008: add `status` and `statusNote` fields to `places` table |
| P3-T2 | Update `packages/api/src/routers/place.ts` — add status fields to input schemas and responses |
| P3-T3 | Build Venues list page in dashboard |
| P3-T4 | Build Places list page (per venue) in dashboard |
| P3-T5 | Build Place edit form with all fields including status and photo URL |
| P3-T6 | Wire embedding regeneration on place save (already exists — confirm it runs from dashboard) |

### Phase 4 Tasks

| Task | Description |
|------|-------------|
| P4-T1 | Write migration 009: `OperationalUpdate` table |
| P4-T2 | Add `OperationalUpdate` to tenant isolation middleware list |
| P4-T3 | Write tRPC procedures: `operationalUpdate.create`, `list`, `deactivate` with role enforcement |
| P4-T4 | Write tests: forbidden path (STAFF creating CLOSURE), expiry behavior |
| P4-T5 | Update chat router: load active notices, inject into system prompt, exclude CLOSURE places from RAG |
| P4-T6 | Build Operational Updates dashboard pages (active list + create form) |
| P4-T7 | Build guest web app active alert banner |
| P4-T8 | Write nightly cleanup worker job for expired updates |

### Phase 5 Tasks

| Task | Description |
|------|-------------|
| P5-T1 | Write migration 010: `AnalyticsEvent`, `GuestSession`, `DailyRollup` tables |
| P5-T2 | Register event types in `packages/analytics/src/events.ts` |
| P5-T3 | Instrument chat router to emit `message.sent` and `message.received` |
| P5-T4 | Add `session.started` / `session.ended` tracking in guest web app (via tRPC mutation) |
| P5-T5 | Add `place_card.clicked` and `directions.opened` tracking in `PlaceCard` component |
| P5-T6 | Wrap all `emitEvent()` calls in try/catch — confirm no analytics failure surfaces to user |
| P5-T7 | Write daily rollup worker job |

### Phase 6 Tasks

| Task | Description |
|------|-------------|
| P6-T1 | Write tRPC procedures: `analytics.overview`, `analytics.placeBreakdown`, `analytics.sessionTrend` using `DailyRollup` |
| P6-T2 | Write forbidden-path tests for all analytics procedures |
| P6-T3 | Build Analytics Overview page in dashboard |
| P6-T4 | Build Analytics Places breakdown page |

### Phase 7 Tasks

| Task | Description |
|------|-------------|
| P7-T1 | Write migration 011: `AIRule` table |
| P7-T2 | Add `AIRule` to tenant isolation middleware list |
| P7-T3 | Write tRPC procedures: `aiRule.create`, `list`, `update`, `delete` |
| P7-T4 | Write rule count enforcement (max 20 active per venue) and input sanitization |
| P7-T5 | Write tests: forbidden paths, max rule enforcement, sanitization |
| P7-T6 | Update chat router: load rules, evaluate conditions, assemble guidance block, inject into prompt |
| P7-T7 | Add Redis caching for active rules per venue (60s TTL) |
| P7-T8 | Build AI Controls dashboard pages (promotions, restrictions, exclusions, create form) |
| P7-T9 | Log all rule changes to AuditLog |

### Phase 8 Tasks

| Task | Description |
|------|-------------|
| P8-T1 | Build Team Members page in dashboard Settings |
| P8-T2 | Implement invite user (Clerk invitation API via `packages/auth`) |
| P8-T3 | Implement change role and remove user (OWNER only) |
| P8-T4 | Log team changes to AuditLog |

---

## 11. Risks and Pitfalls

**Tenant permission complexity creep**
The role system (STAFF/MANAGER/OWNER) is simple by design. Resist adding custom per-venue
permission overrides or field-level role controls. If operators ask for this, it belongs in a
V2 feature with careful design — not a quick hack.

**Analytics noise from bots and testing**
Without filtering, your own testing sessions will appear in operator analytics. Early on this
is tolerable; by V1.5, add a mechanism to mark sessions as internal (e.g., a dev flag in the
session start payload that operators can set).

**AI over-steering by overzealous operators**
A company that creates 20 HARD_EXCLUSIONs will make their chatbot useless. Enforce the 20-rule
cap and add a dashboard warning when more than 10 rules are active. Consider limiting hard
exclusions to 5 per venue.

**Stale operational updates**
Operators will forget to deactivate updates. The mandatory expiry field mitigates this but does
not eliminate it. Add a dashboard warning for notices older than 6 hours that were not set to
auto-expire within that window.

**Multi-tenant data leakage in analytics queries**
Analytics queries against `DailyRollup` must always include `tenant_id` in the WHERE clause.
The tenant isolation middleware does not cover raw aggregate queries — write explicit tests that
confirm Tenant A's analytics queries cannot return Tenant B's rows.

**"Time spent" fake precision**
Never display a "average dwell time" metric based on session duration. Session duration measures
how long the app was open, not physical dwell time. This would mislead operators into making
wrong decisions. Use the interaction-depth proxy described in Section 6.3 and label it clearly.

**Too much enterprise architecture too early**
The temptation will be to build a feature-flag system, a billing engine, a white-label theme
system, and SAML SSO in Phase 1. Resist. None of those are needed to get the first 5 paying
customers. Keep scope tight until you have operators using the product.

**Embedding regeneration cost at scale**
Regenerating OpenAI embeddings on every place save is fine for small venues. At 10,000+ places
it becomes slow and expensive. Add a dirty flag to places and a batch re-embedding worker
before you scale to large venues. Not needed for MVP.

**Worker crash on a bad AI rule**
If the condition evaluation logic in the chat router throws on a malformed `conditions` JSON
field, the entire chat request fails. Add defensive parsing around the conditions block with a
fallback that ignores malformed rules and logs a warning rather than crashing.

---

## 12. MVP vs Later-Stage Features

### MVP (Build Now — Phases 1–4)

- Tenant isolation hardened and tested
- Company dashboard shell with auth
- Content management: venues and places (edit, status, photos)
- Operational updates system (create, publish, expire, inject into AI)
- Guest web app operational alert banner
- Basic team management (invite, remove, role change)

### V1.5 (Next Phase — After First Paying Customers)

- Analytics event capture (Phase 5)
- Analytics dashboard (Phase 6)
- AI influence / control system (Phase 7)
- Automated operational update expiry cleanup worker
- Most-asked question patterns (semantic clustering)
- Busiest hours heat map
- Per-place conversion funnel view

### Later / Enterprise

- Weather API integration for automatic contextual rule activation
- Event scheduling (tie AI rules to calendar events)
- White-label chat embed (custom colors, logo, domain)
- SAML SSO / custom identity provider
- Billing engine (Stripe integration, plan enforcement)
- Data export / warehouse integration (CSV, webhook to Segment)
- A/B testing for AI promotion rules
- Multi-venue analytics rollup for companies with many locations
- Impersonation session full audit replay for platform support
- Anomaly detection alerts (sudden drop in engagement)

---

## Recommended First Build Order

This is the exact sequence to hand to Codex:

**1. P1-T1 through P1-T4 — Harden the foundation.**
Before building anything new, make sure the existing auth and tenant isolation code is airtight
and fully tested. This prevents you from building a dashboard on top of a leaky layer.

**2. P2-T1 through P2-T5 — Dashboard shell.**
Get a working, deployed, auth-gated dashboard app. Even empty, this establishes the deployment
boundary and unblocks all subsequent dashboard work.

**3. P3-T1 through P3-T6 — Content management.**
This is the first thing a real venue company needs. They need to be able to manage their own
places. Port the existing admin UX into the scoped dashboard experience.

**4. P4-T1 through P4-T8 — Operational updates.**
This is the highest-value immediate feature. A venue that can publish "Reptile House closed until
3 PM" directly to the AI without calling you is a venue that will pay for this product.

**5. P8-T1 through P8-T4 — Team management.**
Once content management and operational updates work, the company admin needs to add staff.
This completes the MVP loop: sign up → add venues/places → manage operations → invite team.

**Start Phase 5 (analytics capture) in parallel with Phase 8** if capacity allows — events
need to be flowing while operators start using the product, so the analytics dashboard has
real data when you build Phase 6.

**Do not start Phase 7 (AI controls) until Phases 5 and 6 are complete.** The AI influence
system is a higher-risk feature that requires operator trust built through content management and
analytics first. Rushing it risks prompt quality degradation before you have the data to detect it.
