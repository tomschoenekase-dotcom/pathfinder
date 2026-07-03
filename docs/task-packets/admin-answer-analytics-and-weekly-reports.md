# Task Packet: Visitor Answer Capture, Admin Chatlog Review, AI Analysis, and Weekly Reports

## Product spec (confirmed with stakeholder before this packet was written)

This extends the already-shipped engagement-questions feature
([engagement-questions.md](./engagement-questions.md),
[curious-mode-ai-invented-questions.md](./curious-mode-ai-invented-questions.md)). The AI
guide already asks configured (or, in Curious mode, invented) conversational questions —
schema, CRUD, the per-turn gate, and prompt injection all exist today. **This packet does
not touch that selection logic.** It picks up exactly where that feature stops: right now
a visitor's answer to an asked question is never captured anywhere — it's just an ordinary
`Message` row indistinguishable from any other reply. This packet:

1. Captures and stores visitor answers to AI-asked questions, correctly attributed.
2. Adds an admin-only chatlog review surface (browse sessions by venue/date, read full
   transcripts, see captured answers, flag conversations as notable, add private notes).
3. Adds an admin-only AI analysis feature over captured answers.
4. Adds an admin weekly report builder: generate a draft, edit it, save it, publish it.
5. Adds a client-facing "Weekly Reports" section on the tenant dashboard showing only
   published reports.

### Corrections to the originating brief

The brief this packet is based on assumed a green field. Two things already exist in this
codebase that change the plan:

- **`apps/admin` is not a deployed app.** Per `docs/codebase-overview.md`, the platform-admin
  console is built but not deployed — today it lives inside `apps/dashboard` at the
  `(admin)` route group (`apps/dashboard/app/(admin)/admin/...`), gated by `adminProcedure`
  / `platform_role === 'PLATFORM_ADMIN'`. All "admin-only" UI in this packet goes there, not
  in a new `apps/admin` app.
- **A `WeeklyDigest` system already exists and is being retired by this packet.** It's a
  tenant-wide (not venue-scoped) automated digest: a worker job
  (`apps/workers/src/processors/weekly-digest.ts`) calls Claude and writes insight cards
  straight into the `WeeklyDigest` table, and `analytics.getLatestDigest` /
  `listDigests` / `getDigest` exposed it directly to the tenant dashboard via
  `tenantProcedure` — fully automated, no admin review, no publish gate. Per stakeholder
  (confirmed): this panel is broken and needs an overhaul, not to be kept side-by-side with
  the new gated report. **Part 8** below removes the `WeeklyDigest` panel from the client
  dashboard and replaces it with the new published-reports section. The `WeeklyDigest`
  table, queue, and worker processor are left in the schema/codebase untouched (forward-only
  migrations — dropping them is a separate, explicit follow-up if desired), they are simply
  no longer surfaced to clients. The new weekly report pipeline reuses the good part of that
  processor's shape (a single constrained-JSON Claude call, zod-validated, `JobRecord`
  tracked) but is a new queue/table, venue-scoped, with a draft/edit/publish lifecycle.

### Product decisions (confirmed)

- No survey-bubble/card UI. Only conversational answers, captured from ordinary chat
  messages.
- Feedback/analytics data (raw chatlogs, raw answers, AI analysis, admin notes, report
  drafts) is admin-only. Clients only ever see **published** weekly reports.
- The mechanism for knowing "was this user message actually answering an AI-asked
  question" cannot rely on the model always complying with the soft
  natural-opening instruction it's already given (see `venue-context.ts`
  `engagementQuestionSection` — asking is discretionary, never guaranteed). So this packet
  adds a self-reported sentinel the model emits **only when it actually asked** this turn,
  which the backend strips before the guest ever sees it, and uses to mark the session
  as awaiting an answer. This is the "simple mechanism to track the last asked analytics
  question for the session" the brief asked for, in the cleanest form that fits the existing
  per-turn gate/discretion design.
- Weekly reports are **venue-scoped** (the brief's example — "Amp Up" — is a single venue),
  not tenant-scoped like the old `WeeklyDigest`. A tenant with multiple venues gets one
  report per venue per week.
- Report generation is a background job (`packages/jobs` + `apps/workers` processor), not a
  synchronous tRPC call — per `CLAUDE.md`, external LLM work in a mutation must be enqueued
  and return promptly. This matches how `WeeklyDigest` already works.

Run `pnpm install && pnpm typecheck && pnpm lint && pnpm test` from the repo root before
marking done.

---

## Part 1 — Schema: `packages/db/prisma/schema.prisma`

### 1a — New enums

Add near the existing `EngagementQuestionType` / `TenantEngagementMode` block:

```prisma
enum WeeklyReportStatus {
  GENERATING
  DRAFT
  PUBLISHED
  FAILED
}

enum AnswerAnalysisStatus {
  GENERATING
  COMPLETE
  FAILED
}
```

`EngagementQuestionResponse.answerType` reuses the existing `EngagementQuestionType` enum —
no new enum needed there.

### 1b — Extend `VisitorSession`

Add the pending-answer tracking fields and the notable flag (after `messageCount`):

```prisma
model VisitorSession {
  id             String    @id @default(cuid())
  tenantId       String    @map("tenant_id")
  venueId        String    @map("venue_id")
  anonymousToken String    @unique @map("anonymous_token")
  visitorId      String?   @map("visitor_id")
  latestLat      Float?    @map("latest_lat")
  latestLng      Float?    @map("latest_lng")
  startedAt      DateTime  @default(now()) @map("started_at")
  lastActiveAt   DateTime  @default(now()) @map("last_active_at")
  messageCount   Int       @default(0) @map("message_count")
  // Set when the AI self-reports (via the [[ENGAGEMENT_ASKED]] sentinel, stripped before
  // the guest sees it) that it actually asked an engagement question this turn. The NEXT
  // user message in this session is captured as the answer, then these are cleared. See
  // chat.ts Part 2.
  pendingEngagementQuestionId  String?   @map("pending_engagement_question_id")
  pendingEngagementIsInvented  Boolean   @default(false) @map("pending_engagement_is_invented")
  pendingEngagementAskedMessageId String? @map("pending_engagement_asked_message_id")
  pendingEngagementAskedAt     DateTime? @map("pending_engagement_asked_at")
  // Admin-only: flagged during chatlog review as worth a closer look / including in a report.
  isNotable      Boolean   @default(false) @map("is_notable")
  venue          Venue     @relation(fields: [venueId], references: [id], onDelete: Restrict)
  messages       Message[]
  engagementResponses EngagementQuestionResponse[]
  adminNotes     AdminChatlogNote[]

  @@index([tenantId])
  @@index([venueId])
  @@index([anonymousToken])
  @@index([visitorId])
  @@index([tenantId, venueId, startedAt])
  @@map("visitor_sessions")
}
```

(The new `@@index([tenantId, venueId, startedAt])` is for the admin chatlog date-range
browse query in Part 4.)

### 1c — New model: `EngagementQuestionResponse`

```prisma
model EngagementQuestionResponse {
  id                   String                 @id @default(cuid())
  tenantId             String                 @map("tenant_id")
  venueId              String                 @map("venue_id")
  sessionId            String                 @map("session_id")
  engagementQuestionId String?                @map("engagement_question_id")
  isAiInvented         Boolean                @default(false) @map("is_ai_invented")
  answerType           EngagementQuestionType @map("answer_type")
  // Denormalized so history survives if the authored question is later edited/deleted,
  // and so invented questions (which have no EngagementQuestion row) still show what was
  // asked.
  questionText         String                 @map("question_text")
  askedMessageId        String                @map("asked_message_id")
  answerMessageId       String                @map("answer_message_id")
  answerText            String                 @map("answer_text")
  askedAt               DateTime               @map("asked_at")
  answeredAt             DateTime               @map("answered_at")
  // Populated later by analysis, not on write. Out of scope for this packet to compute
  // per-row; the venue-level AI analysis in Part 5 derives sentiment/category in aggregate.
  sentimentLabel        String?                @map("sentiment_label")
  category               String?
  createdAt              DateTime               @default(now()) @map("created_at")
  tenant                 Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  venue                  Venue                  @relation(fields: [venueId], references: [id], onDelete: Restrict)
  session                VisitorSession         @relation(fields: [sessionId], references: [id], onDelete: Restrict)
  // SetNull (not Restrict) is deliberate: EngagementQuestion.delete does a hard delete
  // today (see engagement-question.ts router), and historical answers must survive that —
  // questionText already carries the denormalized copy.
  engagementQuestion     EngagementQuestion?    @relation(fields: [engagementQuestionId], references: [id], onDelete: SetNull)

  @@index([tenantId, venueId, answeredAt])
  @@index([engagementQuestionId])
  @@index([sessionId])
  @@map("engagement_question_responses")
}
```

Add the inverse relation to `EngagementQuestion`:

```prisma
model EngagementQuestion {
  // ...existing fields...
  responses     EngagementQuestionResponse[]
}
```

### 1d — New model: `AdminChatlogNote`

```prisma
model AdminChatlogNote {
  id        String         @id @default(cuid())
  tenantId  String         @map("tenant_id")
  venueId   String         @map("venue_id")
  sessionId String         @map("session_id")
  authorId  String         @map("author_id")
  note      String
  createdAt DateTime       @default(now()) @map("created_at")
  tenant    Tenant         @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  venue     Venue          @relation(fields: [venueId], references: [id], onDelete: Restrict)
  session   VisitorSession @relation(fields: [sessionId], references: [id], onDelete: Restrict)

  @@index([tenantId, sessionId])
  @@index([venueId, createdAt])
  @@map("admin_chatlog_notes")
}
```

### 1e — New model: `WeeklyReport`

```prisma
model WeeklyReport {
  id           String             @id @default(cuid())
  tenantId     String             @map("tenant_id")
  venueId      String             @map("venue_id")
  weekStart    DateTime           @map("week_start")
  weekEnd      DateTime           @map("week_end")
  status       WeeklyReportStatus @default(GENERATING)
  title        String             @default("PathFinder Weekly Report")
  // Final polished plain text, editable by the admin. Null until generation completes.
  content      String?
  answerCount  Int                @default(0) @map("answer_count")
  sessionCount Int                @default(0) @map("session_count")
  error        String?
  generatedAt  DateTime?          @map("generated_at")
  publishedAt  DateTime?          @map("published_at")
  createdBy    String             @map("created_by")
  createdAt    DateTime           @default(now()) @map("created_at")
  updatedAt    DateTime           @updatedAt @map("updated_at")
  tenant       Tenant             @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  venue        Venue              @relation(fields: [venueId], references: [id], onDelete: Restrict)

  @@unique([venueId, weekStart])
  @@index([tenantId, venueId, weekStart])
  @@index([status])
  @@map("weekly_reports")
}
```

### 1f — New model: `AnswerAnalysisSnapshot`

```prisma
model AnswerAnalysisSnapshot {
  id          String                @id @default(cuid())
  tenantId    String                @map("tenant_id")
  venueId     String                @map("venue_id")
  rangeStart  DateTime              @map("range_start")
  rangeEnd    DateTime              @map("range_end")
  status      AnswerAnalysisStatus  @default(GENERATING)
  // Structured result — see the `AnswerAnalysisSummary` shape in Part 5.
  summary     Json?
  answerCount Int                   @default(0) @map("answer_count")
  error       String?
  generatedAt DateTime?             @map("generated_at")
  createdBy   String                @map("created_by")
  createdAt   DateTime              @default(now()) @map("created_at")
  tenant      Tenant                @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  venue       Venue                 @relation(fields: [venueId], references: [id], onDelete: Restrict)

  @@index([tenantId, venueId, createdAt])
  @@map("answer_analysis_snapshots")
}
```

### 1g — Relation arrays on `Tenant` and `Venue`

Add to `Tenant` (near `engagementQuestions`):

```prisma
  engagementQuestionResponses EngagementQuestionResponse[]
  adminChatlogNotes           AdminChatlogNote[]
  weeklyReports               WeeklyReport[]
  answerAnalysisSnapshots     AnswerAnalysisSnapshot[]
```

Add to `Venue` (near `knowledgeEntries`):

```prisma
  engagementResponses     EngagementQuestionResponse[]
  adminChatlogNotes       AdminChatlogNote[]
  weeklyReports           WeeklyReport[]
  answerAnalysisSnapshots AnswerAnalysisSnapshot[]
```

### 1h — Migration

Create
`packages/db/prisma/migrations/20260703000000_add_answer_capture_and_weekly_reports/migration.sql`
with the `CREATE TYPE`/`ALTER TABLE`/`CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT`
statements matching 1a–1f exactly (column names via the `@map`s above, `snake_case`
tables). Follow the exact style of
`packages/db/prisma/migrations/20260702000000_add_engagement_questions/migration.sql`
(guarded `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for the two new
enums, plain `ALTER TABLE ... ADD COLUMN` for the four new `visitor_sessions` columns,
plain `CREATE TABLE` + `CREATE INDEX` + `ADD CONSTRAINT` for the four new tables). Do not
edit the `20260413120000_add_weekly_digest` migration — `WeeklyDigest` is untouched by this
packet.

### 1i — `packages/db/src/tenanted-tables.ts`

Add the four new tenanted tables:

```ts
export const TENANTED_TABLES = [
  'TenantMembership',
  'TenantFeatureFlag',
  'Venue',
  'Place',
  'VenueKnowledgeEntry',
  'VisitorSession',
  'Message',
  'DataAdapter',
  'OperationalUpdate',
  'AnalyticsEvent',
  'DailyRollup',
  'WeeklyDigest',
  'QuestionCluster',
  'EngagementQuestion',
  'EngagementQuestionResponse',
  'AdminChatlogNote',
  'WeeklyReport',
  'AnswerAnalysisSnapshot',
] as const
```

---

## Part 2 — Capture answers: sentinel marker + `chat.ts`

### 2a — Prompt instruction: `packages/api/src/lib/venue-context.ts`

The AI already decides, on its own discretion, whether to actually ask the engagement
question this turn (see `engagementQuestionSection`, three branches around line 226–251).
Add one line to **all three** branches telling it to self-report when it does, with an
exact sentinel the backend will strip:

Append to the end of each of the three returned strings (the authored-only branch, the
authored+invention branch, and the invention-only branch) in
`buildVenueSystemPromptParts`:

```
 If — and only if — you actually asked this engagement question in your reply this turn, end your reply with the exact text [[ENGAGEMENT_ASKED]] on its own line after everything else. Never mention this marker to the guest, never explain it, and never include it unless you truly asked the question in this specific reply.
```

Concretely, each of the three template literals in `engagementQuestionSection` gets this
sentence appended inside the string (after the existing `choiceOptions` conditional, before
the closing backtick). Keep the wording identical across all three branches so a shared
test string can assert on it.

### 2b — Detect and strip the marker: `packages/api/src/routers/chat.ts`

Add a constant near the other module-level constants (line ~77):

```ts
const ENGAGEMENT_ASKED_MARKER = '[[ENGAGEMENT_ASKED]]'

function stripEngagementMarker(text: string): { cleaned: string; markerFound: boolean } {
  const markerIndex = text.lastIndexOf(ENGAGEMENT_ASKED_MARKER)
  if (markerIndex === -1) {
    return { cleaned: text, markerFound: false }
  }
  return { cleaned: text.slice(0, markerIndex).trimEnd(), markerFound: true }
}
```

### 2c — Extend the session `select` (step 2, line ~220)

Both `session` upserts in `chat.ts` (the `session` mutation at line ~110 and the `send`
mutation at line ~203) already `select: { id: true }`. In the `send` mutation only, extend
the select to also read the pending-answer snapshot **before** it gets overwritten later
this turn:

```ts
select: {
  id: true,
  pendingEngagementQuestionId: true,
  pendingEngagementIsInvented: true,
  pendingEngagementAskedMessageId: true,
  pendingEngagementAskedAt: true,
},
```

Capture this as `const pendingAnswerSnapshot = session.pendingEngagementQuestionId !== null || session.pendingEngagementIsInvented ? { ...session } : null` right after the upsert — a plain `null` check on either the FK or the invented flag, since an invented-question pending state has no `pendingEngagementQuestionId`.

The `session` (no-op idempotent creation) mutation does not need this — it never processes
a message, so it can never consume or produce a pending answer.

### 2d — Strip the marker after the Claude call (step 6, replaces line 409–412)

```ts
const { cleaned: strippedResponse, markerFound } = stripEngagementMarker(
  result.content[0]?.type === 'text'
    ? result.content[0].text
    : "I'm sorry, I couldn't generate a response.",
)
assistantResponse = strippedResponse
const engagementAskedThisTurn =
  markerFound && (selectedEngagementQuestion !== null || allowAiInventedQuestion)
```

`engagementAskedThisTurn` only trusts the marker when the prompt actually offered an
engagement question this turn — a cheap guard against the model hallucinating the marker
unprompted. On the Claude-failure catch path, `engagementAskedThisTurn` stays `false`
(the fallback string never contains the marker).

### 2e — After persisting messages (step 7, after line 440)

The existing code creates the `user` message then the `assistant` message. Capture the
assistant message's `id`:

```ts
const assistantMessage = await ctx.db.message.create({
  data: {
    tenantId: venue.tenantId,
    sessionId: session.id,
    role: 'assistant',
    content: assistantResponse,
  },
  select: { id: true },
})
```

(Change the existing `create` call from a bare `void`-style call to capture the return
value — same call, same `data`, just add `select: { id: true }` and assign to a `const`.)

Immediately after, add two independent blocks — **consume** any pending answer from a
previous turn, then **set** a new pending state if this turn asked one:

```ts
// 7b. Consume a pending answer from a previous turn, if this message is the reply to it.
if (pendingAnswerSnapshot) {
  const userMessageForAnswer = await ctx.db.message.findFirst({
    where: { sessionId: session.id, tenantId: venue.tenantId, role: 'user' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  let questionText: string | null = null
  let answerType: 'OPEN_ENDED' | 'MULTIPLE_CHOICE' = 'OPEN_ENDED'

  if (pendingAnswerSnapshot.pendingEngagementQuestionId) {
    const question = await ctx.db.engagementQuestion.findFirst({
      where: { id: pendingAnswerSnapshot.pendingEngagementQuestionId, tenantId: venue.tenantId },
      select: { prompt: true, questionType: true },
    })
    questionText = question?.prompt ?? null
    answerType = question?.questionType ?? 'OPEN_ENDED'
  } else if (pendingAnswerSnapshot.pendingEngagementAskedMessageId) {
    const askedMessage = await ctx.db.message.findFirst({
      where: {
        id: pendingAnswerSnapshot.pendingEngagementAskedMessageId,
        tenantId: venue.tenantId,
      },
      select: { content: true },
    })
    questionText = askedMessage?.content ?? null
  }

  if (
    questionText &&
    userMessageForAnswer &&
    pendingAnswerSnapshot.pendingEngagementAskedMessageId
  ) {
    await ctx.db.engagementQuestionResponse.create({
      data: {
        tenantId: venue.tenantId,
        venueId: input.venueId,
        sessionId: session.id,
        engagementQuestionId: pendingAnswerSnapshot.pendingEngagementQuestionId,
        isAiInvented: pendingAnswerSnapshot.pendingEngagementIsInvented,
        answerType,
        questionText,
        askedMessageId: pendingAnswerSnapshot.pendingEngagementAskedMessageId,
        answerMessageId: userMessageForAnswer.id,
        answerText: trimmedInput,
        askedAt: pendingAnswerSnapshot.pendingEngagementAskedAt ?? new Date(),
        answeredAt: new Date(),
      },
    })
  }

  await ctx.db.visitorSession.updateMany({
    where: { id: session.id, tenantId: venue.tenantId },
    data: {
      pendingEngagementQuestionId: null,
      pendingEngagementIsInvented: false,
      pendingEngagementAskedMessageId: null,
      pendingEngagementAskedAt: null,
    },
  })
}

// 7c. Mark this turn's engagement question (if the AI self-reported asking it) as pending
// for the guest's next reply to be captured against.
if (engagementAskedThisTurn) {
  await ctx.db.visitorSession.updateMany({
    where: { id: session.id, tenantId: venue.tenantId },
    data: {
      pendingEngagementQuestionId: selectedEngagementQuestion?.id ?? null,
      pendingEngagementIsInvented: allowAiInventedQuestion && !selectedEngagementQuestion,
      pendingEngagementAskedMessageId: assistantMessage.id,
      pendingEngagementAskedAt: new Date(),
    },
  })
}
```

`userMessageForAnswer` re-queries instead of reusing the earlier `user` message create's
return value only because the existing code doesn't currently capture that `create`'s
result — simplest fix is to also add `select: { id: true }` to the `user` message `create`
a few lines above and reuse its `id` directly instead of re-querying. Prefer that: capture
`const userMessage = await ctx.db.message.create({ ..., select: { id: true } })` for the
`role: 'user'` create too, and use `userMessage.id` in place of the `findFirst` above.

### 2f — Return value

`assistantResponse` (now the marker-stripped text) is what the rest of the procedure
already returns to the guest — no change needed there, just confirm no other code path
re-reads `result.content[0].text` directly after this point.

---

## Part 3 — Admin router: chatlog review

New file `packages/api/src/routers/admin/chatlog.ts`, mounted into the existing
`adminRouter` in `packages/api/src/routers/admin/_admin.ts` (add
`import { adminChatlogRouter } from './chatlog'` and a `chatlog: adminChatlogRouter` entry
— or, if `_admin.ts` is a flat single-file router today, add these as top-level
procedures directly in `_admin.ts` following whatever pattern the existing `overview` /
`getClient` / `getClientVenue` / `triggerDigest` procedures use. Check `_admin.ts`'s actual
structure before choosing; the packet assumes it's one flat `router({...})` today based on
Part 4a of `engagement-questions.md`'s sibling packets, so default to adding flat
procedures unless a sub-router pattern already exists).

All procedures are `adminProcedure`, all cross-tenant reads run inside
`withTenantIsolationBypass` (this is a `packages/db` export, already used in `_admin.ts`),
and every read still filters explicitly by the `tenantId`/`venueId` the admin passed in —
the bypass exists so a _cross-tenant_ admin session isn't blocked by the tenant-isolation
middleware, not so admin queries can skip scoping. State-changing procedures call
`writeAuditLog`.

```ts
listVenueSessions: adminProcedure
  .input(
    z.object({
      tenantId: z.string(),
      venueId: z.string(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      notableOnly: z.boolean().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
  )
  .query(async ({ input }) => {
    return withTenantIsolationBypass(async () => {
      const sessions = await db.visitorSession.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          ...(input.notableOnly ? { isNotable: true } : {}),
          ...(input.dateFrom || input.dateTo
            ? {
                startedAt: {
                  ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
                  ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
                },
              }
            : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          startedAt: true,
          lastActiveAt: true,
          messageCount: true,
          isNotable: true,
          _count: { select: { engagementResponses: true, adminNotes: true } },
        },
      })

      const hasMore = sessions.length > input.limit
      return {
        sessions: sessions.slice(0, input.limit),
        nextCursor: hasMore ? sessions[input.limit]?.id ?? null : null,
      }
    })
  }),

getSessionChatlog: adminProcedure
  .input(z.object({ tenantId: z.string(), sessionId: z.string() }))
  .query(async ({ input }) => {
    return withTenantIsolationBypass(async () => {
      const session = await db.visitorSession.findFirst({
        where: { id: input.sessionId, tenantId: input.tenantId },
        select: {
          id: true,
          venueId: true,
          startedAt: true,
          lastActiveAt: true,
          isNotable: true,
          venue: { select: { name: true } },
          messages: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, role: true, content: true, createdAt: true },
          },
          engagementResponses: {
            orderBy: { askedAt: 'asc' },
            select: {
              id: true,
              questionText: true,
              answerText: true,
              answerType: true,
              isAiInvented: true,
              askedAt: true,
              answeredAt: true,
            },
          },
          adminNotes: {
            orderBy: { createdAt: 'desc' },
            select: { id: true, note: true, authorId: true, createdAt: true },
          },
        },
      })

      if (!session) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' })
      }

      return session
    })
  }),

setSessionNotable: adminProcedure
  .input(z.object({ tenantId: z.string(), sessionId: z.string(), isNotable: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    await withTenantIsolationBypass(async () => {
      await db.visitorSession.updateMany({
        where: { id: input.sessionId, tenantId: input.tenantId },
        data: { isNotable: input.isNotable },
      })
    })

    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: ctx.session.userId,
      actorRole: 'PLATFORM_ADMIN',
      action: input.isNotable ? 'admin.chatlog.marked_notable' : 'admin.chatlog.unmarked_notable',
      targetType: 'VisitorSession',
      targetId: input.sessionId,
    })

    return { ok: true }
  }),

addChatlogNote: adminProcedure
  .input(z.object({ tenantId: z.string(), venueId: z.string(), sessionId: z.string(), note: z.string().min(1).max(2000) }))
  .mutation(async ({ ctx, input }) => {
    const created = await withTenantIsolationBypass(async () => {
      return db.adminChatlogNote.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          sessionId: input.sessionId,
          authorId: ctx.session.userId,
          note: input.note,
        },
        select: { id: true, note: true, authorId: true, createdAt: true },
      })
    })

    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: ctx.session.userId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'admin.chatlog.note_added',
      targetType: 'VisitorSession',
      targetId: input.sessionId,
      afterState: { note: input.note },
    })

    return created
  }),
```

`ctx.session.userId` — confirm the exact field name on the admin session context by
checking how `_admin.ts`'s existing `triggerDigest` procedure reads the actor id (line
~579 uses `ctx.session.userId`); reuse whatever that already is.

---

## Part 4 — Admin UI: chatlog review pages

### 4a — `apps/dashboard/app/(admin)/admin/clients/[tenantId]/venues/[venueId]/chatlogs/page.tsx`

Server component following the exact pattern of
`admin/clients/[tenantId]/venues/[venueId]/page.tsx` (`createAdminCaller()`, `StatCard`
helper, `rounded-2xl border border-pf-light bg-pf-white` cards). Reads `searchParams` for
`from`/`to`/`notable` (date range + notable-only filter), calls
`caller.admin.listVenueSessions(...)`, renders a table (session started time, message
count, notable badge, answer count) with each row linking to
`chatlogs/[sessionId]`. Include a simple `<form>` with `type="date"` inputs for the range
filter (GET, no client JS needed) and a "Notable only" checkbox, matching the read-only,
server-rendered style already used on the sibling venue page.

### 4b — `.../chatlogs/[sessionId]/page.tsx`

Server component calling `caller.admin.getSessionChatlog({ tenantId, sessionId })`.
Renders:

- Session metadata header (venue name, started/last active, notable badge).
- Full transcript: map `messages` into alternating bubbles (reuse the existing
  `pf-*` color conventions — user vs assistant, similar to how the guest chat UI in
  `apps/web` styles messages, but read-only, no input box).
- A distinct "Answers captured" section listing `engagementResponses` (question text,
  answer text, asked/answered timestamps, an "AI-invented" badge when `isAiInvented`).
- A "Notable" toggle button, client component `AdminChatlogNotableToggle.tsx` (mirrors
  `AdminTriggerDigestButton.tsx`'s `useRef`-held `createTRPCClient()` + pending/error state
  pattern), calling `admin.setSessionNotable.mutate`.
- An admin notes panel: list of existing `adminNotes`, plus a small form (client component
  `AdminChatlogNoteForm.tsx`, same pattern) calling `admin.addChatlogNote.mutate`, then
  appending the returned note to local state (no full page reload needed, mirrors how
  `EngagementQuestionsManager.tsx` updates local list state after a mutation).

---

## Part 5 — AI analysis of collected answers

### 5a — Queue + payload: `packages/jobs/src/queues.ts` and `types.ts`

Add to `queues.ts`:

```ts
export const ANSWER_ANALYSIS_QUEUE = 'answer-analysis'
export const ANSWER_ANALYSIS_PROCESS_JOB = 'answer-analysis-process'
export const ANSWER_ANALYSIS_RETRY_BACKOFF = 'answer-analysis-retry'
```

Add to `types.ts`:

```ts
export type AnswerAnalysisJobPayload = {
  tenantId: string
  venueId: string
  rangeStart: string
  rangeEnd: string
  snapshotId: string
}
```

### 5b — Enqueue helper: `packages/jobs/src/enqueue.ts`

Follow the exact `enqueueWeeklyDigest` pattern (job options object, `jobId` keyed by the
row id so retriggering the same snapshot doesn't duplicate jobs, `logger.info` on enqueue):

```ts
const answerAnalysisJobOptions: JobsOptions = {
  attempts: 6,
  backoff: { type: ANSWER_ANALYSIS_RETRY_BACKOFF },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

export async function enqueueAnswerAnalysis(payload: AnswerAnalysisJobPayload): Promise<void> {
  await getQueue(ANSWER_ANALYSIS_QUEUE).add(ANSWER_ANALYSIS_PROCESS_JOB, payload, {
    ...answerAnalysisJobOptions,
    jobId: `answer-analysis:${payload.snapshotId}`,
  })

  logger.info({
    action: 'jobs.answer-analysis.enqueued',
    tenantId: payload.tenantId,
    venueId: payload.venueId,
    snapshotId: payload.snapshotId,
  })
}
```

Export it from `packages/jobs/src/index.ts` alongside the other `enqueue*` functions.

### 5c — Worker processor: `apps/workers/src/processors/answer-analysis.ts`

Follow `weekly-digest.ts`'s exact shape: module-level Anthropic client getter, a zod
response schema, a prompt builder, a `markSnapshotStatus` helper (`updateMany` inside
`withTenantIsolationBypass`, matching `markDigestStatus`), `writeJobRecord`/
`updateJobRecord`, try/catch with `FAILED` status + error message on the catch path.

Response schema:

```ts
const answerAnalysisResponseSchema = z.object({
  liked: z.array(z.string().max(300)).max(8),
  improve: z.array(z.string().max(300)).max(8),
  themes: z.array(z.string().max(200)).max(8),
  complaints: z.array(z.string().max(300)).max(8),
  mostMentioned: z.array(z.string().max(150)).max(8),
  sentimentSummary: z.string().max(500),
  quotes: z.array(z.string().max(300)).max(5),
  perQuestion: z
    .array(
      z.object({
        questionText: z.string().max(500),
        answerCount: z.number().int(),
        summary: z.string().max(600),
      }),
    )
    .max(20),
  sampleSizeCaveat: z.string().max(300).nullable(),
})
```

`sampleSizeCaveat` is non-null whenever the answer count is small — the prompt (below)
instructs the model to fill it honestly and never overclaim on thin data, matching the
product requirement. Loader:

```ts
async function loadAnswers(payload: AnswerAnalysisJobPayload) {
  return withTenantIsolationBypass(async () => {
    const [venue, responses] = await Promise.all([
      db.venue.findUnique({ where: { id: payload.venueId }, select: { name: true } }),
      db.engagementQuestionResponse.findMany({
        where: {
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          answeredAt: { gte: new Date(payload.rangeStart), lte: new Date(payload.rangeEnd) },
        },
        orderBy: { answeredAt: 'asc' },
        select: { questionText: true, answerText: true, answerType: true, isAiInvented: true },
      }),
    ])

    return { venueName: venue?.name ?? 'Unknown venue', responses }
  })
}
```

Prompt: build a single user message listing every `{questionText, answerText}` pair as
JSON, with explicit instructions matching the product spec's analysis bullets (what
visitors liked, what to improve, common themes, repeated complaints/confusion, most
mentioned activities/areas, sentiment, 2–5 representative anonymous quotes — no names or
identifying details, since these are guest chats — and, critically, per-question answers
directly addressing each configured question the venue asked). Include: `"If there are
fewer than 8 total answers, fill sampleSizeCaveat honestly noting the small sample and
avoid overclaiming; otherwise set it to null."` `CLAUDE_MODEL` reuses the same
`'claude-sonnet-4-6'` constant `weekly-digest.ts` already uses. Parse with the same
fenced-JSON-extraction fallback `parseDigestInsights` uses (copy the pattern, don't import
across processor files — each processor is self-contained, matching the existing
one-processor-per-file convention).

On success, `markSnapshotStatus` writes `{ status: 'COMPLETE', summary: parsed, answerCount: responses.length, generatedAt: new Date() }` where `summary` is the full parsed
object (stored as `Json`).

### 5d — Register the worker: `apps/workers/src/index.ts`

Add the new queue/processor alongside the existing ones, following the exact registration
pattern already used for `WEEKLY_DIGEST_QUEUE` (Worker instantiation, concurrency, event
listeners, graceful shutdown inclusion).

### 5e — Admin router mutations/queries (add to Part 3's file)

```ts
generateAnswerAnalysis: adminProcedure
  .input(z.object({ tenantId: z.string(), venueId: z.string(), rangeStart: z.string().datetime(), rangeEnd: z.string().datetime() }))
  .mutation(async ({ ctx, input }) => {
    const snapshot = await withTenantIsolationBypass(async () => {
      return db.answerAnalysisSnapshot.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          rangeStart: new Date(input.rangeStart),
          rangeEnd: new Date(input.rangeEnd),
          status: 'GENERATING',
          createdBy: ctx.session.userId,
        },
        select: { id: true },
      })
    })

    await enqueueAnswerAnalysis({
      tenantId: input.tenantId,
      venueId: input.venueId,
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
      snapshotId: snapshot.id,
    })

    return { snapshotId: snapshot.id }
  }),

listAnswerAnalyses: adminProcedure
  .input(z.object({ tenantId: z.string(), venueId: z.string() }))
  .query(async ({ input }) => withTenantIsolationBypass(async () =>
    db.answerAnalysisSnapshot.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, status: true, rangeStart: true, rangeEnd: true, answerCount: true, generatedAt: true },
    }),
  )),

getAnswerAnalysis: adminProcedure
  .input(z.object({ tenantId: z.string(), snapshotId: z.string() }))
  .query(async ({ input }) => {
    const snapshot = await withTenantIsolationBypass(async () =>
      db.answerAnalysisSnapshot.findFirst({
        where: { id: input.snapshotId, tenantId: input.tenantId },
      }),
    )
    if (!snapshot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Analysis not found' })
    return snapshot
  }),
```

### 5f — Admin UI: `.../venues/[venueId]/analysis/page.tsx`

Server component: date-range form (GET) + "Generate Analytics Summary" button (client
component `AdminGenerateAnalysisButton.tsx`, same `useRef` client pattern, calls
`generateAnswerAnalysis.mutate`, then either redirects to or polls
`getAnswerAnalysis` — simplest: on success, `router.push` to a
`analysis/[snapshotId]` detail page that server-renders the (possibly still-`GENERATING`)
snapshot with a `<meta http-equiv="refresh" content="4">`-style manual reload note, matching
this codebase's existing preference for server-rendered simplicity over client polling
loops). List recent snapshots via `listAnswerAnalyses` with links to each.

`.../analysis/[snapshotId]/page.tsx` renders the structured `summary` JSON as labeled
sections (Liked / Improve / Themes / Complaints / Most mentioned / Sentiment / Quotes /
Per-question answers), or a "Still generating…" state when `status === 'GENERATING'`, or
the `error` when `FAILED`.

---

## Part 6 — Weekly report builder

### 6a — Queue + payload

`packages/jobs/src/queues.ts`:

```ts
export const WEEKLY_REPORT_QUEUE = 'weekly-report'
export const WEEKLY_REPORT_PROCESS_JOB = 'weekly-report-process'
export const WEEKLY_REPORT_RETRY_BACKOFF = 'weekly-report-retry'
```

`packages/jobs/src/types.ts`:

```ts
export type WeeklyReportJobPayload = {
  tenantId: string
  venueId: string
  weekStart: string
  weekEnd: string
  reportId: string
}
```

`enqueueWeeklyReport` in `enqueue.ts`, same shape as `enqueueAnswerAnalysis`, `jobId: `weekly-report:${payload.reportId}``.

### 6b — Worker processor: `apps/workers/src/processors/weekly-report.ts`

Loads, for the venue + week range, inside `withTenantIsolationBypass`:

- Venue name/category.
- Session count + message count for the week (same shape as `weekly-digest.ts`'s
  `loadPromptSessions`, but filtered by `venueId` instead of aggregated across the tenant).
- `EngagementQuestionResponse` rows in range (question text, answer text) — this is the
  "Specific Analytics" input, directly answering what the venue configured PathFinder to
  ask.
- The venue's currently-active `EngagementQuestion` list (`prompt`, `questionType`) so the
  prompt can call out explicitly which questions had zero answers this week, rather than
  silently omitting them.
- `AdminChatlogNote` rows in range where the parent session `isNotable` is true (the "my
  private admin notes from reading chatlogs" input) — pull `note` text only, never expose
  `sessionId`/`authorId` to the prompt output.

Response schema (zod), matching the exact six-section structure from the product spec:

```ts
const weeklyReportResponseSchema = z.object({
  overview: z.string().max(800),
  visitorQuestionsAndInterests: z.string().max(1200),
  specificAnalytics: z.string().max(1500),
  notableInsight: z.string().max(800),
  quotes: z.array(z.string().max(300)).min(0).max(3),
  nextSteps: z.array(z.string().max(300)).min(1).max(2),
})
```

Prompt instructions (mirrors `buildWeeklyDigestPrompt`'s constraints — never invent data,
omit weakly-supported points, base everything only on the data provided — plus the new
product-specific requirements):

- Write for the venue operator, concise, not corporate-sounding, like a useful summary from
  someone who actually read the conversations.
- Section 2 (`visitorQuestionsAndInterests`) merges common questions/interests/confusion
  points into one short section.
- Section 3 (`specificAnalytics`) must **directly answer** each of the venue's active
  configured engagement questions using the captured answers; if a configured question has
  zero answers this week, say so plainly rather than fabricating a trend.
- `quotes` must be paraphrased/anonymized — no names, no identifying details.
- If total answers + sessions are low for the week, say so honestly in `overview` or
  `specificAnalytics` rather than overclaiming (same "frame carefully" instruction as the
  product spec).

After parsing, format into the final `content` string with a small formatter function
(not stored as JSON — `WeeklyReport.content` is a plain editable string):

```ts
function formatReportContent(params: {
  title: string
  venueName: string
  weekLabel: string
  parsed: z.infer<typeof weeklyReportResponseSchema>
}): string {
  const { title, venueName, weekLabel, parsed } = params
  const quotesBlock =
    parsed.quotes.length > 0
      ? parsed.quotes.map((q) => `- "${q}"`).join('\n')
      : 'No standout quotes this week.'
  const nextStepsBlock = parsed.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')

  return [
    `${title}`,
    `Venue: ${venueName}`,
    `Week: ${weekLabel}`,
    '',
    'Overview',
    parsed.overview,
    '',
    'Visitor Questions & Interests',
    parsed.visitorQuestionsAndInterests,
    '',
    'Specific Analytics',
    parsed.specificAnalytics,
    '',
    'Notable Insight',
    parsed.notableInsight,
    '',
    'Visitor Quotes / Examples',
    quotesBlock,
    '',
    'Suggested Next Step',
    nextStepsBlock,
  ].join('\n')
}
```

`markReportStatus` (mirrors `markDigestStatus`): on success, `{ status: 'DRAFT', content, answerCount, sessionCount, generatedAt: new Date() }`; on failure, `{ status: 'FAILED', error }`. `writeJobRecord`/`updateJobRecord` bracket the whole run, matching
`weekly-digest.ts` exactly.

### 6c — Register the worker in `apps/workers/src/index.ts`, same as Part 5d.

### 6d — Admin router mutations/queries (add to Part 3's file)

```ts
generateWeeklyReportDraft: adminProcedure
  .input(z.object({ tenantId: z.string(), venueId: z.string(), weekStart: z.string().datetime(), weekEnd: z.string().datetime() }))
  .mutation(async ({ ctx, input }) => {
    const weekStart = new Date(input.weekStart)
    const weekEnd = new Date(input.weekEnd)

    const report = await withTenantIsolationBypass(async () => {
      const existing = await db.weeklyReport.findUnique({
        where: { venueId_weekStart: { venueId: input.venueId, weekStart } },
        select: { id: true, status: true },
      })

      if (existing?.status === 'PUBLISHED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This week is already published. Unpublish is not supported — create a correction note instead.',
        })
      }

      if (existing) {
        return db.weeklyReport.update({
          where: { id: existing.id },
          data: { status: 'GENERATING', error: null },
          select: { id: true },
        })
      }

      return db.weeklyReport.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          weekStart,
          weekEnd,
          status: 'GENERATING',
          createdBy: ctx.session.userId,
        },
        select: { id: true },
      })
    })

    await enqueueWeeklyReport({
      tenantId: input.tenantId,
      venueId: input.venueId,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      reportId: report.id,
    })

    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: ctx.session.userId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'admin.report.draft_generated',
      targetType: 'WeeklyReport',
      targetId: report.id,
    })

    return { reportId: report.id }
  }),

listWeeklyReports: adminProcedure
  .input(z.object({ tenantId: z.string(), venueId: z.string() }))
  .query(async ({ input }) => withTenantIsolationBypass(async () =>
    db.weeklyReport.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      orderBy: { weekStart: 'desc' },
      select: { id: true, weekStart: true, weekEnd: true, status: true, title: true, publishedAt: true, updatedAt: true },
    }),
  )),

getWeeklyReport: adminProcedure
  .input(z.object({ tenantId: z.string(), reportId: z.string() }))
  .query(async ({ input }) => {
    const report = await withTenantIsolationBypass(async () =>
      db.weeklyReport.findFirst({ where: { id: input.reportId, tenantId: input.tenantId } }),
    )
    if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
    return report
  }),

updateWeeklyReportDraft: adminProcedure
  .input(z.object({ tenantId: z.string(), reportId: z.string(), title: z.string().min(1).max(200).optional(), content: z.string().min(1).max(10_000) }))
  .mutation(async ({ ctx, input }) => {
    const existing = await withTenantIsolationBypass(async () =>
      db.weeklyReport.findFirst({ where: { id: input.reportId, tenantId: input.tenantId }, select: { status: true } }),
    )
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
    if (existing.status === 'PUBLISHED') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Published reports cannot be edited.' })
    }

    await withTenantIsolationBypass(async () => {
      await db.weeklyReport.updateMany({
        where: { id: input.reportId, tenantId: input.tenantId },
        data: {
          content: input.content,
          ...(input.title !== undefined ? { title: input.title } : {}),
        },
      })
    })

    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: ctx.session.userId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'admin.report.edited',
      targetType: 'WeeklyReport',
      targetId: input.reportId,
    })

    return { ok: true }
  }),

publishWeeklyReport: adminProcedure
  .input(z.object({ tenantId: z.string(), reportId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    const existing = await withTenantIsolationBypass(async () =>
      db.weeklyReport.findFirst({ where: { id: input.reportId, tenantId: input.tenantId }, select: { status: true, content: true } }),
    )
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
    if (existing.status !== 'DRAFT') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a draft report can be published.' })
    }
    if (!existing.content) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Report has no content to publish.' })
    }

    await withTenantIsolationBypass(async () => {
      await db.weeklyReport.updateMany({
        where: { id: input.reportId, tenantId: input.tenantId },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      })
    })

    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: ctx.session.userId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'admin.report.published',
      targetType: 'WeeklyReport',
      targetId: input.reportId,
    })

    return { ok: true }
  }),
```

`weeklyReport.findUnique({ where: { venueId_weekStart: ... } })` relies on the
`@@unique([venueId, weekStart])` from Part 1e — Prisma names the compound-unique input
`venueId_weekStart` by default; confirm the generated client field name matches after
`prisma generate` and adjust if it differs.

### 6e — Admin UI: `.../venues/[venueId]/reports/page.tsx`

Server component: week-picker form (a single `type="week"` or two `type="date"` inputs) +
"Generate Weekly Report Draft" button (client component, same pattern as
`AdminGenerateAnalysisButton.tsx`), calling `generateWeeklyReportDraft.mutate`, then
`router.push` to `reports/[reportId]`. Below the form, `listWeeklyReports` rendered as a
table (week range, status badge — Generating/Draft/Published/Failed — updated timestamp),
each row linking to its detail/editor page.

### 6f — Admin UI: `.../reports/[reportId]/page.tsx`

Server component fetches `getWeeklyReport`. If `status === 'GENERATING'`, show a simple
"Generating…" state (reload to check). If `FAILED`, show the `error` and a "Try again"
link back to the reports list. Otherwise render a client component
`WeeklyReportEditor.tsx`:

- A title input + large `<textarea>` pre-filled with `content`, following the
  `EngagementQuestionsManager.tsx` textarea styling conventions.
- "Save Draft" button → `updateWeeklyReportDraft.mutate({ reportId, title, content })`.
  Disabled once `status === 'PUBLISHED'` (fields become read-only display instead of an
  editable form in that case — check `status` client-side after the initial server fetch).
- "Publish to Client Dashboard" button → `publishWeeklyReport.mutate({ reportId })`, with a
  confirmation step (plain `window.confirm`-style guard is fine given the low-tech bar this
  packet sets for admin UI) since publishing is irreversible in this packet's scope (no
  unpublish mutation — intentionally out of scope; correcting a published report is a
  manual follow-up, not built here).

---

## Part 7 — Client dashboard: Weekly Reports

### 7a — `packages/api/src/routers/tenant.ts` or a small addition to `analytics.ts`

Add a `tenantProcedure` query — put it in `analytics.ts` next to the soon-to-be-removed
digest queries since it's the same "read-only insight surface for the operator" concern:

```ts
listPublishedWeeklyReports: tenantProcedure
  .input(z.object({ venueId: z.string() }).strict())
  .query(async ({ ctx, input }) => {
    const venue = await ctx.db.venue.findFirst({
      where: { id: input.venueId, tenantId: ctx.session.activeTenantId },
      select: { id: true },
    })
    if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

    return ctx.db.weeklyReport.findMany({
      where: { tenantId: ctx.session.activeTenantId, venueId: input.venueId, status: 'PUBLISHED' },
      orderBy: { weekStart: 'desc' },
      select: { id: true, title: true, weekStart: true, weekEnd: true, content: true, publishedAt: true },
    })
  }),
```

This is deliberately the only report field ever exposed through a `tenantProcedure` —
`status`, `createdBy`, draft `content` pre-publish, and everything admin-only stays behind
`adminProcedure`. The `venueId` ownership check (venue must belong to the caller's active
tenant) is required even though `WeeklyReport.tenantId` is also filtered, because a
`venueId` alone is guessable — this is the same double-check pattern other `tenantProcedure`
reads in this codebase already use when a client-supplied id crosses into a different
scoping dimension.

### 7b — `apps/dashboard/app/(app)/weekly-reports/page.tsx` (new file)

Follows the `venue`-picker pattern from `ai-controls/page.tsx` (`searchParams.venue`,
`caller.venue.list()`, empty-state if no venues). For the resolved venue, call
`caller.analytics.listPublishedWeeklyReports({ venueId })`. Render each report as a card:
title, week range, published date, and the `content` rendered as preformatted text (`<pre
className="whitespace-pre-wrap ...">`) inside a `rounded-[2rem] border border-pf-light
bg-pf-white` card — matches this codebase's plain-text-first rendering style (no markdown
renderer needed since `content` is plain text per the six-section format). Empty state:
"No weekly reports published yet."

### 7c — Nav entry: `apps/dashboard/components/DashboardShell.tsx`

Add a `Weekly Reports` entry to `navigationItems` (see the existing array — add after
`Analytics`, using a `lucide-react` icon like `FileText` or `NotebookText`), following the
exact object shape already used for `Engagement Questions`.

---

## Part 8 — Retire the `WeeklyDigest` client panel

In `apps/dashboard/app/(app)/analytics/page.tsx`:

- Remove the `InsightCards` component, the `digest`/`getLatestDigest`/`listDigests`/
  `getDigest` calls, and the digest-related `searchParams.digest` handling.
- Keep the session-count chart (`SessionTrendChart`/`aggregateSessionSeries`) and whatever
  other non-digest analytics content already lives on that page — those are unrelated to
  the digest panel and stay.
- Add a short pointer/link to `/weekly-reports` where the digest cards used to be (e.g. "See
  your weekly insight reports →"), so operators used to finding insights on the Analytics
  page aren't left with a dead end.

Do **not** remove `analytics.getLatestDigest` / `listDigests` / `getDigest` from
`packages/api/src/routers/analytics.ts`, the `WeeklyDigest` Prisma model, the
`weekly-digest` queue, or `apps/workers/src/processors/weekly-digest.ts` — those are out of
scope for this packet (forward-only migrations; removing a table/queue is a deliberate,
separate follow-up). The admin `/clients/[tenantId]` page's "Weekly digest" card
(`AdminTriggerDigestButton.tsx`) can also stay as-is; it's an internal trigger, not a
client-facing surface, and isn't part of the conflict being resolved here.

---

## Tests

### `packages/api/src/routers/chat.test.ts` (extend)

1. **Marker stripped, never reaches the guest** — mock Claude to return
   `"Some reply.\n[[ENGAGEMENT_ASKED]]"` with an engagement question offered this turn;
   assert the returned `assistantResponse` (and the persisted assistant `Message.content`)
   does not contain `[[ENGAGEMENT_ASKED]]`.
2. **Marker ignored when no question was offered this turn** — mock Claude to return text
   containing the marker while the engagement gate did not pass this turn; assert no
   pending-answer fields are set on the session afterward (guards against a hallucinated
   marker).
3. **Pending state set after a self-reported ask** — gate passes, Claude response includes
   the marker; assert `visitorSession.updateMany` was called setting
   `pendingEngagementAskedMessageId` to the new assistant message's id.
4. **Answer captured on the following turn** — seed a session with
   `pendingEngagementQuestionId`/`pendingEngagementAskedMessageId` set (mock
   `visitorSession.upsert` to return those fields); send a message; assert
   `engagementQuestionResponse.create` was called with the incoming message as
   `answerText` and the prior assistant message id as `askedMessageId`; assert the pending
   fields are cleared afterward.
5. **Invented-question path** — same as #4 but `pendingEngagementQuestionId` is `null` and
   `pendingEngagementIsInvented` is `true`; assert `questionText` is sourced from the
   `Message.content` lookup (mock `message.findFirst`) rather than
   `engagementQuestion.findFirst`.

### `packages/api/src/lib/venue-context.test.ts` (extend)

Assert all three `engagementQuestionSection` branches contain the
`[[ENGAGEMENT_ASKED]]` sentinel instruction.

### `packages/api/src/routers/admin/chatlog.test.ts` (new file)

Mirror `admin/_admin.test.ts`'s `vi.mock('@pathfinder/db', ...)` conventions:

1. `listVenueSessions` scopes by `tenantId` + `venueId`, applies the date-range filter.
2. `getSessionChatlog` returns `NOT_FOUND` for a session outside the given `tenantId`.
3. `setSessionNotable` writes the audit log with the correct `action` for both true/false.
4. `addChatlogNote` persists `authorId` from `ctx.session.userId`, not from client input.
5. `generateWeeklyReportDraft` throws `BAD_REQUEST` when an existing report for that
   `venueId`+`weekStart` is already `PUBLISHED`.
6. `updateWeeklyReportDraft` throws `BAD_REQUEST` on a `PUBLISHED` report.
7. `publishWeeklyReport` throws `BAD_REQUEST` when `status !== 'DRAFT'` and when `content`
   is null.

### `packages/api/src/routers/analytics.test.ts` (extend)

`listPublishedWeeklyReports` only returns `status: 'PUBLISHED'` rows and throws
`NOT_FOUND` when `venueId` doesn't belong to `ctx.session.activeTenantId`.

### `apps/workers` processor tests

Follow whatever test convention (if any) covers `weekly-digest.ts` today — if none exists,
this packet doesn't need to add one from scratch for `answer-analysis.ts`/
`weekly-report.ts` beyond what's practical; per `CLAUDE.md`, "Worker changes need
processor/enqueue coverage when practical" — at minimum, add
`packages/jobs`-level tests for `enqueueAnswerAnalysis`/`enqueueWeeklyReport` mirroring
however `enqueueWeeklyDigest` is (or isn't) currently tested.

### `packages/db/src/middleware/tenant-isolation.test.ts`

Add the four new tenanted tables to whatever forbidden-path coverage already parametrizes
over `TENANTED_TABLES` (check the existing test structure — it likely already iterates the
array generically, in which case no per-table test needs to be hand-written).

---

## Definition of Done

- [ ] Schema: `WeeklyReportStatus`, `AnswerAnalysisStatus` enums; `VisitorSession` pending-
      answer + `isNotable` fields; `EngagementQuestionResponse`, `AdminChatlogNote`,
      `WeeklyReport`, `AnswerAnalysisSnapshot` models; all four new tables added to
      `TENANTED_TABLES`
- [ ] Migration `20260703000000_add_answer_capture_and_weekly_reports` applies cleanly
      without touching the existing `weekly_digests` migration
- [ ] `[[ENGAGEMENT_ASKED]]` sentinel added to all three `engagementQuestionSection`
      branches in `venue-context.ts`
- [ ] `chat.ts` strips the marker before it ever reaches the guest or gets persisted,
      only trusts it when an engagement question was actually offered that turn, and
      correctly threads pending-ask → answer-capture across two consecutive turns
- [ ] Admin chatlog review: list sessions by venue/date range, open a full transcript,
      see captured answers, toggle notable, add private notes — all `adminProcedure`,
      audit-logged where state changes
- [ ] AI answer analysis: background job, zod-validated structured output, admin-only
      view, explicitly answers each of the venue's configured engagement questions,
      honestly flags small sample sizes
- [ ] Weekly report builder: generate draft (background job) → edit → save draft →
      publish, each transition guarded server-side (no editing/regenerating a published
      report)
- [ ] Client dashboard has a "Weekly Reports" page showing only `PUBLISHED` reports for
      the caller's own tenant/venue, via a `tenantProcedure` that exposes no draft/admin
      fields
- [ ] Old `WeeklyDigest` panel removed from the client Analytics page; `WeeklyDigest`
      table/queue/processor and the admin digest-trigger button are left untouched
- [ ] No `apps/admin` app created — all new admin UI lives under
      `apps/dashboard/app/(admin)/admin/...`
- [ ] `pnpm typecheck` passes with no new errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes, including the new/extended tests above
