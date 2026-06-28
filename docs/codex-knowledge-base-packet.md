# Codex Task Packet — Venue Knowledge Base

> **Audience:** ChatGPT Codex.
> **Source of truth for current architecture:** `docs/codebase-overview.md` and the real code.
> Read this packet fully before writing a single line. The implementation mirrors an existing
> system (place embeddings) almost exactly — understand that system first, then replicate it.

---

## What you are building

Venues currently answer guest questions using **Places** (physical locations embedded with pgvector
and retrieved by cosine similarity at query time). This works great for location-aware venues but
leaves non-location venues with no way to add freeform knowledge — FAQs, policies, procedures,
descriptions, history, anything text-based that isn't a physical place.

You are adding a **VenueKnowledgeEntry** model: titled, categorised text entries per venue that
are embedded into pgvector on save and retrieved semantically at chat time, injected alongside
relevant places into the AI system prompt. The retrieval path is **identical** to how places work
today — read `packages/api/src/routers/chat.ts` and `packages/db/src/helpers/semantic-search.ts`
before writing anything.

**Scale goal:** hundreds of entries per venue. Do not dump all entries into the prompt. Retrieve
only the top-N most semantically relevant entries per query, exactly as places are retrieved.

---

## Coordination boundaries — do not touch

- `apps/admin/**` — leave entirely alone.
- `packages/api/src/routers/admin/**` — leave alone.
- `packages/api/src/lib/rate-limit.ts` — leave alone.
- `packages/config/src/env.ts` — leave alone.

---

## Verification (run after every step)

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

All must be clean before moving to the next step.

---

## Step 1 — Prisma schema + migration

### 1a. Add the model to `packages/db/prisma/schema.prisma`

Add the following model after the `Place` model (after line 189). Do not add an `embedding`
field in Prisma — pgvector's `vector` type is `Unsupported` and the column is managed via raw SQL
migrations and helpers, exactly like `Place`.

```prisma
model VenueKnowledgeEntry {
  id        String   @id @default(cuid())
  tenantId  String   @map("tenant_id")
  venueId   String   @map("venue_id")
  title     String
  category  String
  content   String
  isEnabled Boolean  @default(true) @map("is_enabled")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  venue     Venue    @relation(fields: [venueId], references: [id], onDelete: Restrict)

  @@index([tenantId])
  @@index([venueId])
  @@map("venue_knowledge_entries")
}
```

Also add the relation back-reference on the `Venue` model (after the `questionClusters` line):

```prisma
  knowledgeEntries VenueKnowledgeEntry[]
```

### 1b. Create the migration

Create file `packages/db/prisma/migrations/20260628000000_add_venue_knowledge_entries/migration.sql`:

```sql
-- Migration: venue knowledge entries
-- Adds the venue_knowledge_entries table with a pgvector embedding column for
-- semantic retrieval, mirroring the pattern used by places/005_place_embeddings.

CREATE TABLE "venue_knowledge_entries" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "tenant_id"  TEXT NOT NULL,
  "venue_id"   TEXT NOT NULL,
  "title"      TEXT NOT NULL,
  "category"   TEXT NOT NULL,
  "content"    TEXT NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "venue_knowledge_entries_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "venue_knowledge_entries_tenant_id_idx" ON "venue_knowledge_entries"("tenant_id");
CREATE INDEX "venue_knowledge_entries_venue_id_idx"  ON "venue_knowledge_entries"("venue_id");

-- pgvector extension is already enabled by migration 005_place_embeddings.
-- Add the embedding column — nullable so existing rows are not blocked.
ALTER TABLE "venue_knowledge_entries" ADD COLUMN "embedding" vector(1536);

-- HNSW index for fast approximate nearest-neighbour search (cosine distance).
CREATE INDEX IF NOT EXISTS knowledge_embedding_hnsw_idx
  ON "venue_knowledge_entries"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

Also add an entry to `packages/db/prisma/migrations/migration_lock.toml` — follow the existing
format: append `"20260628000000_add_venue_knowledge_entries"` to the applied migrations list.

---

## Step 2 — Tenanted tables list

Add `'VenueKnowledgeEntry'` to the `TENANTED_TABLES` array in
`packages/db/src/tenanted-tables.ts`. Place it after `'Place'`.

---

## Step 3 — DB helpers

### 3a. `searchKnowledgeByEmbedding` in `packages/db/src/helpers/semantic-search.ts`

Add after `storePlaceEmbedding`. Pattern is identical to `searchPlacesByEmbedding` — raw SQL
required because of the `<=>` pgvector operator. `tenant_id` must be explicitly bound.

```ts
export type SemanticKnowledgeEntry = {
  id: string
  title: string
  category: string
  content: string
  distance: number
}

type RawKnowledgeRow = {
  id: string
  title: string
  category: string
  content: string
  distance: number
}

const KNOWLEDGE_DEFAULT_LIMIT = 5

/**
 * Searches knowledge entries by cosine similarity against a pre-computed query embedding.
 *
 * Raw SQL required: pgvector cosine similarity operator (<=>).
 * tenant_id is explicitly bound — isolation is manual here since $queryRaw bypasses
 * the Prisma middleware.
 */
export async function searchKnowledgeByEmbedding(params: {
  queryEmbedding: number[]
  venueId: string
  tenantId: string
  limit?: number
}): Promise<SemanticKnowledgeEntry[]> {
  const { queryEmbedding, venueId, tenantId, limit = KNOWLEDGE_DEFAULT_LIMIT } = params

  const vectorStr = `[${queryEmbedding.join(',')}]`
  const limitSafe = Math.max(1, Math.min(20, Math.floor(limit)))

  const rows = await db.$queryRaw<RawKnowledgeRow[]>`
    SELECT
      id,
      title,
      category,
      content,
      embedding <=> ${vectorStr}::vector AS distance
    FROM venue_knowledge_entries
    WHERE venue_id   = ${venueId}
      AND tenant_id  = ${tenantId}
      AND is_enabled = true
      AND embedding  IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limitSafe}
  `

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    content: row.content,
    distance: Number(row.distance),
  }))
}

/**
 * Stores a pre-computed embedding vector for a knowledge entry.
 *
 * Raw SQL required: vector(1536) is unsupported by Prisma's typed API.
 * The entryId must have been obtained from a prior tenant-isolated query.
 */
export async function storeKnowledgeEntryEmbedding(
  entryId: string,
  embedding: number[],
): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .$executeRaw`UPDATE venue_knowledge_entries SET embedding = ${vectorStr}::vector WHERE id = ${entryId}`
}
```

### 3b. Export the new helpers from `packages/db/src/index.ts`

Find where `searchPlacesByEmbedding` and `storePlaceEmbedding` are exported and add the new
helpers alongside them:

```ts
export {
  searchPlacesByEmbedding,
  storePlaceEmbedding,
  searchKnowledgeByEmbedding,
  storeKnowledgeEntryEmbedding,
  type SemanticKnowledgeEntry,
} from './helpers/semantic-search'
```

### 3c. `generateAndStoreKnowledgeEntryEmbedding` in `packages/db/src/helpers/embeddings.ts`

Add after `generateAndStorePlaceEmbedding`, following its exact pattern:

```ts
export async function generateAndStoreKnowledgeEntryEmbedding(entry: {
  id: string
  title: string
  category: string
  content: string
}): Promise<void> {
  const text = [entry.title, entry.category, entry.content].filter(Boolean).join('. ')
  const embedding = await generateEmbedding(text)
  await storeKnowledgeEntryEmbedding(entry.id, embedding)
}
```

You will need to import `storeKnowledgeEntryEmbedding` at the top of `embeddings.ts`. Currently
it imports `storePlaceEmbedding` from `./semantic-search` — add `storeKnowledgeEntryEmbedding`
to that same import.

Also export `generateAndStoreKnowledgeEntryEmbedding` from `packages/db/src/index.ts`.

---

## Step 4 — Job infrastructure

All four files follow the existing pattern exactly. Read the existing embed-place files before
writing.

### 4a. `packages/jobs/src/queues.ts`

Add three constants after the `EMBED_PLACE_*` block:

```ts
export const EMBED_KNOWLEDGE_ENTRY_QUEUE = 'embed-knowledge-entry'
export const EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB = 'embed-knowledge-entry-process'
export const EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF = 'embed-knowledge-entry-retry'
```

### 4b. `packages/jobs/src/types.ts`

Add after `EmbedPlaceJobPayload`:

```ts
export type EmbedKnowledgeEntryJobPayload = {
  entryId: string
  tenantId: string
}
```

### 4c. `packages/jobs/src/enqueue.ts`

Add after `enqueueEmbedPlace`. Mirror it exactly — same options, same try/catch pattern used
in the tRPC layer is up to the caller:

```ts
const embedKnowledgeEntryJobOptions: JobsOptions = {
  attempts: 6,
  backoff: {
    type: EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
}

export async function enqueueEmbedKnowledgeEntry(
  payload: EmbedKnowledgeEntryJobPayload,
): Promise<void> {
  await getQueue(EMBED_KNOWLEDGE_ENTRY_QUEUE).add(EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB, payload, {
    ...embedKnowledgeEntryJobOptions,
    jobId: `embed-knowledge-entry:${payload.entryId}`,
  })

  logger.info({
    action: 'jobs.embed-knowledge-entry.enqueued',
    tenantId: payload.tenantId,
    entryId: payload.entryId,
  })
}
```

Import the new queue constants and payload type at the top of `enqueue.ts` alongside the
existing embed-place imports.

Also export `enqueueEmbedKnowledgeEntry` and `EmbedKnowledgeEntryJobPayload` from
`packages/jobs/src/index.ts`.

---

## Step 5 — Worker processor

### 5a. New file `apps/workers/src/processors/embed-knowledge-entry.ts`

Mirror `embed-place.ts` exactly. The only differences are: field names, the DB model
(`venueKnowledgeEntry` instead of `place`), and the embedding helper.

```ts
import { logger } from '@pathfinder/config'
import {
  db,
  generateAndStoreKnowledgeEntryEmbedding,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import type { EmbedKnowledgeEntryJobPayload } from '@pathfinder/jobs'

export async function processEmbedKnowledgeEntryJob(
  payload: EmbedKnowledgeEntryJobPayload,
  bullJobId?: string | null,
): Promise<void> {
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: 'embed-knowledge-entry',
    jobName: 'embed-knowledge-entry-process',
    bullJobId: bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload: payload as unknown as Record<string, unknown>,
    startedAt,
  })

  try {
    const entry = await withTenantIsolationBypass(async () =>
      db.venueKnowledgeEntry.findFirst({
        where: {
          id: payload.entryId,
          tenantId: payload.tenantId,
          isEnabled: true,
        },
        select: {
          id: true,
          title: true,
          category: true,
          content: true,
        },
      }),
    )

    if (!entry) {
      throw new Error(`VenueKnowledgeEntry ${payload.entryId} not found`)
    }

    await generateAndStoreKnowledgeEntryEmbedding(entry)
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })

    logger.info({
      action: 'workers.embed-knowledge-entry.completed',
      tenantId: payload.tenantId,
      entryId: payload.entryId,
    })
  } catch (error) {
    await updateJobRecord(jobRecordId, {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Unknown embed knowledge entry error',
    })

    logger.error({
      action: 'workers.embed-knowledge-entry.failed',
      tenantId: payload.tenantId,
      entryId: payload.entryId,
      error: error instanceof Error ? error.message : 'Unknown embed knowledge entry error',
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })

    throw error
  }
}
```

### 5b. Register the worker in `apps/workers/src/index.ts`

**Imports to add** at the top alongside the existing embed-place imports:

```ts
import {
  EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  EMBED_KNOWLEDGE_ENTRY_RETRY_BACKOFF,
  type EmbedKnowledgeEntryJobPayload,
} from '@pathfinder/jobs'
import { processEmbedKnowledgeEntryJob } from './processors/embed-knowledge-entry'
```

**Backoff function** — add after `getEmbedPlaceBackoffDelay`, following the identical shape:

```ts
function getEmbedKnowledgeEntryBackoffDelay(attemptsMade: number): number {
  switch (attemptsMade) {
    case 1:
      return 30_000
    case 2:
      return 60_000
    case 3:
      return 5 * 60_000
    case 4:
      return 30 * 60_000
    case 5:
      return 2 * 60 * 60_000
    default:
      return -1
  }
}
```

**Worker registration** — find where the `EMBED_PLACE_QUEUE` worker is registered and add an
analogous block immediately after it, following the same `Worker` constructor pattern with
`concurrency`, `connection`, backoff strategy, and shutdown registration.

The worker processes `EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB` jobs using
`processEmbedKnowledgeEntryJob`. It is enqueue-driven (no cron scheduler). No `Queue` object
needed for this worker (no scheduling, only processing).

Look at how `EMBED_PLACE_QUEUE` is registered — the knowledge entry worker follows the exact
same structure.

---

## Step 6 — tRPC knowledge router

### 6a. New file `packages/api/src/routers/knowledge.ts`

```ts
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config/logger'
import { db } from '@pathfinder/db'
import { enqueueEmbedKnowledgeEntry } from '@pathfinder/jobs'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

const knowledgeEntrySelect = {
  id: true,
  tenantId: true,
  venueId: true,
  title: true,
  category: true,
  content: true,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const

async function assertVenueBelongsToTenant(venueId: string, tenantId: string): Promise<void> {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  })
  if (!venue) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  }
}

async function enqueueKnowledgeEmbedding(payload: {
  entryId: string
  tenantId: string
}): Promise<void> {
  try {
    await enqueueEmbedKnowledgeEntry(payload)
  } catch (err) {
    logger.warn({
      action: 'knowledge.embed.enqueue.failed',
      tenantId: payload.tenantId,
      entryId: payload.entryId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export const CreateKnowledgeEntryInput = z.object({
  venueId: z.string().min(1),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  isEnabled: z.boolean().default(true),
})

export const UpdateKnowledgeEntryInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(5000).optional(),
  isEnabled: z.boolean().optional(),
})

export const knowledgeRouter = router({
  list: tenantProcedure
    .input(z.object({ venueId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await assertVenueBelongsToTenant(input.venueId, ctx.tenantId)
      return ctx.db.venueKnowledgeEntry.findMany({
        where: { venueId: input.venueId, tenantId: ctx.tenantId },
        select: knowledgeEntrySelect,
        orderBy: { createdAt: 'asc' },
      })
    }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreateKnowledgeEntryInput)
    .mutation(async ({ ctx, input }) => {
      await assertVenueBelongsToTenant(input.venueId, ctx.tenantId)
      const entry = await ctx.db.venueKnowledgeEntry.create({
        data: {
          tenantId: ctx.tenantId,
          venueId: input.venueId,
          title: input.title,
          category: input.category,
          content: input.content,
          isEnabled: input.isEnabled,
        },
        select: knowledgeEntrySelect,
      })
      await enqueueKnowledgeEmbedding({ entryId: entry.id, tenantId: ctx.tenantId })
      return entry
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateKnowledgeEntryInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.venueKnowledgeEntry.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
        select: { id: true, venueId: true },
      })
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge entry not found' })
      }
      const entry = await ctx.db.venueKnowledgeEntry.update({
        where: { id: input.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        },
        select: knowledgeEntrySelect,
      })
      // Re-embed when content changes
      if (
        input.title !== undefined ||
        input.category !== undefined ||
        input.content !== undefined
      ) {
        await enqueueKnowledgeEmbedding({ entryId: entry.id, tenantId: ctx.tenantId })
      }
      return entry
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.venueKnowledgeEntry.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
        select: { id: true },
      })
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge entry not found' })
      }
      await ctx.db.venueKnowledgeEntry.delete({ where: { id: input.id } })
      return { id: input.id }
    }),
})
```

### 6b. Register in `packages/api/src/root.ts`

Import and add `knowledge: knowledgeRouter` to the `appRouter` object, alongside the existing
routers.

### 6c. Export input types from `packages/api/src/index.ts`

Add alongside the existing place/venue exports:

```ts
export { CreateKnowledgeEntryInput, UpdateKnowledgeEntryInput } from './routers/knowledge'
```

---

## Step 7 — Wire knowledge retrieval into the chat pipeline

### 7a. Update `packages/api/src/lib/venue-context.ts`

Add a new parameter type and a new section in `buildVenueSystemPrompt`.

**Add the type** near the top of the file:

```ts
type KnowledgeEntry = {
  title: string
  category: string
  content: string
}
```

**Update `buildVenueSystemPrompt` signature** — add `knowledgeEntries` to the params object:

```ts
export function buildVenueSystemPrompt(params: {
  venue: VenueInfo
  relevantPlaces: RelevantPlace[]
  knowledgeEntries: KnowledgeEntry[]   // ← add this
  userLat: number
  userLng: number
  featuredPlace?: FeaturedPlace | null
  language?: string | null
  guideMode?: string | null
}): string {
```

**Destructure it** at the top of the function body:

```ts
const { venue, relevantPlaces, featuredPlace, language, knowledgeEntries } = params
```

**Build a knowledge section** after `placesSection`:

```ts
const knowledgeSection =
  knowledgeEntries.length === 0
    ? ''
    : `\n\nKNOWLEDGE BASE:\n${knowledgeEntries
        .map((e) => `[${e.category}] ${e.title}\n${e.content}`)
        .join('\n\n')}`
```

**Inject it into the returned prompt string** — place it between the places section and the
Rules block. Find this line in the return template:

```ts
return `You are ${guideName}, ${roleDescription} for ${venue.name}.

About this venue:
${venueDescription}${guideNotesSection}${operatorGuidanceSection}${featuredPlaceSection}

MOST RELEVANT PLACES FOR THIS QUERY:
${placesSection}

Rules:
```

Change to:

```ts
return `You are ${guideName}, ${roleDescription} for ${venue.name}.

About this venue:
${venueDescription}${guideNotesSection}${operatorGuidanceSection}${featuredPlaceSection}

MOST RELEVANT PLACES FOR THIS QUERY:
${placesSection}${knowledgeSection}

Rules:
```

Also add a rule inside the Rules block (after the "Ground every answer" rule):

```
- Ground answers in the knowledge base entries above when relevant. Treat them as authoritative venue information.
```

### 7b. Update `packages/api/src/routers/chat.ts`

**Add import** at the top alongside the existing `@pathfinder/db` import:

```ts
import { searchPlacesByEmbedding, searchKnowledgeByEmbedding } from '@pathfinder/db'
```

**Add constant** near `NEAREST_PLACES_LIMIT`:

```ts
const KNOWLEDGE_ENTRIES_LIMIT = 5
```

**Retrieve knowledge entries** — in section 4 of the `send` procedure (after relevant places
are resolved, before building the system prompt). Add a parallel fetch alongside or just after
the places retrieval:

```ts
// 4b. Retrieve relevant knowledge entries (semantic, same embedding as places query).
//     Falls back to empty array if no embedding or no entries — never blocks the response.
const relevantKnowledgeEntries = queryEmbedding
  ? await searchKnowledgeByEmbedding({
      queryEmbedding,
      venueId: input.venueId,
      tenantId: venue.tenantId,
      limit: KNOWLEDGE_ENTRIES_LIMIT,
    }).catch(() => [])
  : []
```

**Pass to `buildVenueSystemPrompt`** — add `knowledgeEntries: relevantKnowledgeEntries` to the
call at line ~310:

```ts
const systemPrompt = buildVenueSystemPrompt({
  venue,
  relevantPlaces,
  knowledgeEntries: relevantKnowledgeEntries, // ← add this
  userLat: contextLat,
  userLng: contextLng,
  featuredPlace,
  ...(input.language ? { language: input.language } : {}),
  guideMode,
})
```

---

## Step 8 — Dashboard UI

Create a new page and supporting client component so operators can manage knowledge entries.

### 8a. New page `apps/dashboard/app/(app)/venues/[venueId]/knowledge/page.tsx`

This is a server component that loads the entry list and renders the client component.

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { KnowledgeManager } from '../../../../../../components/KnowledgeManager'

type KnowledgePageProps = {
  params: Promise<{ venueId: string }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues/knowledge'),
  })
  return appRouter.createCaller(ctx)
}

export default async function KnowledgePage({ params }: KnowledgePageProps) {
  const { venueId } = await params
  const caller = await createCaller()

  try {
    const [venue, entries] = await Promise.all([
      caller.venue.getById({ id: venueId }),
      caller.knowledge.list({ venueId }),
    ])

    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <Link
            href={`/venues/${venueId}`}
            className="text-sm font-medium text-pf-primary hover:text-pf-accent"
          >
            ← Back to venue
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-pf-text">Knowledge Base</h1>
            <p className="mt-1 text-sm text-pf-muted">
              {venue.name} — entries are embedded and retrieved semantically at chat time.
            </p>
          </div>
          <KnowledgeManager venueId={venueId} initialEntries={entries} />
        </div>
      </main>
    )
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      notFound()
    }
    throw error
  }
}
```

### 8b. New client component `apps/dashboard/components/KnowledgeManager.tsx`

This component owns the full create/edit/delete flow. Use the existing styling conventions
from the dashboard (`pf-*` classes, same form patterns as `PlaceForm.tsx`). Use
`api.knowledge.*` tRPC hooks.

The component should:

1. **List view** — show all entries in a table with columns: Title, Category, Enabled (toggle),
   Actions (Edit / Delete). Empty state: "No knowledge entries yet."
2. **Create form** — inline or modal form with fields: Title (text), Category (text with
   suggestions: FAQ, Policy, History, Services, Hours, Accessibility — but free text is fine),
   Content (textarea, max 5000 chars), Enabled (checkbox, default true). Submit calls
   `api.knowledge.create.mutate(...)` then refreshes the list.
3. **Edit** — clicking Edit opens the same form pre-filled. Submit calls
   `api.knowledge.update.mutate(...)`.
4. **Delete** — Delete button with a confirm step (simple `window.confirm` or a small inline
   confirm UI). Calls `api.knowledge.delete.mutate({ id })`.
5. **Embedding status note** — below the form or list, show a small info note:
   "Entries are embedded in the background after saving. New entries become searchable within
   seconds."

Match the visual style of `PlaceForm.tsx` and the places list on the venue detail page. Use
`useState` for form/edit state and `useRouter().refresh()` after mutations to re-fetch server
data.

### 8c. Add a link to the knowledge page from the venue detail

In `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`, find the section links or action area
and add a link to `/venues/${venueId}/knowledge`. Follow the same link style already used on
that page.

---

## Step 9 — Tests

Add tests covering the new behavior. Follow existing test patterns in the repo.

### 9a. Knowledge router unit tests

Add `packages/api/src/routers/__tests__/knowledge.test.ts` (or follow whatever test file
naming convention exists nearby).

Cover:

- `knowledge.list` returns only entries belonging to the caller's tenant + venue.
- `knowledge.create` creates an entry and calls `enqueueEmbedKnowledgeEntry` (mock the job).
- `knowledge.create` with a venueId belonging to a different tenant throws `NOT_FOUND`.
- `knowledge.update` re-enqueues when content fields change; does not enqueue for `isEnabled`-only changes.
- `knowledge.delete` throws `NOT_FOUND` for cross-tenant IDs.

### 9b. Embedding helper unit tests

If `generateAndStorePlaceEmbedding` has a test, mirror it for `generateAndStoreKnowledgeEntryEmbedding`.

### 9c. Semantic search test

If `searchPlacesByEmbedding` has a test, mirror it for `searchKnowledgeByEmbedding`.

---

## Step 10 — Final check

Run from repo root:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

All clean. Then verify:

- [ ] `knowledge.list` / `create` / `update` / `delete` procedures work end-to-end.
- [ ] `apps/workers` does **not** import `@pathfinder/api` (check with `grep -r "@pathfinder/api" apps/workers`).
- [ ] `tenant_id` is explicitly bound in every raw SQL query in the new helpers.
- [ ] `VenueKnowledgeEntry` is in `TENANTED_TABLES`.
- [ ] The migration is forward-only and does not touch any existing table.

---

## Commit message

```
feat(knowledge): add venue knowledge base with semantic retrieval

Adds VenueKnowledgeEntry — per-venue knowledge entries (title, category,
content, enabled) embedded asynchronously via a new embed-knowledge-entry
BullMQ worker and retrieved at chat time by cosine similarity, injected
into the AI system prompt alongside relevant places.
```
