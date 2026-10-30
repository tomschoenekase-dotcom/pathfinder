import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  compileGuestQueryCanonicalSource,
  compileGuestQueryCanonicalSourceForReuse,
  GUEST_QUERY_CANONICAL_COMPILER_CONTRACT,
  guestQueryReusableSourceFingerprint,
  guestQuerySourceIsTemporallyAdmitted,
  rebindGuestQueryCanonicalSource,
  type GuestQueryReusableCompilation,
} from './guest-query-canonical-projection'
import type { GuestQuerySource } from './guest-query-source'

const DEFAULT_ENTRIES = 8
const DEFAULT_BYTES = 64 * 1024 * 1024
const issuedCaches = new WeakSet<object>()

/** Build SHA survives production bundling; local source hashing needs no source files in a bundle. */
export function guestQueryCompilerBuildIdentity(): string | undefined {
  const build = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA
  if (build && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(build))
    return `${GUEST_QUERY_CANONICAL_COMPILER_CONTRACT}:build:${build.toLowerCase()}`
  if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') return undefined
  let root = process.cwd()
  for (let depth = 0; depth < 6; depth++, root = dirname(root)) {
    try {
      // Include runtime compiler dependencies and lockfile; a contract-only edit cannot retain a key.
      const files = [
        'packages/api/src/lib/guest-query-canonical-projection.ts',
        'packages/api/src/lib/guest-query-projection.ts',
        'packages/api/src/lib/guest-structured-query.ts',
        'packages/api/src/lib/guest-query-compile-cache.ts',
        'packages/contracts/src/guest-query-canonical.ts',
        'packages/contracts/src/universal-content-actions.ts',
        'packages/contracts/src/content-model.ts',
        'pnpm-lock.yaml',
      ]
      const hash = createHash('sha256')
      for (const file of files)
        hash
          .update(file)
          .update('\0')
          .update(readFileSync(resolve(root, file)))
          .update('\0')
      return `${GUEST_QUERY_CANONICAL_COMPILER_CONTRACT}:source:${hash.digest('hex')}`
    } catch {
      // An unavailable local source tree disables reuse; never invent a fallback identity.
    }
  }
  return undefined
}

type Entry = { reusable: GuestQueryReusableCompilation; fingerprint: string; bytes: number }
export type GuestQueryCompileCache = ReturnType<typeof createGuestQueryCompileCache>

/** Bounds cover serialized retained payload/key bytes, not JavaScript allocator/WeakMap overhead. */
export function createGuestQueryCompileCache(
  options: {
    maxEntries?: number
    maxBytes?: number
    /** Internal injection for isolated acceptance tests; it never grants source/proof authority. */
    buildIdentity?: () => string | undefined
  } = {},
) {
  const maxEntries = options.maxEntries ?? DEFAULT_ENTRIES
  const maxBytes = options.maxBytes ?? DEFAULT_BYTES
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new Error('Positive cache entry and serialized-byte bounds required')
  const identity = options.buildIdentity ?? guestQueryCompilerBuildIdentity
  const entries = new Map<string, Entry>()
  let serializedBytes = 0
  const counts = { hits: 0, misses: 0, rejections: 0, bypasses: 0, evictions: 0 }
  function remove(key: string) {
    const entry = entries.get(key)
    if (entry) {
      entries.delete(key)
      serializedBytes -= entry.bytes
      counts.evictions++
    }
  }
  const cache = {
    compile(source: GuestQuerySource) {
      // Runtime check precedes any key lookup/insertion, even for a caller forging the TS type.
      if (!['LEGACY', 'DARK'].includes(source.readPath))
        throw new Error('Native source cannot enter legacy compiler cache')
      const build = identity()
      if (!build) {
        counts.bypasses++
        return compileGuestQueryCanonicalSource(source)
      }
      const key = JSON.stringify([
        source.tenantId,
        source.venueId,
        source.includeSecondLayer,
        source.readPath,
        source.version,
        GUEST_QUERY_CANONICAL_COMPILER_CONTRACT,
        build,
      ])
      const fingerprint = guestQueryReusableSourceFingerprint(source)
      const entry = entries.get(key)
      if (entry && entry.fingerprint !== fingerprint) {
        counts.rejections++
        remove(key)
        throw new Error('Cached compiler source rows mismatch')
      }
      if (!guestQuerySourceIsTemporallyAdmitted(source)) {
        counts.bypasses++
        return compileGuestQueryCanonicalSource(source)
      }
      if (entry) {
        const compiled = rebindGuestQueryCanonicalSource(entry.reusable, source)
        entries.delete(key)
        entries.set(key, entry)
        counts.hits++
        return compiled
      }
      counts.misses++
      const { compiled, reusable } = compileGuestQueryCanonicalSourceForReuse(source)
      if (reusable) {
        const bytes =
          reusable.serializedBytes +
          Buffer.byteLength(key, 'utf8') +
          Buffer.byteLength(fingerprint, 'utf8')
        if (bytes <= maxBytes) {
          while (entries.size >= maxEntries || serializedBytes + bytes > maxBytes) {
            const oldest = entries.keys().next().value
            if (oldest === undefined) break
            remove(oldest)
          }
          entries.set(key, { reusable, fingerprint, bytes })
          serializedBytes += bytes
        }
      }
      return compiled
    },
    clear() {
      entries.clear()
      serializedBytes = 0
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0
    },
    stats() {
      return { ...counts, entries: entries.size, serializedBytes }
    },
  }
  issuedCaches.add(cache)
  return Object.freeze(cache)
}

const selectedCache = new AsyncLocalStorage<GuestQueryCompileCache | false>()
const defaultCache = createGuestQueryCompileCache()

/** Async-local acceptance seam retains the caller's unchanged source loader and dispatch fence. */
export function withGuestQueryCompileCache<T>(
  cache: GuestQueryCompileCache | false,
  run: () => T,
): T {
  if (cache !== false && !issuedCaches.has(cache))
    throw new Error('Issued compiler cache instance required')
  return selectedCache.run(cache, run)
}

export function compileGuestQuerySourceWithReuse(source: GuestQuerySource) {
  const selected = selectedCache.getStore()
  const enabled =
    process.env.TORCHIKO_LOCAL_QUERY_COMPILE_REUSE === '1' &&
    (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development')
  const cache = selected === false ? undefined : (selected ?? (enabled ? defaultCache : undefined))
  return cache ? cache.compile(source) : compileGuestQueryCanonicalSource(source)
}
