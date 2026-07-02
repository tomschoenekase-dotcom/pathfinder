# Task Packet: Guest Engagement Questions

## Product spec (confirmed with stakeholder before this packet was written)

Tenants can define a small set of "engagement questions" that the AI guide
weaves into guest conversations at natural moments — not on every turn, and
never verbatim the same way twice. Two question types:

1. **Open-ended** — e.g. "Did you have trouble finding your way around today?"
2. **Soft multiple-choice** — a sentence-form question plus 2-4 structured
   choice options the AI can mention conversationally (never as a literal
   menu/bullet list). E.g. prompt "Which of these was your favorite part of
   the visit?" with options `["the butterfly exhibit", "the food court", "the
gift shop"]`.

Each question has:

- `questionType`: `OPEN_ENDED` or `MULTIPLE_CHOICE`
- `prompt`: free text describing the question and the operator's intent — the
  AI rephrases this in its own words each time, it is never read verbatim
- `choiceOptions`: 2-4 strings, only used when `questionType` is
  `MULTIPLE_CHOICE`
- `intensity`: 1-5 slider — higher intensity means the AI is more likely to
  weave this specific question in relative to a tenant's other questions
- `isActive`: boolean — inactive questions are stored but never surfaced to
  the AI

At the top of the dashboard page, one tenant-wide mode applies to every
active question:

- **Stoic** — AI never asks engagement questions.
- **Balanced** — AI asks the questions below, at their configured intensities.
- **Curious** — same as Balanced, asked somewhat more often. (Free-form
  AI-invented questions beyond the client's list are explicitly **out of
  scope for this sprint** — do not build that behavior. Curious differs from
  Balanced only in the base chance-to-ask constant.)

No answer-capture/analytics reporting in this sprint — the guest's reply is
just a normal chat `Message`. Only a best-effort `engagement_question.asked`
analytics event fires when a question is selected for a turn, mirroring the
existing `message.sent`/`message.received` pattern.

Mode and questions are **tenant-scoped**, not per-venue (matches how
"Settings" and plan tier are tenant-level, and this is framed as a
company-level policy, not a per-venue one).

Run `pnpm install && pnpm typecheck && pnpm lint && pnpm test` from the repo
root before marking done.

---

## Part 1 — Schema

### 1a — `packages/db/prisma/schema.prisma`

Add two new enums, near the existing enum block (after `MembershipStatus`,
line 124):

```prisma
enum EngagementQuestionType {
  OPEN_ENDED
  MULTIPLE_CHOICE
}

enum TenantEngagementMode {
  STOIC
  BALANCED
  CURIOUS
}
```

Add `engagementMode` to the `Tenant` model (after `nextPaymentDue`) and a new
relation array:

```prisma
model Tenant {
  id             String              @id
  name           String
  slug           String              @unique
  planTier       String              @default("free") @map("plan_tier")
  status         TenantStatus        @default(ACTIVE)
  config         Json                @default("{}")
  nextPaymentDue DateTime?           @map("next_payment_due")
  engagementMode TenantEngagementMode @default(STOIC) @map("engagement_mode")
  createdAt      DateTime            @default(now()) @map("created_at")
  updatedAt      DateTime            @updatedAt @map("updated_at")
  memberships  TenantMembership[]
  featureFlags TenantFeatureFlag[]
  venues       Venue[]
  operationalUpdates OperationalUpdate[]
  analyticsEvents AnalyticsEvent[]
  dailyRollups DailyRollup[]
  weeklyDigests WeeklyDigest[]
  questionClusters QuestionCluster[]
  engagementQuestions EngagementQuestion[]

  @@map("tenants")
}
```

Add a new model, after `TenantFeatureFlag` (line 97):

```prisma
model EngagementQuestion {
  id            String                 @id @default(cuid())
  tenantId      String                 @map("tenant_id")
  questionType  EngagementQuestionType @map("question_type")
  prompt        String
  choiceOptions String[]               @default([]) @map("choice_options")
  intensity     Int                    @default(3)
  isActive      Boolean                @default(true) @map("is_active")
  createdAt     DateTime               @default(now()) @map("created_at")
  updatedAt     DateTime               @updatedAt @map("updated_at")
  tenant        Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@index([tenantId])
  @@map("engagement_questions")
}
```

### 1b — Migration

Create
`packages/db/prisma/migrations/20260702000000_add_engagement_questions/migration.sql`:

```sql
-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "EngagementQuestionType" AS ENUM ('OPEN_ENDED', 'MULTIPLE_CHOICE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "TenantEngagementMode" AS ENUM ('STOIC', 'BALANCED', 'CURIOUS');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "engagement_mode" "TenantEngagementMode" NOT NULL DEFAULT 'STOIC';

-- CreateTable
CREATE TABLE "engagement_questions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "question_type" "EngagementQuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "choice_options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "intensity" INTEGER NOT NULL DEFAULT 3,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "engagement_questions_tenant_id_idx" ON "engagement_questions"("tenant_id");

-- AddForeignKey
ALTER TABLE "engagement_questions" ADD CONSTRAINT "engagement_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

### 1c — `packages/db/src/tenanted-tables.ts`

Add `'EngagementQuestion'` to the `TENANTED_TABLES` array:

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
] as const
```

---

## Part 2 — tRPC schemas: `packages/api/src/schemas/engagement-question.ts` (new file)

```ts
import { z } from 'zod'

export const EngagementQuestionTypeInput = z.enum(['OPEN_ENDED', 'MULTIPLE_CHOICE'])

export const CreateEngagementQuestionInput = z
  .object({
    questionType: EngagementQuestionTypeInput,
    prompt: z.string().min(1).max(500),
    choiceOptions: z.array(z.string().min(1).max(100)).max(4).default([]),
    intensity: z.number().int().min(1).max(5).default(3),
  })
  .strict()

export const UpdateEngagementQuestionInput = z
  .object({
    id: z.string().cuid(),
    questionType: EngagementQuestionTypeInput.optional(),
    prompt: z.string().min(1).max(500).optional(),
    choiceOptions: z.array(z.string().min(1).max(100)).max(4).optional(),
    intensity: z.number().int().min(1).max(5).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
```

The 2-4 option constraint for `MULTIPLE_CHOICE` is enforced in the router
(Part 3), not here, because `update` is a partial patch and the router needs
to validate the _merged_ record (existing + patch), not the patch alone.

---

## Part 3 — Router: `packages/api/src/routers/engagement-question.ts` (new file)

Follows the `place.ts` CRUD pattern (`tenantProcedure` for reads,
`.use(requireRole('MANAGER'))` for mutations, `updateMany`/`deleteMany` with
`tenantId` in the `where`).

```ts
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  CreateEngagementQuestionInput,
  UpdateEngagementQuestionInput,
} from '../schemas/engagement-question'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

export {
  CreateEngagementQuestionInput,
  UpdateEngagementQuestionInput,
} from '../schemas/engagement-question'

const engagementQuestionSelect = {
  id: true,
  tenantId: true,
  questionType: true,
  prompt: true,
  choiceOptions: true,
  intensity: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

const MULTIPLE_CHOICE_MIN = 2
const MULTIPLE_CHOICE_MAX = 4

function assertValidChoiceOptions(questionType: string, choiceOptions: string[]): void {
  if (
    questionType === 'MULTIPLE_CHOICE' &&
    (choiceOptions.length < MULTIPLE_CHOICE_MIN || choiceOptions.length > MULTIPLE_CHOICE_MAX)
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Multiple-choice questions need ${MULTIPLE_CHOICE_MIN} to ${MULTIPLE_CHOICE_MAX} choice options`,
    })
  }
}

export const engagementQuestionRouter = router({
  list: tenantProcedure.query(async ({ ctx }) => {
    return ctx.db.engagementQuestion.findMany({
      where: { tenantId: ctx.session.activeTenantId },
      select: engagementQuestionSelect,
      orderBy: { createdAt: 'asc' },
    })
  }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreateEngagementQuestionInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      assertValidChoiceOptions(input.questionType, input.choiceOptions)

      return ctx.db.engagementQuestion.create({
        data: {
          tenantId,
          questionType: input.questionType,
          prompt: input.prompt,
          choiceOptions: input.questionType === 'MULTIPLE_CHOICE' ? input.choiceOptions : [],
          intensity: input.intensity,
        },
        select: engagementQuestionSelect,
      })
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateEngagementQuestionInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.engagementQuestion.findFirst({
        where: { id: input.id, tenantId },
        select: engagementQuestionSelect,
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }

      const effectiveType = input.questionType ?? existing.questionType
      const effectiveOptions = input.choiceOptions ?? existing.choiceOptions
      assertValidChoiceOptions(effectiveType, effectiveOptions)

      const { id, ...raw } = input
      // Strip undefined — exactOptionalPropertyTypes requires no undefined values in Prisma data
      const data = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))

      // updateMany accepts tenantId in where; update does not (Prisma unique-key constraint)
      await ctx.db.engagementQuestion.updateMany({ where: { id, tenantId }, data })

      const updated = await ctx.db.engagementQuestion.findFirst({
        where: { id, tenantId },
        select: engagementQuestionSelect,
      })

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }

      return updated
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.engagementQuestion.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }

      await ctx.db.engagementQuestion.deleteMany({ where: { id: input.id, tenantId } })

      return { id: input.id }
    }),
})
```

---

## Part 4 — Tenant router: mode getter/setter

### 4a — `packages/api/src/routers/tenant.ts`

Add `engagementMode: true` to the `getSettings` tenant `select` (so the
dashboard page can read the current mode from the same call it already
makes):

```ts
select: {
  id: true,
  name: true,
  slug: true,
  planTier: true,
  status: true,
  nextPaymentDue: true,
  engagementMode: true,
},
```

Add imports for `z` and `requireRole`, and a new mutation:

```ts
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

export const tenantRouter = router({
  getSettings: tenantProcedure.query(async ({ ctx }) => {
    // ...unchanged, with engagementMode added to select as above
  }),

  /**
   * Sets the tenant-wide engagement question mode (Stoic/Balanced/Curious).
   * Read by the chat send procedure to decide whether/how often to weave
   * engagement questions into the AI's system prompt.
   */
  setEngagementMode: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ mode: z.enum(['STOIC', 'BALANCED', 'CURIOUS']) }))
    .mutation(async ({ ctx, input }) => {
      await db.tenant.update({
        where: { id: ctx.session.activeTenantId },
        data: { engagementMode: input.mode },
      })

      return { ok: true }
    }),
})
```

---

## Part 5 — Root router registration

### `packages/api/src/root.ts`

```ts
import { publicProcedure } from './trpc'
import { router } from './core'
import { adminRouter } from './routers/admin/_admin'
import { analyticsRouter } from './routers/analytics'
import { chatRouter } from './routers/chat'
import { engagementQuestionRouter } from './routers/engagement-question'
import { knowledgeRouter } from './routers/knowledge'
import { operationalUpdateRouter } from './routers/operational-update'
import { placeRouter } from './routers/place'
import { tenantRouter } from './routers/tenant'
import { venueRouter } from './routers/venue'

export const appRouter = router({
  admin: adminRouter,
  analytics: analyticsRouter,
  chat: chatRouter,
  engagementQuestion: engagementQuestionRouter,
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

export type AppRouter = typeof appRouter
```

---

## Part 6 — Selection logic: `packages/api/src/lib/engagement-questions.ts` (new file)

This is the "how often is it pushed" logic. Two-stage random pick per chat
turn: first roll whether to ask _anything at all_ (gated by tenant mode),
then — only if that roll succeeds — weight the choice among active questions
by `intensity` so a 5 surfaces more often than a 1, without ever guaranteeing
a question every turn.

```ts
export type EngagementQuestionForSelection = {
  id: string
  questionType: 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
  prompt: string
  choiceOptions: string[]
  intensity: number
}

export type TenantEngagementMode = 'STOIC' | 'BALANCED' | 'CURIOUS'

// Per-turn probability of asking *any* question at all, before picking which one.
const MODE_BASE_CHANCE: Record<TenantEngagementMode, number> = {
  STOIC: 0,
  BALANCED: 0.35,
  CURIOUS: 0.5,
}

/**
 * Picks at most one active engagement question to weave into this turn's
 * system prompt. `random` is injectable so tests can assert deterministic
 * outcomes instead of mocking Math.random globally.
 */
export function selectEngagementQuestion(
  mode: TenantEngagementMode,
  questions: EngagementQuestionForSelection[],
  random: () => number = Math.random,
): EngagementQuestionForSelection | null {
  if (questions.length === 0) return null

  const baseChance = MODE_BASE_CHANCE[mode]
  if (baseChance === 0 || random() >= baseChance) return null

  const totalWeight = questions.reduce((sum, q) => sum + q.intensity, 0)
  if (totalWeight <= 0) return null

  let roll = random() * totalWeight
  for (const question of questions) {
    roll -= question.intensity
    if (roll <= 0) return question
  }

  return questions[questions.length - 1] ?? null
}
```

---

## Part 7 — Prompt injection: `packages/api/src/lib/venue-context.ts`

Add a new param type and destructure it, then build a new section and splice
it into the "About this venue" block (same spot as `operatorGuidanceSection`
and `featuredPlaceSection`).

Add above `export function buildVenueSystemPrompt`:

```ts
type EngagementQuestionContext = {
  questionType: 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
  prompt: string
  choiceOptions: string[]
}
```

Add `engagementQuestion?: EngagementQuestionContext | null` to the `params`
object type, and add `engagementQuestion` to the existing destructure at line
70:

```ts
const { venue, relevantPlaces, featuredPlace, language, engagementQuestion } = params
```

Add this new section, near `featuredPlaceSection` (around line 84):

```ts
const engagementQuestionSection = engagementQuestion
  ? `\n\nGuest engagement moment: The operator wants you to naturally work the following into the conversation when — and only when — a genuinely natural opening appears (e.g. the conversation is wrapping up, or the guest just finished an experience). Do not force it into an unrelated answer, and do not ask it more than once per conversation. Put it in your own words each time so it never sounds scripted — do not repeat the operator's wording verbatim.\nOperator's intent: ${engagementQuestion.prompt}${
      engagementQuestion.questionType === 'MULTIPLE_CHOICE' &&
      engagementQuestion.choiceOptions.length > 0
        ? `\nWeave in these options conversationally, never as a bullet list or menu: ${engagementQuestion.choiceOptions.join(', ')}.`
        : ''
    }`
  : ''
```

Splice it into the final template literal (line 158):

```ts
About this venue:
${venueDescription}${guideNotesSection}${operatorGuidanceSection}${featuredPlaceSection}${alertsSection}${engagementQuestionSection}
```

---

## Part 8 — Wire selection into chat: `packages/api/src/routers/chat.ts`

### 8a — Imports

```ts
import { selectEngagementQuestion } from '../lib/engagement-questions'
```

### 8b — Fetch tenant mode + active questions

In the `send` procedure, extend the existing step-3 `Promise.all` (around
line 224) with two more parallel queries:

```ts
const [queryEmbedding, historyDesc, activeUpdates, tenantEngagement, engagementQuestions] =
  await Promise.all([
    generateEmbedding(trimmedInput).catch(() => null),
    ctx.db.message.findMany({
      where: { sessionId: session.id, tenantId: venue.tenantId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    }),
    ctx.db.operationalUpdate.findMany({
      where: {
        venueId: input.venueId,
        tenantId: venue.tenantId,
        isActive: true,
        expiresAt: { gt: new Date() },
      },
      select: { severity: true, title: true, body: true, redirectTo: true },
      orderBy: { severity: 'asc' },
    }),
    ctx.db.tenant.findUnique({
      where: { id: venue.tenantId },
      select: { engagementMode: true },
    }),
    ctx.db.engagementQuestion.findMany({
      where: { tenantId: venue.tenantId, isActive: true },
      select: { id: true, questionType: true, prompt: true, choiceOptions: true, intensity: true },
    }),
  ])
```

### 8c — Select a question, right before building the system prompt (around line 334)

```ts
const selectedEngagementQuestion = selectEngagementQuestion(
  tenantEngagement?.engagementMode ?? 'STOIC',
  engagementQuestions,
)

const systemPrompt = buildVenueSystemPrompt({
  venue,
  relevantPlaces,
  knowledgeEntries: relevantKnowledgeEntries,
  activeUpdates,
  userLat: contextLat,
  userLng: contextLng,
  featuredPlace,
  ...(input.language ? { language: input.language } : {}),
  guideMode,
  ...(selectedEngagementQuestion
    ? {
        engagementQuestion: {
          questionType: selectedEngagementQuestion.questionType,
          prompt: selectedEngagementQuestion.prompt,
          choiceOptions: selectedEngagementQuestion.choiceOptions,
        },
      }
    : {}),
})
```

### 8d — Best-effort analytics emit, alongside the existing `message.received` emit (around line 421)

```ts
if (selectedEngagementQuestion) {
  try {
    await emitEvent({
      tenantId: venue.tenantId,
      venueId: input.venueId,
      sessionId: input.anonymousToken,
      eventType: 'engagement_question.asked',
      metadata: {
        engagementQuestionId: selectedEngagementQuestion.id,
        intensity: selectedEngagementQuestion.intensity,
        mode: tenantEngagement?.engagementMode ?? 'STOIC',
      },
    })
  } catch {}
}
```

This fires whenever a question was selected and injected into the prompt —
it is a best-effort signal that the AI was _asked to_ weave the question in,
not confirmation it actually did (matches the existing best-effort
`emitEvent` convention; no answer capture in this sprint per product spec).

---

## Part 9 — Analytics allow-list: `packages/analytics/src/events.ts`

Add one entry to `ANALYTICS_EVENT_TYPES`:

```ts
export const ANALYTICS_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'message.sent',
  'message.received',
  'message.low_confidence',
  'place_card.viewed',
  'place_card.clicked',
  'directions.opened',
  'operational_update.viewed',
  'venue.updated',
  'engagement_question.asked',
] as const
```

---

## Part 10 — Dashboard nav: `apps/dashboard/components/DashboardShell.tsx`

Add `MessageCircleQuestion` to the `lucide-react` import and one nav entry,
after `AI Controls`:

```ts
import {
  Bot,
  ChartColumn,
  Home,
  LogOut,
  Megaphone,
  MessageCircleQuestion,
  Palette,
  Settings,
  ShieldCheck,
} from 'lucide-react'

const navigationItems = [
  { href: '/', label: 'Overview', icon: Home },
  { href: '/venues', label: 'Your Chatbot', icon: Bot },
  { href: '/analytics', label: 'Analytics', icon: ChartColumn },
  { href: '/ai-controls', label: 'AI Controls', icon: Bot },
  { href: '/engagement-questions', label: 'Engagement Questions', icon: MessageCircleQuestion },
  { href: '/chat-design', label: 'Chatbot Design', icon: Palette },
  { href: '/operational-updates', label: 'Operational Updates', icon: Megaphone },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const
```

---

## Part 11 — Dashboard page

### 11a — `apps/dashboard/app/(app)/engagement-questions/page.tsx` (new file)

Server component, following the `ai-controls/page.tsx` pattern: fetch initial
data via `createDashboardCaller`, hand off to a `'use client'` manager
component.

```tsx
import { EngagementQuestionsManager } from '../../../components/EngagementQuestionsManager'
import { createDashboardCaller } from '../../../lib/server-caller'

export default async function EngagementQuestionsPage() {
  const caller = await createDashboardCaller('/engagement-questions')
  const [{ tenant }, questions] = await Promise.all([
    caller.tenant.getSettings(),
    caller.engagementQuestion.list(),
  ])

  const serializedQuestions = questions.map((q) => ({
    ...q,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  }))

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-5xl space-y-8">
        <section className="rounded-[2rem] bg-pf-deep px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-light">
            Engagement Questions
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">Ask guests what matters</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-light/70">
            Choose how curious your AI guide should be, then write the questions you want it to
            weave naturally into the right moments of a conversation.
          </p>
        </section>

        <EngagementQuestionsManager
          initialMode={tenant.engagementMode}
          initialQuestions={serializedQuestions}
        />
      </div>
    </main>
  )
}
```

### 11b — `apps/dashboard/components/EngagementQuestionsManager.tsx` (new file)

Follows the `AiControlsForm.tsx` conventions: `createTRPCClient()` held in a
`useRef`, section cards (`rounded-[2rem] border border-pf-light bg-pf-white`),
tone-style button selector (reused here for the three modes), inline
edit-in-place per question card.

```tsx
'use client'

import { type FormEvent, useRef, useState } from 'react'
import { Flame, Plus, Sparkles, Trash2 } from 'lucide-react'

import { createTRPCClient } from '../lib/trpc'

type EngagementQuestionType = 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
type TenantEngagementMode = 'STOIC' | 'BALANCED' | 'CURIOUS'

type EngagementQuestion = {
  id: string
  questionType: EngagementQuestionType
  prompt: string
  choiceOptions: string[]
  intensity: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

type EngagementQuestionsManagerProps = {
  initialMode: TenantEngagementMode
  initialQuestions: EngagementQuestion[]
}

const MODE_OPTIONS: Array<{ value: TenantEngagementMode; label: string; description: string }> = [
  {
    value: 'STOIC',
    label: 'Stoic',
    description: 'The AI functions as normal and never asks engagement questions.',
  },
  {
    value: 'BALANCED',
    label: 'Balanced',
    description: 'The AI asks the questions below, at the intensity you set for each.',
  },
  {
    value: 'CURIOUS',
    label: 'Curious',
    description: 'Like Balanced, but the AI looks for openings to ask a bit more often.',
  },
]

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return 'Something went wrong. Please try again.'
}

function emptyChoiceOptions(): string[] {
  return ['', '']
}

function QuestionCard({
  client,
  question,
  onUpdated,
  onDeleted,
}: {
  client: ReturnType<typeof createTRPCClient>
  question: EngagementQuestion
  onUpdated: (q: EngagementQuestion) => void
  onDeleted: (id: string) => void
}) {
  const [questionType, setQuestionType] = useState<EngagementQuestionType>(question.questionType)
  const [prompt, setPrompt] = useState(question.prompt)
  const [choiceOptions, setChoiceOptions] = useState<string[]>(
    question.choiceOptions.length > 0 ? question.choiceOptions : emptyChoiceOptions(),
  )
  const [intensity, setIntensity] = useState(question.intensity)
  const [isActive, setIsActive] = useState(question.isActive)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const updated = await client.engagementQuestion.update.mutate({
        id: question.id,
        questionType,
        prompt: prompt.trim(),
        choiceOptions:
          questionType === 'MULTIPLE_CHOICE'
            ? choiceOptions.filter((o) => o.trim().length > 0)
            : [],
        intensity,
        isActive,
      })
      onUpdated({
        ...updated,
        createdAt: question.createdAt,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setSaving(true)
    setError(null)
    try {
      await client.engagementQuestion.delete.mutate({ id: question.id })
      onDeleted(question.id)
    } catch (err) {
      setError(getErrorMessage(err))
      setSaving(false)
    }
  }

  return (
    <div className="rounded-[1.5rem] border border-pf-light bg-pf-surface p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setQuestionType('OPEN_ENDED')}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              questionType === 'OPEN_ENDED'
                ? 'bg-pf-primary text-white'
                : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
            }`}
          >
            Open-ended
          </button>
          <button
            type="button"
            onClick={() => setQuestionType('MULTIPLE_CHOICE')}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              questionType === 'MULTIPLE_CHOICE'
                ? 'bg-pf-primary text-white'
                : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
            }`}
          >
            Soft multiple-choice
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium text-pf-deep/60">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-pf-light text-pf-primary focus:ring-pf-accent"
          />
          Active
        </label>
      </div>

      <textarea
        value={prompt}
        maxLength={500}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the question and what you want to learn — the AI rephrases this in its own words each time, so write it like a note to the AI, not a script."
        className="mt-4 min-h-24 w-full rounded-2xl border border-pf-light bg-pf-white px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
      />

      {questionType === 'MULTIPLE_CHOICE' ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium text-pf-deep/50">
            2-4 options the AI can mention conversationally (never as a literal list)
          </p>
          {choiceOptions.map((option, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={option}
                maxLength={100}
                onChange={(e) => {
                  const next = [...choiceOptions]
                  next[i] = e.target.value
                  setChoiceOptions(next)
                }}
                placeholder={`Option ${i + 1}`}
                className="min-h-10 w-full rounded-2xl border border-pf-light bg-pf-white px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              />
              {choiceOptions.length > 2 ? (
                <button
                  type="button"
                  onClick={() => setChoiceOptions(choiceOptions.filter((_, idx) => idx !== i))}
                  className="text-pf-deep/40 hover:text-rose-500"
                  aria-label="Remove option"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ))}
          {choiceOptions.length < 4 ? (
            <button
              type="button"
              onClick={() => setChoiceOptions([...choiceOptions, ''])}
              className="text-xs font-medium text-pf-accent hover:underline"
            >
              + Add option
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-medium text-pf-deep/60">
          <span>How often the AI pushes this question</span>
          <span>{intensity}/5</span>
        </div>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={intensity}
          onChange={(e) => setIntensity(Number(e.target.value))}
          className="mt-2 w-full accent-pf-accent"
        />
      </div>

      {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => void remove()}
          disabled={saving}
          className="text-xs font-medium text-rose-500 hover:underline disabled:opacity-50"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !prompt.trim()}
          className="inline-flex min-h-9 items-center rounded-full bg-pf-primary px-4 text-xs font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function NewQuestionForm({
  client,
  onCreated,
}: {
  client: ReturnType<typeof createTRPCClient>
  onCreated: (q: EngagementQuestion) => void
}) {
  const [questionType, setQuestionType] = useState<EngagementQuestionType>('OPEN_ENDED')
  const [prompt, setPrompt] = useState('')
  const [choiceOptions, setChoiceOptions] = useState<string[]>(emptyChoiceOptions())
  const [intensity, setIntensity] = useState(3)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!prompt.trim()) return
    setSaving(true)
    setError(null)
    try {
      const created = await client.engagementQuestion.create.mutate({
        questionType,
        prompt: prompt.trim(),
        choiceOptions:
          questionType === 'MULTIPLE_CHOICE'
            ? choiceOptions.filter((o) => o.trim().length > 0)
            : [],
        intensity,
      })
      onCreated({
        ...created,
        createdAt: created.createdAt.toString(),
        updatedAt: created.updatedAt.toString(),
      } as unknown as EngagementQuestion)
      setPrompt('')
      setChoiceOptions(emptyChoiceOptions())
      setIntensity(3)
      setQuestionType('OPEN_ENDED')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface p-5"
    >
      <div className="flex items-center gap-2">
        <Plus className="h-4 w-4 text-pf-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-pf-deep">Add a new question</h3>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => setQuestionType('OPEN_ENDED')}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            questionType === 'OPEN_ENDED'
              ? 'bg-pf-primary text-white'
              : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
          }`}
        >
          Open-ended
        </button>
        <button
          type="button"
          onClick={() => setQuestionType('MULTIPLE_CHOICE')}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            questionType === 'MULTIPLE_CHOICE'
              ? 'bg-pf-primary text-white'
              : 'bg-pf-white text-pf-deep/60 hover:text-pf-deep'
          }`}
        >
          Soft multiple-choice
        </button>
      </div>

      <textarea
        value={prompt}
        maxLength={500}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. Ask what the guest's favorite part of the visit was, so we can learn what resonates most."
        className="mt-4 min-h-24 w-full rounded-2xl border border-pf-light bg-pf-white px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
      />

      {questionType === 'MULTIPLE_CHOICE' ? (
        <div className="mt-3 space-y-2">
          {choiceOptions.map((option, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={option}
                maxLength={100}
                onChange={(e) => {
                  const next = [...choiceOptions]
                  next[i] = e.target.value
                  setChoiceOptions(next)
                }}
                placeholder={`Option ${i + 1}`}
                className="min-h-10 w-full rounded-2xl border border-pf-light bg-pf-white px-4 text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              />
              {choiceOptions.length > 2 ? (
                <button
                  type="button"
                  onClick={() => setChoiceOptions(choiceOptions.filter((_, idx) => idx !== i))}
                  className="text-pf-deep/40 hover:text-rose-500"
                  aria-label="Remove option"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ))}
          {choiceOptions.length < 4 ? (
            <button
              type="button"
              onClick={() => setChoiceOptions([...choiceOptions, ''])}
              className="text-xs font-medium text-pf-accent hover:underline"
            >
              + Add option
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-medium text-pf-deep/60">
          <span>How often the AI pushes this question</span>
          <span>{intensity}/5</span>
        </div>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={intensity}
          onChange={(e) => setIntensity(Number(e.target.value))}
          className="mt-2 w-full accent-pf-accent"
        />
      </div>

      {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}

      <button
        type="submit"
        disabled={saving || !prompt.trim()}
        className="mt-4 inline-flex min-h-10 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Adding...' : 'Add question'}
      </button>
    </form>
  )
}

export function EngagementQuestionsManager({
  initialMode,
  initialQuestions,
}: EngagementQuestionsManagerProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [mode, setMode] = useState<TenantEngagementMode>(initialMode)
  const [questions, setQuestions] = useState<EngagementQuestion[]>(initialQuestions)
  const [modeSaving, setModeSaving] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)

  async function handleModeChange(next: TenantEngagementMode) {
    if (next === mode) return
    setModeSaving(true)
    setModeError(null)
    try {
      await client.tenant.setEngagementMode.mutate({ mode: next })
      setMode(next)
    } catch (err) {
      setModeError(err instanceof Error ? err.message : 'Failed to update mode.')
    } finally {
      setModeSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-deep text-pf-light">
            <Flame className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">Mode</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
              How curious should the AI be?
            </h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              This applies to every active question below.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {MODE_OPTIONS.map((option) => {
            const isSelected = mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={modeSaving}
                onClick={() => void handleModeChange(option.value)}
                className={`rounded-[1.5rem] border p-5 text-left transition disabled:opacity-60 ${
                  isSelected
                    ? 'border-pf-accent bg-pf-accent/5'
                    : 'border-pf-light bg-pf-surface hover:border-pf-accent/40 hover:bg-pf-white'
                }`}
              >
                <p className="text-lg font-semibold text-pf-deep">{option.label}</p>
                <p className="mt-2 text-sm leading-6 text-pf-deep/60">{option.description}</p>
              </button>
            )
          })}
        </div>
        {modeError ? <p className="mt-4 text-sm text-rose-600">{modeError}</p> : null}
      </section>

      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-accent/10 text-pf-primary">
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              Questions
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
              Your engagement questions
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/60">
              The AI rephrases each one in its own words and picks its moment — it never reads these
              verbatim, and it won't ask every question every conversation.
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          {questions.length === 0 ? (
            <p className="text-sm text-pf-deep/40">No engagement questions yet.</p>
          ) : (
            questions.map((q) => (
              <QuestionCard
                key={q.id}
                client={client}
                question={q}
                onUpdated={(updated) =>
                  setQuestions((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
                }
                onDeleted={(id) => setQuestions((prev) => prev.filter((p) => p.id !== id))}
              />
            ))
          )}

          <NewQuestionForm
            client={client}
            onCreated={(created) => setQuestions((prev) => [...prev, created])}
          />
        </div>
      </section>
    </div>
  )
}
```

Note: `client.engagementQuestion.create.mutate` and `.update.mutate` return
`Date` objects for `createdAt`/`updatedAt` over superjson (it deserializes
Dates correctly), so the `.toString()` calls above should be replaced with
proper ISO conversion — use `created.createdAt.toISOString()` /
`created.updatedAt.toISOString()` instead of `.toString()` in
`NewQuestionForm.handleSubmit`, matching how the parent page serializes dates
in Part 11a.

---

## Tests

### `packages/api/src/lib/engagement-questions.test.ts` (new file)

Unit tests for `selectEngagementQuestion`, using the injectable `random` param
for determinism:

1. **Stoic never asks** — any `random` sequence, `mode: 'STOIC'` returns `null`.
2. **Empty question list** — returns `null` regardless of mode.
3. **Base-chance gate fails** — `random` returning a value `>=` the mode's base
   chance returns `null` without consuming a second roll.
4. **Weighted pick honors intensity** — with two questions of intensity 1 and
   4 and a `random` sequence that passes the gate then rolls near the top of
   the weighted range, assert the intensity-4 question is picked; near the
   bottom, assert the intensity-1 question is picked.

### `packages/api/src/routers/engagement-question.test.ts` (new file)

Mock `@pathfinder/db` with `vi.mock`, following the `tenant.test.ts` /
`place.ts` test conventions already in the repo:

1. **`list`** scopes by `tenantId`.
2. **`create`** rejects `MULTIPLE_CHOICE` with fewer than 2 or more than 4
   `choiceOptions` with a `BAD_REQUEST` `TRPCError`.
3. **`create`** stores an empty `choiceOptions` array for `OPEN_ENDED` even if
   the caller passed some (defense in depth — the router discards them).
4. **`update`** merges the patch with the existing record before validating
   choice-option count (e.g. patching only `intensity` on an existing
   `MULTIPLE_CHOICE` question does not spuriously fail validation).
5. **`update`/`delete`** on an `id` not owned by the caller's tenant throws
   `NOT_FOUND`.

### `packages/api/src/routers/chat.test.ts` (existing file — extend)

Add a case (or extend the existing `send` test setup) asserting:

1. When the tenant's `engagementMode` is `STOIC`, `buildVenueSystemPrompt` is
   called without an `engagementQuestion` param even if active questions
   exist for the tenant.
2. When `selectEngagementQuestion` would select a question (mock/stub it, or
   seed the `random` injection point if `chat.ts` is refactored to accept
   one), the `engagement_question.asked` analytics event fires with the
   selected question's `id`.

---

## Definition of Done

- [ ] `EngagementQuestionType` and `TenantEngagementMode` enums added to
      `schema.prisma`
- [ ] `Tenant.engagementMode` field added, defaulting to `STOIC`
- [ ] `EngagementQuestion` model added and included in `TENANTED_TABLES`
- [ ] Migration `20260702000000_add_engagement_questions` applies cleanly
- [ ] `engagementQuestion` router (`list`/`create`/`update`/`delete`)
      registered on `appRouter`, mutations gated by `requireRole('MANAGER')`
- [ ] `tenant.setEngagementMode` mutation updates the tenant's mode;
      `tenant.getSettings` returns it
- [ ] `buildVenueSystemPrompt` accepts and renders an `engagementQuestion`
      section when provided
- [ ] `chat.send` selects at most one active engagement question per turn via
      `selectEngagementQuestion`, respecting the tenant's mode and each
      question's intensity, and passes it into the system prompt
- [ ] `engagement_question.asked` added to the analytics allow-list and
      emitted best-effort (never blocks the chat response) when a question is
      selected
- [ ] Dashboard nav has an "Engagement Questions" entry
- [ ] `/engagement-questions` page renders the Stoic/Balanced/Curious
      selector and the question list/add-form
- [ ] Creating, editing (including toggling Active), and deleting a question
      works end to end from the dashboard
- [ ] Multiple-choice questions require 2-4 non-empty options; the form and
      the router both enforce this
- [ ] `pnpm typecheck` passes with no new errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes, including new tests for `selectEngagementQuestion`,
      the `engagementQuestion` router, and the chat wiring
