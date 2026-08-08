import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workerUrl = new URL('../apps/workers/src/index.ts', import.meta.url)
const processorUrl = new URL('../apps/workers/src/processors/media-ingestion.ts', import.meta.url)
const providerBudgetUrl = new URL(
  '../apps/workers/src/lib/media-provider-budget.ts',
  import.meta.url,
)
const boundedProcessUrl = new URL('../apps/workers/src/lib/bounded-process.ts', import.meta.url)
const installedWorkerUrl = new URL(
  '../node_modules/.pnpm/bullmq@5.73.5/node_modules/bullmq/dist/cjs/classes/worker.js',
  import.meta.url,
)

test('the media processor has runtime arity three and exact lock-loss cancellation wiring', async () => {
  const [worker, installedWorker] = await Promise.all([
    readFile(workerUrl, 'utf8'),
    readFile(installedWorkerUrl, 'utf8'),
  ])

  assert.match(
    worker,
    /async function handleMediaIngestionQueueJob\(\s*job:[\s\S]*?_token\?: string,\s*signal\?: AbortSignal,/u,
  )
  assert.match(
    worker,
    /processMediaIngestionJob\(job\.data, getJobExecutionMetadata\(job\), signal\)/u,
  )
  assert.match(
    worker,
    /mediaIngestionWorker\.on\('lockRenewalFailed',[\s\S]*?cancelMediaJobsAfterLockRenewalFailure/u,
  )
  assert.match(
    worker,
    /mediaIngestionWorker\.on\('error',[\s\S]*?cancelAllMediaJobsAfterWorkerError/u,
  )
  assert.match(installedWorker, /this\.processorAcceptsSignal = processor\.length >= 3/u)
  assert.match(
    installedWorker,
    /this\.lockManager\.trackJob\([\s\S]*?this\.processorAcceptsSignal/u,
  )
})

test('ownership checks surround provider dispatch and durable media writes', async () => {
  const [processor, providerBudget] = await Promise.all([
    readFile(processorUrl, 'utf8'),
    readFile(providerBudgetUrl, 'utf8'),
  ])

  assert.match(providerBudget, /await reserve\(\)\s*assertActive\?\.\(\)\s*return operation\(\)/u)
  assert.match(processor, /signal \? \{ signal \} : undefined/u)
  assert.match(processor, /signal \? \{ abortSignal: signal \} : undefined/u)
  assert.match(processor, /pipeline\(entry, counter, output, \{ signal \}\)/u)
  assert.match(processor, /assertMediaJobActive\(signal\)[\s\S]*?persistMediaIngestionAsset/u)
  assert.match(processor, /assertMediaJobActive\(signal\)[\s\S]*?status: 'SYNTHESIZING'/u)
  assert.match(processor, /assertMediaJobActive\(signal\)[\s\S]*?status: questions\.length/u)
})

test('bounded FFmpeg execution forwards abort and classifies it separately from timeout', async () => {
  const boundedProcess = await readFile(boundedProcessUrl, 'utf8')
  assert.match(boundedProcess, /signal: options\.signal/u)
  assert.match(boundedProcess, /failure\.name === 'AbortError' \|\| failure\.code === 'ABORT_ERR'/u)
  assert.match(boundedProcess, /reason: BoundedProcessFailureReason/u)
  assert.match(boundedProcess, /'aborted' \| 'exit'/u)
})
