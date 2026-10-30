import { GUEST_QUERY_CANONICAL_COMPILER_CONTRACT } from './guest-query-canonical-projection'
import { createHash } from 'node:crypto'
import {
  resolveEffectivePublishedUniversalContentSnapshot,
  type EffectivePublishedUniversalContentSnapshot,
} from '@pathfinder/db'
import { loadGuestQuerySourceDirectory } from './guest-query-source-directory'
import type { GuestVenueDirectory } from './guest-venue-directory'
import { MAX_GUEST_QUERY_SOURCE_BYTES } from './guest-query-source-limits'
export { MAX_GUEST_QUERY_SOURCE_BYTES } from './guest-query-source-limits'

type SourceScope = {
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  asOf: Date
}

/** The caller supplies the existing tenant-scoped client, never an unscoped replacement. */
export type GuestQueryTransactionClient = {
  $transaction<T>(
    read: (reader: unknown) => Promise<T>,
    options: { isolationLevel: 'RepeatableRead'; timeout: number },
  ): Promise<T>
}

export type GuestQuerySource = {
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  asOf: string
  readPath: 'LEGACY' | 'DARK'
  version: string
  coverage: 'COMPLETE'
  directory: GuestVenueDirectory
  /** Absent on older in-memory fixtures; never infer canonical authority from prose. */
  canonicalModules?: {
    contract: 'published-query-source-v1'
    modules: EffectivePublishedUniversalContentSnapshot[]
  }
}

export const GUEST_QUERY_SOURCE_CONTRACT = 'guest-query-source-authority-v2' as const

function validateScope(scope: SourceScope) {
  if (
    typeof scope.tenantId !== 'string' ||
    !scope.tenantId.trim() ||
    typeof scope.venueId !== 'string' ||
    !scope.venueId.trim() ||
    typeof scope.includeSecondLayer !== 'boolean' ||
    !(scope.asOf instanceof Date) ||
    !Number.isFinite(scope.asOf.getTime())
  )
    throw new Error('Invalid guest query source scope')
}

/**
 * Complete stored-record membership at one database snapshot. This does not prove an exhaustive
 * real-world inventory. Native reads must use their admitted immutable release instead; silently
 * substituting legacy rows would cross the native publication boundary.
 *
 * No cache or fallback is used here. Failure to establish repeatable-read authority is a failure,
 * not a partial result relabeled complete. The transaction starts at its first SELECT.
 */
export async function loadGuestQuerySource(input: {
  client: GuestQueryTransactionClient
  scope: SourceScope
  readPath: 'LEGACY' | 'DARK'
}): Promise<GuestQuerySource> {
  validateScope(input.scope)
  if (input.readPath !== 'LEGACY' && input.readPath !== 'DARK')
    throw new Error('Native guest query requires an admitted native snapshot')
  const scope = { ...input.scope, asOf: new Date(input.scope.asOf) }
  return input.client.$transaction(
    async (reader) => {
      const modules = await resolveEffectivePublishedUniversalContentSnapshot({
        db: reader,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        asOf: scope.asOf,
      })
      const canonicalModules = {
        contract: 'published-query-source-v1' as const,
        modules,
      }
      if (
        new Set(modules.map((row) => row.moduleId)).size !== modules.length ||
        new Set(modules.map((row) => row.revisionId)).size !== modules.length ||
        new Set(modules.map((row) => row.publicationId)).size !== modules.length
      )
        throw new Error('Duplicate canonical query source identity')
      const { directory, authority } = await loadGuestQuerySourceDirectory({
        ...scope,
        reader,
        modules,
      })
      if (directory.incomplete) throw new Error('Incomplete guest query source')
      const authorityVersion = createHash('sha256').update(JSON.stringify(authority)).digest('hex')
      const identities = [
        ...directory.places.map((row) => `place:${row.id}`),
        ...directory.knowledge.map((row) => `knowledge:${row.id}`),
      ]
      if (new Set(identities).size !== identities.length)
        throw new Error('Duplicate guest query source identity')
      const versionBody = JSON.stringify({
        sourceContract: GUEST_QUERY_SOURCE_CONTRACT,
        compilerContract: GUEST_QUERY_CANONICAL_COMPILER_CONTRACT,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        includeSecondLayer: scope.includeSecondLayer,
        readPath: input.readPath,
        authorityVersion,
        // The actual rows are bound too: an incorrect metadata adapter cannot bless other bytes.
        directory,
        canonicalModules,
      })
      if (Buffer.byteLength(versionBody, 'utf8') > MAX_GUEST_QUERY_SOURCE_BYTES)
        throw new Error('Guest query source exceeds byte bound')
      const version = createHash('sha256').update(versionBody).digest('hex')
      return {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        includeSecondLayer: scope.includeSecondLayer,
        asOf: scope.asOf.toISOString(),
        readPath: input.readPath,
        version,
        coverage: 'COMPLETE',
        directory: { ...directory, searchVersion: version },
        canonicalModules,
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: 15_000 },
  )
}
