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
