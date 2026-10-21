import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGuestQueryCompileCache,
  compileGuestQuerySourceWithReuse,
  guestQueryCompilerBuildIdentity,
  withGuestQueryCompileCache,
} from './guest-query-compile-cache'
import {
  compileGuestQueryCanonicalSource,
  compileGuestQueryCanonicalSourceForReuse,
  guestCanonicalEvidenceAuthority,
  identityScopedProductMetadata,
  rebindGuestQueryCanonicalSource,
} from './guest-query-canonical-projection'
import type { GuestQuerySource } from './guest-query-source'

function source(version = 'v1'): GuestQuerySource {
  return {
    tenantId: 'fictional-tenant',
    venueId: 'fictional-venue',
    version,
    asOf: '2026-10-21T05:00:00.000Z',
    coverage: 'COMPLETE',
    readPath: 'LEGACY',
    includeSecondLayer: false,
    directory: { incomplete: false, searchVersion: version, places: [], knowledge: [] },
    canonicalModules: {
      contract: 'published-query-source-v1',
      modules: [
        {
          moduleId: 'product',
          revisionId: 'revision-product',
          publicationId: 'publication-product',
          publicationOrder: '1',
          version: 1,
          kind: 'ITEM',
          audience: 'PUBLIC',
          effectiveFrom: null,
          effectiveUntil: null,
          evidence: [],
          payload: { kind: 'ITEM', name: 'Fictional souvenir', itemType: 'PRODUCT' },
        },
      ],
    },
  }
}
const cache = (options: Parameters<typeof createGuestQueryCompileCache>[0] = {}) =>
  createGuestQueryCompileCache({ buildIdentity: () => 'test-build', ...options })
const plain = (compiled: ReturnType<typeof compileGuestQueryCanonicalSource>) => {
  const { prepared, productMetadataProof, ...fields } = compiled
  return {
    ...fields,
    authority: guestCanonicalEvidenceAuthority(prepared, { ...source(), asOf: prepared.asOf }),
    product: identityScopedProductMetadata(productMetadataProof, prepared, 'product'),
  }
}
afterEach(() => vi.unstubAllEnvs())

describe('bounded compiler-owned compile reuse', () => {
  it('rebinds new clock, real prepared identity and exact owned proofs without changing output', () => {
    const c = cache(),
      first = c.compile(source()),
      later = { ...source(), asOf: '2026-10-21T06:00:00.000Z' }
    const warm = c.compile(later),
      fresh = compileGuestQueryCanonicalSource(later)
    expect(plain(warm)).toEqual(plain(fresh))
    expect(warm.prepared).not.toBe(first.prepared)
    expect(warm.prepared.asOf).toBe(later.asOf)
    expect(warm.prepared.snapshotIdentity).toBe(first.prepared.snapshotIdentity)
    expect(() => guestCanonicalEvidenceAuthority(warm.prepared, source())).toThrow(/authority/)
    expect(
      identityScopedProductMetadata(first.productMetadataProof, warm.prepared, 'product'),
    ).toBeUndefined()
    expect(
      identityScopedProductMetadata(warm.productMetadataProof, warm.prepared, 'product')?.moduleId,
    ).toBe('product')
    expect(c.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 })
  })
  it('rejects same version with changed rows, evicts, and grants no stale proof', () => {
    const c = cache()
    c.compile(source())
    const changed = source()
    const changedPayload = changed.canonicalModules!.modules[0]!.payload
    if (changedPayload.kind !== 'ITEM') throw new Error('fixture')
    changedPayload.name = 'Replacement'
    expect(() => c.compile(changed)).toThrow(/rows mismatch/)
    expect(c.stats()).toMatchObject({ rejections: 1, entries: 0 })
  })
  it('rejects changed same-version rows even when the replacement is temporally ineligible', () => {
    const c = cache()
    c.compile(source())
    const altered = source()
    altered.canonicalModules!.modules[0]!.effectiveFrom = '2026-10-22T00:00:00.000Z'
    expect(() => c.compile(altered)).toThrow(/rows mismatch/)
    expect(c.stats()).toMatchObject({ rejections: 1, bypasses: 0, entries: 0 })
  })
  it('cannot be poisoned by original source, public fields, metadata or authority mutations', () => {
    const c = cache(),
      input = source(),
      first = c.compile(input)
    input.canonicalModules!.modules.length = 0
    const mutableRecords = first.snapshot.records as unknown as unknown[]
    mutableRecords.length = 0
    first.knowledgeScopes.length = 0
    first.unresolvedReasons.push({ moduleId: 'fake', reason: 'fake' })
    const proof = guestCanonicalEvidenceAuthority(first.prepared, source())
    proof.subjectModules.length = 0
    const product = identityScopedProductMetadata(
      first.productMetadataProof,
      first.prepared,
      'product',
    )!
    if (product.payload.kind !== 'ITEM') throw new Error('fixture')
    product.payload.name = 'Injected'
    expect(plain(c.compile(source()))).toEqual(plain(compileGuestQueryCanonicalSource(source())))
  })
  it('cannot capture mutated public metadata as a compiler-issued reusable proof', () => {
    const issued = compileGuestQueryCanonicalSourceForReuse(source())
    issued.compiled.knowledgeScopes.length = 0
    expect(issued.reusable).toBeDefined()
    const bound = rebindGuestQueryCanonicalSource(issued.reusable!, source())
    expect(bound.knowledgeScopes).toHaveLength(1)
    expect(() => rebindGuestQueryCanonicalSource({ serializedBytes: 1 }, source())).toThrow(
      /compiler-owned/,
    )
    const changed = source()
    changed.version = 'forged'
    expect(() => rebindGuestQueryCanonicalSource(issued.reusable!, changed)).toThrow(
      /compiler-owned/,
    )
  })
  it.each(['tenantId', 'venueId', 'includeSecondLayer', 'readPath', 'version'] as const)(
    'misses changed scope %s',
    (field) => {
      const c = cache()
      c.compile(source())
      const next = source()
      if (field === 'includeSecondLayer') next[field] = true
      else if (field === 'readPath') next[field] = 'DARK'
      else next[field] = 'other'
      if (field === 'version') next.directory.searchVersion = next.version
      c.compile(next)
      expect(c.stats()).toMatchObject({ misses: 2, hits: 0 })
    },
  )
  it('misses changed build identity and disables absent identity', () => {
    let build: string | undefined = 'a'
    const c = cache({ buildIdentity: () => build })
    c.compile(source())
    build = 'b'
    c.compile(source())
    build = undefined
    c.compile(source())
    expect(c.stats()).toMatchObject({ hits: 0, misses: 2, bypasses: 1 })
  })
  it('never reads or writes cache entries for NATIVE', () => {
    const c = cache()
    c.compile(source())
    const before = c.stats()
    expect(() =>
      c.compile({ ...source(), readPath: 'NATIVE' } as unknown as GuestQuerySource),
    ).toThrow(/Native/)
    expect(c.stats()).toEqual(before)
  })
  it('does not reuse a source whose raw rows become non-current at the new clock', () => {
    const c = cache(),
      input = source()
    input.canonicalModules!.modules[0]!.effectiveUntil = '2026-10-21T06:00:00.000Z'
    c.compile(input)
    const expired = { ...input, asOf: '2026-10-21T06:00:00.000Z' }
    const compiled = c.compile(expired)
    expect(compiled.unresolvedReasons).toContainEqual({
      moduleId: 'product',
      reason: 'NOT_CURRENT',
    })
    expect(c.stats()).toMatchObject({ hits: 0, bypasses: 1 })
    const future = source()
    future.canonicalModules!.modules[0]!.effectiveFrom = '2026-10-22T00:00:00.000Z'
    const other = cache()
    other.compile(future)
    expect(other.stats()).toMatchObject({ entries: 0, bypasses: 1 })
  })
  it('enforces access-order entry eviction and serialized byte bounds', () => {
    const c = cache({ maxEntries: 2 })
    c.compile(source('a'))
    c.compile(source('b'))
    c.compile(source('a'))
    c.compile(source('c'))
    expect(c.stats()).toMatchObject({ entries: 2, evictions: 1 })
    c.compile(source('b'))
    expect(c.stats()).toMatchObject({ misses: 4 })
    const measured = cache()
    measured.compile(source('a'))
    const size = measured.stats().serializedBytes
    const bounded = cache({ maxBytes: size + 1 })
    bounded.compile(source('a'))
    bounded.compile(source('b'))
    expect(bounded.stats().serializedBytes).toBeLessThanOrEqual(size + 1)
    expect(bounded.stats().entries).toBe(1)
    const tiny = cache({ maxBytes: 1 })
    tiny.compile(source())
    expect(tiny.stats().entries).toBe(0)
    c.clear()
    expect(c.stats()).toEqual({
      hits: 0,
      misses: 0,
      rejections: 0,
      bypasses: 0,
      evictions: 0,
      entries: 0,
      serializedBytes: 0,
    })
    expect(() => cache({ maxBytes: 0 })).toThrow(/bounds/)
  })
  it('isolates concurrent clock rebinds and explicit uncached async-local work', async () => {
    const c = cache()
    c.compile(source())
    const at = ['2026-10-21T06:00:00.000Z', '2026-10-21T07:00:00.000Z']
    const results = await Promise.all(
      at.map((asOf) =>
        withGuestQueryCompileCache(c, async () => {
          await Promise.resolve()
          return compileGuestQuerySourceWithReuse({ ...source(), asOf })
        }),
      ),
    )
    expect(results.map((value) => value.prepared.asOf)).toEqual(at)
    await withGuestQueryCompileCache(false, async () => {
      await Promise.resolve()
      compileGuestQuerySourceWithReuse(source())
    })
    expect(c.stats().hits).toBe(2)
    for (let i = 0; i < results.length; i++)
      expect(() =>
        guestCanonicalEvidenceAuthority(results[i]!.prepared, { ...source(), asOf: at[1 - i]! }),
      ).toThrow(/authority/)
  })
  it('rejects malformed fresh timestamps exactly as the uncached compiler does', () => {
    const c = cache()
    c.compile(source())
    for (const asOf of ['2026-10-21 06:00:00Z', 'not-a-date', '2026-13-01T00:00:00.000Z']) {
      const malformed = { ...source(), asOf }
      expect(() => compileGuestQueryCanonicalSource(malformed)).toThrow()
      expect(() => c.compile(malformed)).toThrow()
    }
    expect(c.stats().hits).toBe(0)
  })
  it('does not permit a forged cache or replacement compilation method through the test seam', () => {
    const c = cache()
    expect(Object.isFrozen(c)).toBe(true)
    expect(() =>
      withGuestQueryCompileCache({ compile: () => ({}) } as unknown as typeof c, () => undefined),
    ).toThrow(/Issued/)
    expect(() => Object.assign(c, { compile: () => ({}) })).toThrow()
  })
  it('defaults OFF and never invents production build identity', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
    expect(guestQueryCompilerBuildIdentity()).toBeUndefined()
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', 'a'.repeat(40))
    expect(guestQueryCompilerBuildIdentity()).toContain('build:' + 'a'.repeat(40))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '')
    vi.stubEnv('TORCHIKO_LOCAL_QUERY_COMPILE_REUSE', '')
    const one = compileGuestQuerySourceWithReuse(source()),
      two = compileGuestQuerySourceWithReuse(source())
    expect(one.prepared).not.toBe(two.prepared)
    expect(guestQueryCompilerBuildIdentity()).toMatch(/:source:[a-f0-9]{64}$/)
  })
})
