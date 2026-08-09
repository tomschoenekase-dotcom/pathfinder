import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = (relative) => readFile(path.join(root, relative), 'utf8')

test('global AI control is typed, fail-closed, and available to the admin control plane', async () => {
  const [config, db, middleware, admin] = await Promise.all([
    source('packages/config/src/incident-control.ts'),
    source('packages/db/src/helpers/incident-control.ts'),
    source('packages/api/src/middleware/require-global-ai.ts'),
    source('packages/api/src/routers/admin/incident-control.ts'),
  ])

  assert.match(config, /\.strict\(\)/u)
  assert.match(config, /paused: z\.boolean\(\)/u)
  assert.match(db, /malformed: true/u)
  assert.match(db, /global-ai-control-unavailable/u)
  assert.match(middleware, /assertGlobalAiAvailable\(ctx\.db\)/u)
  assert.match(middleware, /code: 'SERVICE_UNAVAILABLE'/u)
  assert.match(admin, /getGlobalAiControl: adminProcedure/u)
  assert.match(admin, /setGlobalAiControl: adminProcedure/u)
  assert.doesNotMatch(admin, /adminAiProcedure/u)
  assert.match(admin, /writeAuditLogStrict/u)
  assert.match(admin, /expectedUpdatedAt/u)
})

test('API authorization runs before incident admission at every AI entry point', async () => {
  const [trpc, chat, venuePackage, answer, reports, digest, media] = await Promise.all([
    source('packages/api/src/trpc.ts'),
    source('packages/api/src/routers/chat.ts'),
    source('packages/api/src/routers/venue-package.ts'),
    source('packages/api/src/routers/admin/answer-analysis.ts'),
    source('packages/api/src/routers/admin/weekly-reports.ts'),
    source('packages/api/src/routers/admin/digest.ts'),
    source('packages/api/src/routers/admin/media-ingestion-lifecycle.ts'),
  ])

  assert.match(trpc, /publicAiProcedure = publicProcedure\.use\(requireGlobalAi\)/u)
  assert.match(trpc, /adminAiProcedure = adminProcedure\.use\(requireGlobalAi\)/u)
  assert.match(chat, /send: publicAiProcedure/u)
  assert.match(
    venuePackage,
    /createDraft: tenantProcedure\s*\.use\(requireRole\('MANAGER'\)\)\s*\.use\(requireGlobalAi\)/u,
  )
  for (const adminSource of [answer, reports, digest, media]) {
    assert.match(adminSource, /adminAiProcedure/u)
  }
})

test('every shared AI gateway and production caller rechecks admission', async () => {
  const gatewayFiles = ['packages/ai/src/anthropic.ts', 'packages/ai/src/openai-embeddings.ts']
  for (const file of gatewayFiles) {
    const text = await source(file)
    assert.match(text, /for \(let attempt[\s\S]*?await params\.admissionGuard\(\)/u, file)
  }

  const callers = [
    'packages/api/src/lib/guest-query-embedding.ts',
    'packages/api/src/lib/venue-package-semantic-analysis.ts',
    'packages/api/src/routers/chat.ts',
    'apps/workers/src/processors/analytics-enrichment.ts',
    'apps/workers/src/processors/answer-analysis.ts',
    'apps/workers/src/processors/embed-knowledge-entry.ts',
    'apps/workers/src/processors/embed-place.ts',
    'apps/workers/src/processors/weekly-report.ts',
  ]
  for (const file of callers) {
    const text = await source(file)
    assert.match(text, /admissionGuard/u, `${file} must supply provider admission`)
  }
})

test('direct provider calls admit before budget reservation or dispatch', async () => {
  const [budget, media, digest] = await Promise.all([
    source('apps/workers/src/lib/media-provider-budget.ts'),
    source('apps/workers/src/processors/media-ingestion.ts'),
    source('apps/workers/src/processors/weekly-digest.ts'),
  ])

  assert.match(
    budget,
    /await admit\(\)\s*await reserve\(\)\s*assertActive\?\.\(\)\s*[\s\S]*?await admit\(\)\s*assertActive\?\.\(\)\s*return operation\(\)/u,
  )
  assert.equal(
    [...media.matchAll(/executeMediaProviderOperation\(\s*\(\) => assertGlobalAiAvailable\(db\)/gu)]
      .length,
    4,
  )
  assert.match(digest, /new Anthropic\(\{ apiKey: env\.ANTHROPIC_API_KEY, maxRetries: 0 \}\)/u)
  assert.match(
    digest,
    /await assertGlobalAiAvailable\(db\)\s*const response = await getAnthropicClient\(\)\.messages\.create/u,
  )
})

test('durable AI jobs defer while deterministic control-plane work remains available', async () => {
  const workers = await source('apps/workers/src/index.ts')
  const durableAiJobs = [
    'WEEKLY_DIGEST_PROCESS_JOB',
    'EMBED_PLACE_PROCESS_JOB',
    'EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB',
    'GENERATION_DISPATCH_KICK_JOB',
    'ANALYTICS_ENRICHMENT_PROCESS_JOB',
    'ANSWER_ANALYSIS_PROCESS_JOB',
    'ANSWER_ANALYSIS_RECOVERY_JOB',
    'WEEKLY_REPORT_PROCESS_JOB',
    'WEEKLY_REPORT_RECOVERY_JOB',
    'MEDIA_INGESTION_PROCESS_JOB',
  ]
  for (const job of durableAiJobs) {
    assert.match(
      workers,
      new RegExp(`if \\(job\\.name === ${job}\\)[\\s\\S]{0,500}?runAiJobWithIncidentControl`, 'u'),
      `${job} must retain and defer paused work`,
    )
  }

  assert.match(workers, /DAILY_ROLLUP_PROCESS_JOB[\s\S]{0,250}?processDailyRollupJob/u)
  assert.doesNotMatch(workers, /DAILY_ROLLUP_PROCESS_JOB[\s\S]{0,250}?runAiJobWithIncidentControl/u)
  assert.match(workers, /SEND_WELCOME_EMAIL_JOB[\s\S]{0,250}?processSendWelcomeEmailJob/u)
  assert.doesNotMatch(workers, /SEND_WELCOME_EMAIL_JOB[\s\S]{0,250}?runAiJobWithIncidentControl/u)
})
