import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workerUrl = new URL('../apps/workers/src/index.ts', import.meta.url)
const policyUrl = new URL('../packages/jobs/src/media-ingestion-admission.ts', import.meta.url)
const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url)
const runbookUrl = new URL('../docs/media-ingestion-lab.md', import.meta.url)

test('configures and verifies global admission before constructing the media worker', async () => {
  const [worker, policy] = await Promise.all([
    readFile(workerUrl, 'utf8'),
    readFile(policyUrl, 'utf8'),
  ])
  const cleanupBoundary = worker.indexOf('await runStartupWithCleanup(async () => {')
  const configured = worker.indexOf(
    'await configureMediaIngestionGlobalConcurrency(mediaIngestionQueue)',
  )
  const mediaWorker = worker.indexOf(
    'new Worker(MEDIA_INGESTION_QUEUE, queueSafeJobProcessor(handleMediaIngestionQueueJob)',
  )

  assert.ok(cleanupBoundary >= 0)
  assert.ok(configured > cleanupBoundary)
  assert.ok(mediaWorker > configured)
  assert.match(worker.slice(mediaWorker, mediaWorker + 260), /concurrency: 1/u)
  assert.doesNotMatch(worker, /removeGlobalConcurrency/u)
  assert.match(policy, /MEDIA_INGESTION_GLOBAL_CONCURRENCY = 1/u)
  assert.match(policy, /await queue\.setGlobalConcurrency\(MEDIA_INGESTION_GLOBAL_CONCURRENCY\)/u)
  assert.match(policy, /await queue\.getGlobalConcurrency\(\)/u)
})

test('keeps the real Redis proof and persistent rollback warning in canonical gates', async () => {
  const [workflow, runbook] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(runbookUrl, 'utf8'),
  ])

  assert.match(workflow, /run: pnpm test:redis:media-admission/u)
  assert.match(
    workflow,
    /PATHFINDER_EXISTING_DISPOSABLE_REDIS_CONFIRMATION: pathfinder_ci_owned_disposable_redis/u,
  )
  assert.match(runbook, /does not preempt media jobs that were already active/u)
  assert.match(runbook, /Reverting application code does not remove/u)
  assert.match(runbook, /not a strict distributed execution mutex/u)
})
