import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const guardedFiles = [
  'apps/workers/src/processors/gmail-sync.ts',
  'apps/workers/src/processors/prospect-import.ts',
  'apps/dashboard/app/api/integrations/gmail/oauth/callback/route.ts',
]

test('durable CRM failure records cannot copy arbitrary exception messages', async () => {
  const root = new URL('../', import.meta.url)
  for (const relativePath of guardedFiles) {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    assert.doesNotMatch(source, /summary:[^\n]*error\.message/u)
    assert.doesNotMatch(source, /processingError:[^\n]*error\.message/u)
    assert.doesNotMatch(source, /reconciliation:[^\n]*error\.message/u)
  }

  const gmailSync = await readFile(
    new URL('apps/workers/src/processors/gmail-sync.ts', root),
    'utf8',
  )
  assert.doesNotMatch(gmailSync, /markNotificationReceipt\([^)]*detail/u)
  assert.match(gmailSync, /processingError:\s*'Gmail synchronization failed\.'/u)
})

test('durable intake and correspondence sinks reject free-form failure detail', async () => {
  const root = new URL('../', import.meta.url)
  const websiteResearch = await readFile(
    new URL('packages/api/src/lib/website-intake-research-service.ts', root),
    'utf8',
  )
  const inboundSync = await readFile(
    new URL('packages/api/src/correspondence/inbound-sync.ts', root),
    'utf8',
  )
  const inboundStore = await readFile(
    new URL('packages/api/src/correspondence/prisma-inbound-store.ts', root),
    'utf8',
  )

  assert.doesNotMatch(websiteResearch, /errorMessage:\s*message\b/u)
  assert.doesNotMatch(inboundSync, /markReceiptState\([^)]*detail/u)
  assert.doesNotMatch(inboundSync, /recordHealth\([\s\S]{0,300}\bdetail:/u)
  assert.doesNotMatch(inboundSync, /quarantine\([\s\S]{0,300}\bdetail:/u)
  assert.doesNotMatch(inboundStore, /input\.detail/u)
  assert.match(inboundStore, /healthFailureSummary\(input\.operation\)/u)
  assert.match(inboundStore, /quarantineDetail\(input\.reason\)/u)
})

test('worker runtime error streams remain code-only', async () => {
  const root = new URL('../', import.meta.url)
  for (const relativePath of [
    'apps/workers/src/crm-background.ts',
    'apps/workers/src/founder-absence-observer-runtime.ts',
    'apps/workers/src/intake-upload-verification-runtime.ts',
  ]) {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    assert.match(source, /errorCode:/u, relativePath)
    assert.doesNotMatch(source, /process\.stderr\.write\([\s\S]{0,400}\.message/u, relativePath)
    assert.doesNotMatch(source, /detail:\s*error/u, relativePath)
  }
})

test('dispatch persistence APIs have no free-form error argument', async () => {
  const root = new URL('../', import.meta.url)
  for (const relativePath of [
    'packages/db/src/helpers/embedding-dispatches.ts',
    'packages/db/src/helpers/generation-request-dispatches.ts',
  ]) {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    assert.doesNotMatch(source, /fail(?:Embedding|GenerationRequest)Dispatch[\s\S]{0,500}\berror\??:/u)
    assert.doesNotMatch(source, /lastError:\s*(?:params\.)?error/u)
  }
})

test('prospect delivery failure persistence derives detail from a bounded code', async () => {
  const root = new URL('../', import.meta.url)
  const outboxActions = await readFile(
    new URL('packages/db/src/helpers/prospect-send-outbox-actions.ts', root),
    'utf8',
  )
  const deliveryWorker = await readFile(
    new URL('apps/workers/src/processors/send-prospect-outreach.ts', root),
    'utf8',
  )

  assert.doesNotMatch(
    outboxActions,
    /recordProspectSendFailureAction[\s\S]{0,400}\bmessage:\s*string/u,
  )
  assert.doesNotMatch(outboxActions, /lastErrorMessage:\s*input\.message/u)
  assert.match(outboxActions, /lastErrorMessage:\s*failureMessage/u)
  assert.doesNotMatch(deliveryWorker, /message:\s*error\.message/u)
})

test('agent failure APIs accept only code and retry policy', async () => {
  const root = new URL('../', import.meta.url)
  for (const relativePath of [
    'packages/db/src/helpers/agent-run-execution-actions.ts',
    'packages/db/src/helpers/agent-bridge-actions.ts',
    'packages/api/src/agent-bridge/registry.ts',
    'apps/workers/src/lib/agent-bridge-runner.ts',
    'apps/workers/src/processors/agent-run.ts',
  ]) {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    assert.doesNotMatch(source, /errorMessage:\s*(?:string|error\.message|input\.errorMessage)/u)
  }

  const bridgeRunner = await readFile(
    new URL('apps/workers/src/lib/agent-bridge-runner.ts', root),
    'utf8',
  )
  const agentRunActions = await readFile(
    new URL('packages/db/src/helpers/agent-run-execution-actions.ts', root),
    'utf8',
  )
  const agentBridgeActions = await readFile(
    new URL('packages/db/src/helpers/agent-bridge-actions.ts', root),
    'utf8',
  )
  const agentRunWorker = await readFile(
    new URL('apps/workers/src/processors/agent-run.ts', root),
    'utf8',
  )
  assert.match(bridgeRunner, /durableTaskFailureCodes\.has\(error\.message\)/u)
  assert.doesNotMatch(bridgeRunner, /\^\[A-Z\]\[A-Z0-9_\][^\n]*\.test\(code\)/u)
  assert.match(agentRunActions, /errorCode:\s*AgentRunFailureCode/u)
  assert.doesNotMatch(agentRunActions, /errorCode:\s*z\.string\(\)\.regex/u)
  assert.doesNotMatch(agentRunActions, /failAgentRunExecution\([\s\S]{0,200}errorCode:\s*string/u)
  assert.doesNotMatch(agentBridgeActions, /failAgentBridgeTask\([\s\S]{0,250}errorCode:\s*string/u)
  assert.match(agentBridgeActions, /errorCode:\s*AgentRunFailureCode/u)
  assert.match(agentRunWorker, /error\.code === 'provider-connection-timeout'/u)
  assert.match(agentRunWorker, /errorCode:\s*'PROVIDER_REQUEST_FAILED'/u)
  assert.doesNotMatch(
    agentRunWorker,
    /error instanceof AiGatewayError[\s\S]{0,1500}errorCode:\s*error\.code/u,
  )
})

test('guest answer attribution failures use a finite durable code vocabulary', async () => {
  const root = new URL('../', import.meta.url)
  const actions = await readFile(
    new URL('packages/db/src/helpers/guest-answer-attribution-evaluation-actions.ts', root),
    'utf8',
  )
  const worker = await readFile(
    new URL('apps/workers/src/processors/guest-answer-attribution-evaluation.ts', root),
    'utf8',
  )

  assert.match(actions, /errorCode:\s*GuestAnswerAttributionEvaluationFailureCode/u)
  assert.match(actions, /guestAnswerAttributionEvaluationFailureCodes\.has\(input\.errorCode\)/u)
  assert.doesNotMatch(actions, /lastErrorCode:\s*input\.errorCode\.trim\(\)\.slice/u)
  assert.match(actions, /lastErrorCode:\s*'WORKER_LOST_AFTER_PROVIDER_DISPATCH'/u)
  assert.match(worker, /error\.code === 'provider-connection-timeout'/u)
  assert.match(worker, /return 'PROVIDER_REQUEST_FAILED'/u)
  assert.doesNotMatch(
    worker,
    /error instanceof AiGatewayError[\s\S]{0,1500}return error\.code/u,
  )
})

test('operational alert delivery failure state is finite and internally consistent', async () => {
  const root = new URL('../', import.meta.url)
  const actions = await readFile(
    new URL('packages/db/src/helpers/operational-event-deliveries.ts', root),
    'utf8',
  )
  const worker = await readFile(
    new URL('apps/workers/src/processors/operational-event-delivery.ts', root),
    'utf8',
  )

  assert.match(actions, /z\.discriminatedUnion\('status'/u)
  assert.match(actions, /errorCode:\s*z\.literal\('PROVIDER_FAILURE'\)/u)
  assert.match(actions, /errorCode:\s*z\.literal\('RETRY_EXHAUSTED'\)/u)
  assert.doesNotMatch(actions, /errorCode\??:\s*string/u)
  assert.match(worker, /errorCode:\s*'PROVIDER_FAILURE'/u)
  assert.match(worker, /errorCode:\s*'RETRY_EXHAUSTED'/u)
})

test('evaluation result terminal codes are finite and outcome-specific', async () => {
  const root = new URL('../', import.meta.url)
  const results = await readFile(
    new URL('packages/db/src/helpers/evaluation-results.ts', root),
    'utf8',
  )
  const worker = await readFile(
    new URL('apps/workers/src/processors/evaluation-run.ts', root),
    'utf8',
  )

  assert.match(results, /outcome:\s*'OPERATIONAL_FAILURE'[\s\S]{0,150}PROVIDER_COST_INVARIANT/u)
  assert.match(results, /outcome:\s*'ADMISSION_DEFERRED'[\s\S]{0,100}VENUE_AI_PAUSED/u)
  assert.match(results, /outcome:\s*'BUDGET_BLOCKED'[\s\S]{0,100}RUN_BUDGET_CEILING/u)
  assert.match(results, /outcome:\s*'CANCELLED'[\s\S]{0,100}RUN_CANCELLED/u)
  assert.doesNotMatch(results, /outcome:\s*OperationalOutcome[\s\S]{0,100}errorCode:\s*string/u)
  assert.match(worker, /function persistedTerminalEvidence/u)
})

test('venue duplicate-analysis receipts normalize provider failure codes', async () => {
  const root = new URL('../', import.meta.url)
  const router = await readFile(
    new URL('packages/api/src/routers/venue-package.ts', root),
    'utf8',
  )

  assert.match(router, /type DuplicateAnalysisFailureCode/u)
  assert.match(router, /return 'provider-request-failed'/u)
  assert.match(router, /providerFailureCode\(error\)/u)
  assert.doesNotMatch(
    router,
    /error instanceof AiGatewayError[\s\S]{0,300}\? error\.code/u,
  )
  assert.doesNotMatch(router, /settleFailure[^\n]*errorCode:\s*string/u)
})

test('evaluation run attempt failure persistence admits only its production code', async () => {
  const root = new URL('../', import.meta.url)
  const lifecycle = await readFile(
    new URL('packages/db/src/helpers/evaluation-run-lifecycle.ts', root),
    'utf8',
  )

  assert.match(lifecycle, /type EvaluationRunAttemptFailureCode = 'EVALUATION_EXECUTION_FAILED'/u)
  assert.match(lifecycle, /scope\.errorCode !== 'EVALUATION_EXECUTION_FAILED'/u)
  assert.doesNotMatch(lifecycle, /errorCode:\s*string/u)
  assert.doesNotMatch(lifecycle, /ERROR_CODE\.test\(scope\.errorCode\)/u)
})

test('guest chat failure state is finite and provider codes are normalized', async () => {
  const root = new URL('../', import.meta.url)
  const actions = await readFile(
    new URL('packages/db/src/helpers/guest-chat-turn-actions.ts', root),
    'utf8',
  )
  const router = await readFile(new URL('packages/api/src/routers/chat.ts', root), 'utf8')

  assert.match(actions, /failureCode:\s*GuestChatPreDispatchFailureCode/u)
  assert.match(actions, /outcomeCode:\s*GuestChatProviderOutcomeCode/u)
  assert.match(actions, /fallbackCode:\s*GuestChatFallbackCode\.nullable\(\)/u)
  assert.doesNotMatch(actions, /failureCode:\s*z\.string\(\)/u)
  assert.doesNotMatch(actions, /outcomeCode:\s*z\.string\(\)/u)
  assert.doesNotMatch(actions, /fallbackCode:\s*z\.string\(\)/u)
  assert.match(router, /boundedGuestChatFallbackCode\(err\)/u)
  assert.match(router, /return 'PROVIDER_REQUEST_FAILED'/u)
  assert.doesNotMatch(router, /fallbackFailureCode\s*=\s*err instanceof AiGatewayError \? err\.code/u)
})

test('client assistant terminal failure state uses its single production code', async () => {
  const root = new URL('../', import.meta.url)
  const actions = await readFile(
    new URL('packages/db/src/helpers/client-assistant-actions.ts', root),
    'utf8',
  )
  const router = await readFile(
    new URL('packages/api/src/routers/client-assistant.ts', root),
    'utf8',
  )

  assert.match(actions, /ClientAssistantFailureCode = z\.literal\('assistant-unavailable'\)/u)
  assert.match(actions, /failureCode:\s*ClientAssistantFailureCode/u)
  assert.doesNotMatch(actions, /failureCode:\s*z\.string\(\)/u)
  assert.match(router, /failureCode:\s*ClientAssistantFailureCode/u)
  assert.doesNotMatch(router, /status:\s*'FAILED';\s*failureCode:\s*string/u)
})

test('AI usage sinks normalize failure codes and never log persistence exceptions', async () => {
  const root = new URL('../', import.meta.url)
  const normalizer = await readFile(
    new URL('packages/ai/src/usage-error-code.ts', root),
    'utf8',
  )
  const apiSink = await readFile(new URL('packages/api/src/lib/api-ai-usage.ts', root), 'utf8')
  const workerSink = await readFile(new URL('apps/workers/src/lib/ai-usage.ts', root), 'utf8')

  assert.match(normalizer, /return 'provider-error'/u)
  assert.match(normalizer, /\^provider-http-\[1-5\]\\d\{2\}\$/u)
  assert.match(apiSink, /normalizeAiUsageErrorCode\(usage\.errorCode\)/u)
  assert.match(workerSink, /normalizeAiUsageErrorCode\(usage\.errorCode\)/u)
  assert.doesNotMatch(apiSink, /errorCode:\s*usage\.errorCode/u)
  assert.doesNotMatch(workerSink, /errorCode:\s*usage\.errorCode/u)
  assert.doesNotMatch(workerSink, /error instanceof Error \? error\.message/u)
})

test('media asset analysis failures cannot enter synthesis or findings as exception text', async () => {
  const source = await readFile(
    new URL('../apps/workers/src/processors/media-ingestion.ts', import.meta.url),
    'utf8',
  )

  assert.match(
    source,
    /failedMediaAssetAnalysis\(\)[\s\S]{0,200}This asset requires manual review\./u,
  )
  assert.match(source, /analysis = failedMediaAssetAnalysis\(\)/u)
  assert.doesNotMatch(source, /emptyAnalysis\('Analysis failed\.',\s*(?:error|message)/u)
  assert.match(source, /MEDIA_ASSET_ANALYSIS_FAILURE_CODE = 'MEDIA_ASSET_ANALYSIS_FAILED'/u)
  assert.match(source, /throw new Error\('Unsupported media asset failure code\.'\)/u)
  assert.doesNotMatch(source, /status: 'FAILED'; error: string/u)
})

test('media upload failure persistence uses finite product-owned codes', async () => {
  const root = new URL('../', import.meta.url)
  const beginUpload = await readFile(
    new URL('packages/api/src/routers/admin/media-ingestion-begin-upload.ts', root),
    'utf8',
  )
  const completeUpload = await readFile(
    new URL('packages/api/src/routers/admin/media-ingestion-complete-upload.ts', root),
    'utf8',
  )

  assert.match(beginUpload, /error: 'MEDIA_UPLOAD_CREATION_FAILED'/u)
  assert.match(beginUpload, /error: 'MEDIA_UPLOAD_IDENTITY_PERSISTENCE_FAILED'/u)
  assert.match(completeUpload, /error: 'MEDIA_UPLOAD_FINALIZATION_FAILED'/u)
  assert.doesNotMatch(beginUpload, /error:\s*(?:message|error\.message)/u)
  assert.doesNotMatch(completeUpload, /error:\s*(?:message|error\.message)/u)
})

test('Clerk mutations never reflect provider error detail into tRPC responses', async () => {
  const source = await readFile(new URL('../packages/auth/src/server.ts', import.meta.url), 'utf8')

  assert.match(source, /message: 'Organization creation is temporarily unavailable'/u)
  assert.match(source, /message: 'Organization invitation is temporarily unavailable'/u)
  assert.doesNotMatch(source, /describeClerkError/u)
  assert.doesNotMatch(source, /Clerk rejected[^\n]*\$\{/u)
})

test('job-record persistence derives terminal error from failure disposition', async () => {
  const root = new URL('../', import.meta.url)
  const jobRecords = await readFile(
    new URL('packages/db/src/helpers/job-records.ts', root),
    'utf8',
  )
  const jobExecution = await readFile(
    new URL('apps/workers/src/lib/job-execution.ts', root),
    'utf8',
  )

  assert.doesNotMatch(jobRecords, /WriteJobRecordParams[\s\S]{0,400}\berror\??:\s*string/u)
  assert.doesNotMatch(jobRecords, /status:\s*'FAILED'[\s\S]{0,200}\berror:\s*string/u)
  assert.match(jobRecords, /error:\s*`JOB_\$\{data\.failureDisposition\}`/u)
  assert.doesNotMatch(jobExecution, /updateJobRecord\([\s\S]{0,300}\berror:/u)
})

test('guarded domain processors expose only finite failure codes to BullMQ retention', async () => {
  const root = new URL('../', import.meta.url)
  const jobExecution = await readFile(
    new URL('apps/workers/src/lib/job-execution.ts', root),
    'utf8',
  )

  assert.match(jobExecution, /function toQueueSafeJobError/u)
  assert.match(jobExecution, /new UnrecoverableError\(failureCode\)/u)
  assert.doesNotMatch(jobExecution, /cause:\s*error/u)

  for (const [relativePath, failureCode] of [
    ['apps/workers/src/processors/embed-place.ts', 'EMBED_PLACE_FAILED'],
    [
      'apps/workers/src/processors/embed-knowledge-entry.ts',
      'EMBED_KNOWLEDGE_ENTRY_FAILED',
    ],
    [
      'apps/workers/src/processors/embed-company-knowledge.ts',
      'EMBED_COMPANY_KNOWLEDGE_FAILED',
    ],
    ['apps/workers/src/processors/send-welcome-email.ts', 'WELCOME_EMAIL_DELIVERY_FAILED'],
    ['apps/workers/src/processors/generation-recovery.ts', 'GENERATION_RECOVERY_FAILED'],
    ['apps/workers/src/processors/voice-session-recovery.ts', 'VOICE_SESSION_RECOVERY_FAILED'],
    ['apps/workers/src/processors/daily-rollup.ts', 'DAILY_ROLLUP_FAILED'],
  ]) {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    assert.match(
      source,
      new RegExp(`throw toQueueSafeJobError\\(error, '${failureCode}'\\)`, 'u'),
      relativePath,
    )
    assert.doesNotMatch(source, /catch \(error\)[\s\S]{0,1600}\n\s*throw error\s*\n/u, relativePath)
  }
})

test('every BullMQ worker registration crosses the queue-safe retention boundary', async () => {
  const root = new URL('../', import.meta.url)
  for (const relativePath of [
    'apps/workers/src/index.ts',
    'apps/workers/src/evaluation-only-runtime.ts',
    'apps/workers/src/crm-background.ts',
    'apps/workers/src/venue-media-derivative-runtime.ts',
    'apps/workers/src/intake-upload-verification-runtime.ts',
  ]) {
    const source = await readFile(new URL(relativePath, root), 'utf8')
    const registrations = source.match(/new Worker\(/gu) ?? []
    const guardedProcessors = source.match(/queueSafeJobProcessor\(/gu) ?? []
    assert.ok(registrations.length > 0, `${relativePath}: no worker registration found`)
    assert.equal(
      guardedProcessors.length,
      registrations.length,
      `${relativePath}: every worker registration must be queue-safe`,
    )
  }
})

test('website research receipt persistence derives failure detail from a bounded code', async () => {
  const root = new URL('../', import.meta.url)
  const receiptActions = await readFile(
    new URL('packages/db/src/helpers/intake-website-research-actions.ts', root),
    'utf8',
  )
  const researchService = await readFile(
    new URL('packages/api/src/lib/website-intake-research-service.ts', root),
    'utf8',
  )

  assert.doesNotMatch(receiptActions, /errorMessage:\s*z\.string/u)
  assert.match(receiptActions, /errorMessage:\s*websiteResearchFailureMessages\[input\.errorCode\]/u)
  assert.doesNotMatch(researchService, /errorMessage:/u)
})

test('file extraction receipt persistence derives failure detail from a bounded code', async () => {
  const root = new URL('../', import.meta.url)
  const receiptActions = await readFile(
    new URL('packages/db/src/helpers/intake-file-extraction-actions.ts', root),
    'utf8',
  )
  const extractionService = await readFile(
    new URL('packages/api/src/lib/intake-file-extraction-service.ts', root),
    'utf8',
  )

  assert.doesNotMatch(receiptActions, /errorMessage:\s*z\.string/u)
  assert.match(receiptActions, /errorMessage:\s*fileExtractionFailureMessages\[input\.errorCode\]/u)
  assert.doesNotMatch(extractionService, /errorMessage:/u)
})
