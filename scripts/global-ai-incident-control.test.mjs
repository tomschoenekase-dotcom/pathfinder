import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = (relative) => readFile(path.join(root, relative), 'utf8')

function variableInitializer(sourceText, variableName) {
  const sourceFile = ts.createSourceFile(
    'source.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName) {
        return declaration.initializer
      }
    }
  }
  return undefined
}

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
  const admittedChatProcedure = variableInitializer(chat, 'admittedChatSendProcedure')
  assert.ok(
    admittedChatProcedure &&
      ts.isCallExpression(admittedChatProcedure) &&
      ts.isPropertyAccessExpression(admittedChatProcedure.expression) &&
      admittedChatProcedure.expression.name.text === 'use' &&
      admittedChatProcedure.arguments.length === 1 &&
      ts.isIdentifier(admittedChatProcedure.arguments[0]) &&
      admittedChatProcedure.arguments[0].text === 'requireGlobalAi',
    'the admitted chat procedure must end with requireGlobalAi',
  )

  const chatRouter = variableInitializer(chat, 'chatRouter')
  assert.ok(
    chatRouter &&
      ts.isCallExpression(chatRouter) &&
      ts.isObjectLiteralExpression(chatRouter.arguments[0]),
    'chatRouter must be constructed from an object literal',
  )
  const sendProperty = chatRouter.arguments[0].properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'send') ||
        (ts.isStringLiteral(property.name) && property.name.text === 'send')),
  )
  assert.ok(
    sendProperty &&
      ts.isPropertyAssignment(sendProperty) &&
      ts.isCallExpression(sendProperty.initializer) &&
      ts.isPropertyAccessExpression(sendProperty.initializer.expression) &&
      sendProperty.initializer.expression.name.text === 'mutation' &&
      ts.isIdentifier(sendProperty.initializer.expression.expression) &&
      sendProperty.initializer.expression.expression.text === 'admittedChatSendProcedure',
    'chat send must mutate through the admitted public procedure',
  )
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
    'apps/workers/src/processors/weekly-digest.ts',
    'apps/workers/src/processors/weekly-report.ts',
  ]
  for (const file of callers) {
    const text = await source(file)
    assert.match(text, /admissionGuard/u, `${file} must supply provider admission`)
  }
})

test('direct provider calls admit before budget reservation or dispatch', async () => {
  const [budget, media] = await Promise.all([
    source('apps/workers/src/lib/media-provider-budget.ts'),
    source('apps/workers/src/processors/media-ingestion.ts'),
  ])

  assert.match(
    budget,
    /await admit\(\)\s*await reserve\(\)\s*assertActive\?\.\(\)\s*[\s\S]*?await admit\(\)\s*assertActive\?\.\(\)\s*return operation\(\)/u,
  )
  assert.equal([...media.matchAll(/executeMediaProviderOperation\(\s*admissionGuard/gu)].length, 4)
  assert.match(
    media,
    /const venueAdmission = \(\) =>\s*assertVenueAiAvailable\(db, \{\s*tenantId: payload\.tenantId,\s*venueId: payload\.venueId/u,
  )
})

test('every venue-scoped AI caller uses combined global and venue admission', async () => {
  const venueScopedCallers = [
    'packages/api/src/routers/chat.ts',
    'packages/api/src/routers/venue-package.ts',
    'apps/workers/src/processors/analytics-enrichment.ts',
    'apps/workers/src/processors/answer-analysis.ts',
    'apps/workers/src/processors/embed-knowledge-entry.ts',
    'apps/workers/src/processors/embed-place.ts',
    'apps/workers/src/processors/media-ingestion.ts',
    'apps/workers/src/processors/weekly-report.ts',
  ]

  for (const file of venueScopedCallers) {
    const text = await source(file)
    assert.match(text, /assertVenueAiAvailable/u, `${file} must enforce venue availability`)
  }

  const digest = await source('apps/workers/src/processors/weekly-digest.ts')
  assert.match(digest, /assertGlobalAiAvailable/u)
  assert.doesNotMatch(digest, /assertVenueAiAvailable/u)
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
