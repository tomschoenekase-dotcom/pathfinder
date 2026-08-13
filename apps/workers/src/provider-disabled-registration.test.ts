import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
const bootstrap = readFileSync(resolve(__dirname, 'bootstrap.ts'), 'utf8')

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

  it('chooses dormant mode before importing the provider-enabled worker graph', () => {
    const entryPoint = bootstrap.indexOf('export async function bootstrapWorkers()')
    const policy = bootstrap.indexOf('resolveWorkerStartupPolicy(process.env)', entryPoint)
    const assertion = bootstrap.indexOf(
      'assertRequiredEnvironment(policy.requiredEnvironmentKeys)',
      entryPoint,
    )
    const disabledBranch = bootstrap.indexOf("if (policy.mode === 'provider-disabled')", assertion)
    const disabledReturn = bootstrap.indexOf('return', disabledBranch)
    const providerImport = bootstrap.indexOf("await import('./index.js')", disabledReturn)

    expect(entryPoint).toBeGreaterThanOrEqual(0)
    expect(policy).toBeGreaterThan(entryPoint)
    expect(assertion).toBeGreaterThan(policy)
    expect(disabledBranch).toBeGreaterThan(assertion)
    expect(disabledReturn).toBeGreaterThan(disabledBranch)
    expect(providerImport).toBeGreaterThan(disabledReturn)
    expect(bootstrap).not.toContain('@pathfinder/config')
  })
})
