import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

describe('provider-disabled worker registration boundary', () => {
  it('returns through the connectivity-only runtime before constructing any queue', () => {
    const start = source.indexOf('export async function startWorkers()')
    const disabledBranch = source.indexOf('if (!env.OUTBOUND_PROVIDER_WORKERS_ENABLED)', start)
    const disabledReturn = source.indexOf('return runtime', disabledBranch)
    const firstConnection = source.indexOf('const connection = getBullMQConnection()', start)
    const firstQueue = source.indexOf('new Queue(', start)
    const firstWorker = source.indexOf('new Worker(', start)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(disabledBranch).toBeGreaterThan(start)
    expect(disabledReturn).toBeGreaterThan(disabledBranch)
    expect(disabledReturn).toBeLessThan(firstConnection)
    expect(disabledReturn).toBeLessThan(firstQueue)
    expect(disabledReturn).toBeLessThan(firstWorker)
  })

  it('uses worker-only startup policy before asserting environment keys', () => {
    const entryPoint = source.indexOf('if (require.main === module)')
    const policy = source.indexOf('resolveWorkerStartupPolicy(process.env)', entryPoint)
    const assertion = source.indexOf(
      "assertServerEnv(policy.requiredEnvironmentKeys, 'workers')",
      entryPoint,
    )
    const startup = source.indexOf('await startWorkers()', entryPoint)

    expect(entryPoint).toBeGreaterThanOrEqual(0)
    expect(policy).toBeGreaterThan(entryPoint)
    expect(assertion).toBeGreaterThan(policy)
    expect(startup).toBeGreaterThan(assertion)
  })
})
