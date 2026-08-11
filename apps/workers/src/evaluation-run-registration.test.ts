import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('evaluation worker registration boundary', () => {
  it('registers only behind the explicit process gate and keeps tenant/runtime controls', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf8')
    const boundary = source.slice(
      source.indexOf('const evaluationRunWorker ='),
      source.indexOf('const handleCompletedJob'),
    )
    expect(boundary).toMatch(/env\.EVALUATION_RUNNER_ENABLED\s*\?\s*observeWorkerRuntime/u)
    expect(boundary).toMatch(/new Worker\(EVALUATION_RUN_QUEUE/u)
    expect(boundary).toMatch(/concurrency:\s*1/u)
    expect(source).toMatch(/runAiJobWithIncidentControl[\s\S]*processEvaluationRunJob/u)
    expect(source).toMatch(/upsertJobScheduler\([\s\S]*EVALUATION_RUN_DISPATCH_JOB/u)
    expect(source).toMatch(/EVALUATION_RUN_DISPATCH_JOB[\s\S]*processEvaluationDispatchJob/u)
    expect(source).toMatch(/evaluationRunnerEnabled:\s*env\.EVALUATION_RUNNER_ENABLED/u)
  })
})
