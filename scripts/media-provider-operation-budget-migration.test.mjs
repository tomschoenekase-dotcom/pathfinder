import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const schema = await readFile(
  new URL('../packages/db/prisma/schema.prisma', import.meta.url),
  'utf8',
)
const migration = await readFile(
  new URL(
    '../packages/db/prisma/migrations/20260809130000_add_media_provider_operation_budget/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const beginUpload = await readFile(
  new URL('../packages/api/src/routers/admin/media-ingestion-begin-upload.ts', import.meta.url),
  'utf8',
)
const processor = await readFile(
  new URL('../apps/workers/src/processors/media-ingestion.ts', import.meta.url),
  'utf8',
)
const budget = await readFile(
  new URL('../apps/workers/src/lib/media-provider-budget.ts', import.meta.url),
  'utf8',
)
const mediaGateway = await readFile(
  new URL('../packages/ai/src/openai-media.ts', import.meta.url),
  'utf8',
)
const costBudgetApi = await readFile(
  new URL('../packages/api/src/routers/admin/cost-budget.ts', import.meta.url),
  'utf8',
)
const costBudgetForm = await readFile(
  new URL('../apps/dashboard/components/admin/AdminAiCostBudgetForm.tsx', import.meta.url),
  'utf8',
)
const envSchema = await readFile(new URL('../packages/config/src/env.ts', import.meta.url), 'utf8')

test('media provider-operation migration is atomic and database bounded', () => {
  assert.match(migration, /^BEGIN;/u)
  assert.match(migration, /ADD COLUMN "provider_operation_count" INTEGER NOT NULL DEFAULT 0/u)
  assert.match(
    migration,
    /CHECK \("provider_operation_count" >= 0 AND "provider_operation_count" <= 10000\)/u,
  )
  assert.match(migration, /COMMIT;\s*$/u)
  assert.match(
    schema,
    /providerOperationCount\s+Int\s+@default\(0\) @map\("provider_operation_count"\)/u,
  )
})

test('new upload generations reset the durable count while resumable replay returns first', () => {
  const normalized = beginUpload.replace(/\r\n/gu, '\n')
  const replayReturn = normalized.indexOf('return {\n          partSize: MEDIA_UPLOAD_PART_SIZE')
  const reset = normalized.indexOf('providerOperationCount: 0')
  assert.ok(replayReturn >= 0 && reset > replayReturn)
  assert.equal(normalized.match(/providerOperationCount: 0/gu)?.length, 1)
  assert.match(normalized, /project\.uploadAttemptId === input\.uploadAttemptId/u)
})

test('every direct media provider dispatch is wrapped by a durable pre-dispatch reservation', () => {
  assert.match(
    budget,
    /await admit\(\)\s+await reserve\(\)\s+assertActive\?\.\(\)[\s\S]*?await admit\(\)\s+assertActive\?\.\(\)\s+return operation\(\)/u,
  )
  assert.match(budget, /MAX_MEDIA_PROVIDER_OPERATIONS = 10_000/u)
  assert.match(processor, /const MAX_FILES = 10_000/u)
  assert.equal(processor.match(/executeMediaProviderOperation\(/gu)?.length, 4)
  assert.equal(processor.match(/createOpenAiMediaJson\(\{/gu)?.length, 3)
  assert.equal(processor.match(/transcribeOpenAiMedia\(\{/gu)?.length, 1)
  assert.doesNotMatch(processor, /from ['"]openai['"]/u)
  assert.match(mediaGateway, /new OpenAI\(\{ apiKey, maxRetries: 0 \}\)/u)
  assert.equal(mediaGateway.match(/chat\.completions\.create\(/gu)?.length, 1)
  assert.equal(mediaGateway.match(/audio\.transcriptions\.create\(/gu)?.length, 1)
  assert.match(processor, /if \(error instanceof UnrecoverableError\) throw error/gu)
})

test('media jobs resolve only reviewed model identifiers before source processing', () => {
  assert.match(mediaGateway, /OPENAI_MEDIA_JSON_MODEL = 'gpt-5\.6-luna' as const/u)
  assert.match(
    mediaGateway,
    /OPENAI_MEDIA_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe' as const/u,
  )
  assert.match(envSchema, /MEDIA_ANALYSIS_MODEL: z\.literal\('gpt-5\.6-luna'\)\.optional\(\)/u)
  assert.match(
    envSchema,
    /MEDIA_TRANSCRIPTION_MODEL: z\.literal\('gpt-4o-mini-transcribe'\)\.optional\(\)/u,
  )
  assert.doesNotMatch(processor, /gpt-5-mini-2025-08-07/u)
  assert.equal(processor.match(/createWorkerAiUsageSink\(\{/gu)?.length, 1)
  assert.equal(processor.match(/usageSink,/gu)?.length, 9)
  assert.equal(processor.match(/createWorkerAiBudgetGate\(\{/gu)?.length, 1)
  assert.equal(processor.match(/budgetGate,/gu)?.length, 9)
  assert.match(mediaGateway, /OPENAI_MEDIA_PRICING_VERSION = 'openai-public-2026-09-01'/u)
  assert.match(mediaGateway, /OPENAI_MEDIA_JSON_ATTEMPT_CEILING_UNITS/u)
  assert.match(mediaGateway, /OPENAI_MEDIA_TRANSCRIPTION_ATTEMPT_CEILING_UNITS/u)
  assert.equal(mediaGateway.match(/budgetGate\.reserve\(\{/gu)?.length, 2)
  assert.equal(mediaGateway.match(/budgetGate\.markDispatched\(reservation\)/gu)?.length, 2)
  assert.equal(mediaGateway.match(/budgetGate\.settleExact\(/gu)?.length, 2)
  assert.equal(mediaGateway.match(/budgetGate\.settleAmbiguous\(reservation\)/gu)?.length, 2)
  assert.match(mediaGateway, /max_completion_tokens: OPENAI_MEDIA_JSON_MAX_OUTPUT_TOKENS/u)
  assert.match(mediaGateway, /success: false/gu)
  assert.match(costBudgetApi, /excludedProviderPaths: \[\] as const/u)
  assert.doesNotMatch(costBudgetForm, /remain(?:s)? explicitly outside/u)

  const modelResolution = processor.indexOf('const analysisModel = resolveOpenAiMediaJsonModel')
  const sourceProcessing = processor.indexOf('await downloadAndExtract(')
  assert.ok(modelResolution >= 0 && sourceProcessing > modelResolution)
})

test('video scratch output is axis-bounded and cleaned before asset persistence', () => {
  assert.match(
    processor,
    /scale=w='min\(1600,iw\)':h='min\(2200,ih\)':force_original_aspect_ratio=decrease/u,
  )
  const scopedCleanup = processor.indexOf('withMediaGeneratedOutputDirectory(frameDir')
  const persistence = processor.indexOf('await persistMediaIngestionAsset({', scopedCleanup)
  assert.ok(scopedCleanup >= 0 && persistence > scopedCleanup)
})
