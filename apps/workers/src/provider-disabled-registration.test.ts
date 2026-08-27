import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
const bootstrap = readFileSync(resolve(__dirname, 'bootstrap.ts'), 'utf8')
const derivativeRuntime = readFileSync(
  resolve(__dirname, 'venue-media-derivative-runtime.ts'),
  'utf8',
)

describe('provider-disabled worker registration boundary', () => {
  it('keeps the provider-enabled worker graph free of a hidden provider-disabled branch', () => {
    expect(source).not.toContain('if (!env.OUTBOUND_PROVIDER_WORKERS_ENABLED)')
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

  it('loads the deterministic derivative runtime without importing the provider worker graph', () => {
    const entryPoint = bootstrap.indexOf('export async function bootstrapWorkers()')
    const derivativeBranch = bootstrap.indexOf(
      "if (policy.mode === 'venue-media-derivative-only')",
      entryPoint,
    )
    const derivativeImport = bootstrap.indexOf(
      "await import('./venue-media-derivative-runtime.js')",
      derivativeBranch,
    )
    const derivativeReturn = bootstrap.indexOf('return runtime', derivativeImport)
    const providerImport = bootstrap.indexOf("await import('./index.js')", derivativeReturn)

    expect(derivativeBranch).toBeGreaterThan(entryPoint)
    expect(derivativeImport).toBeGreaterThan(derivativeBranch)
    expect(derivativeReturn).toBeGreaterThan(derivativeImport)
    expect(providerImport).toBeGreaterThan(derivativeReturn)
    expect(derivativeRuntime).toContain('VENUE_MEDIA_DERIVATIVE_QUEUE')
    expect(derivativeRuntime).not.toMatch(/@pathfinder\/ai|openai|anthropic/iu)
  })
})
