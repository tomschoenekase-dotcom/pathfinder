import { z } from 'zod'
import {
  GUEST_QUERY_CANONICAL_CONTRACT,
  GUEST_QUERY_EXCEPTION_RELATIONSHIP,
  guestQueryCanonicalRelationship,
} from '@pathfinder/contracts/guest-query-canonical'
import { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import { projectGuestQuerySource } from './guest-query-projection'
import type { GuestQuerySource } from './guest-query-source'
import {
  prepareGuestStructuredSnapshot,
  normalizeGuestQueryText,
  type GuestQueryEvidence,
  type GuestStructuredSnapshot,
} from './guest-structured-query'

export const GUEST_QUERY_CANONICAL_COMPILER_CONTRACT =
  `${GUEST_QUERY_CANONICAL_CONTRACT}:entity-domain-v1:scoped-alias-v2:product-identity-metadata-v1` as const

const id = z.string().trim().min(1).max(191)
const timestamp = z.string().datetime({ offset: true })
export const MAX_CANONICAL_QUERY_GRAPH_WORK = 2_000_000
const publishedModule = z
  .object({
    moduleId: id,
    revisionId: id,
    kind: z.enum(['ITEM', 'SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP']),
    version: z.number().int().positive(),
    payload: GeneralizedContentPayload,
    publicationId: id,
    publicationOrder: z
      .string()
      .regex(/^[0-9]+$/u)
      .max(100),
    audience: z.literal('PUBLIC'),
    effectiveFrom: timestamp.nullable(),
    effectiveUntil: timestamp.nullable(),
    evidence: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(500),
            locator: z.string().min(1).max(2000).nullable(),
            capturedAt: timestamp,
            excerptHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/iu)
              .nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()

export type GuestCanonicalSourceBody = {
  key: string
  text: string
  moduleId: string
  revisionId: string
  kind: EffectivePublishedUniversalContentSnapshot['kind']
  snapshot: EffectivePublishedUniversalContentSnapshot
}

export type GuestCanonicalKnowledgeScope = {
  disposition: 'FULLY_SCOPED'
  snapshot: EffectivePublishedUniversalContentSnapshot
  placeKeys: string[]
} | {
  disposition: 'IDENTITY_SCOPED_PRODUCT_METADATA'
  snapshot: EffectivePublishedUniversalContentSnapshot
}

// Opaque proof is owned by this exact private prepared snapshot, never caller-authored scopes.
const productMetadataIssuer = Symbol('product-metadata-compiler-issuer')
class ProductMetadataProof {
  #prepared: ReturnType<typeof prepareGuestStructuredSnapshot>
  #rows: Map<string, EffectivePublishedUniversalContentSnapshot>
  constructor(prepared: ReturnType<typeof prepareGuestStructuredSnapshot>, rows: EffectivePublishedUniversalContentSnapshot[], issuer: symbol) {
    if (issuer !== productMetadataIssuer) throw new Error('Product metadata proof requires compiler authority')
    this.#prepared = prepared
    this.#rows = new Map(rows.map(row => [row.moduleId, structuredClone(row)]))
    Object.freeze(this)
  }
  static read(proof: unknown, prepared: ReturnType<typeof prepareGuestStructuredSnapshot>, id: string) {
    if (!proof || typeof proof !== 'object' || !(#rows in proof) || proof.#prepared !== prepared) return undefined
    const row = proof.#rows.get(id)
    return row ? structuredClone(row) : undefined
  }
}
export function identityScopedProductMetadata(proof: unknown, prepared: ReturnType<typeof prepareGuestStructuredSnapshot>, moduleId: string) {
  return ProductMetadataProof.read(proof, prepared, moduleId)
}

/** Pure compilation of an admitted source, never a publication or visibility grant. */
export function compileGuestQueryCanonicalSource(source: GuestQuerySource) {
  const owned = structuredClone(source)
  const snapshot: GuestStructuredSnapshot = projectGuestQuerySource(owned)
  const unresolvedReasons: Array<{ moduleId: string; reason: string }> = []
  const unresolvedKeys = new Set<string>()
  const related = new Map<string, Set<string>>()
  const emitted = new Map<string, GuestCanonicalSourceBody>()
  const knowledgeScopes: GuestCanonicalKnowledgeScope[] = []
  const productMetadata: EffectivePublishedUniversalContentSnapshot[] = []
  let graphWork = 0
  const work = (amount = 1) => {
    graphWork += amount
    if (graphWork > MAX_CANONICAL_QUERY_GRAPH_WORK)
      throw new Error('Canonical query graph work exceeds its bound')
  }
  const sidecar = owned.canonicalModules
  const places = new Set(owned.directory.places.map((place) => place.id))
  if (places.size !== owned.directory.places.length)
    throw new Error('Duplicate canonical place identity')
  const unresolved = (moduleId: string, reason: string) => {
    const key = JSON.stringify([moduleId, reason])
    if (!unresolvedKeys.has(key)) {
      unresolvedKeys.add(key)
      unresolvedReasons.push({ moduleId, reason })
    }
  }
  const finish = (canonicalAuthority: boolean) => {
    const canonicalSources = [...emitted.values()].sort((a, b) => a.key.localeCompare(b.key))
    snapshot.evidenceKeys = [
      ...snapshot.records.map((record) => record.key),
      ...canonicalSources.map((body) => body.key),
    ]
    const prepared = prepareGuestStructuredSnapshot(snapshot)
    return {
      contract: GUEST_QUERY_CANONICAL_COMPILER_CONTRACT,
      snapshot,
      prepared,
      productMetadataProof: new ProductMetadataProof(prepared, productMetadata, productMetadataIssuer),
      canonicalAuthority,
      canonicalSources,
      knowledgeScopes,
      relatedKeysByPlace: Object.fromEntries(
        [...related]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, values]) => [key, [...values].sort()]),
      ) as Record<string, string[]>,
      policyCoverage: 'UNKNOWN' as const,
      unresolvedReasons,
    }
  }
  if (!sidecar) return finish(false)
  if (
    sidecar.contract !== 'published-query-source-v1' ||
    !Array.isArray(sidecar.modules) ||
    sidecar.modules.length > 10000
  )
    throw new Error('Invalid canonical source contract or bound')
  const now = timestamp.parse(owned.asOf)
  const asOf = Date.parse(now)
  const modules = new Map<string, EffectivePublishedUniversalContentSnapshot>()
  const revisions = new Set<string>()
  const identities = new Set<string>()
  for (const raw of sidecar.modules) {
    publishedModule.parse(raw)
    if (raw.kind !== raw.payload.kind) throw new Error('Canonical payload kind mismatch')
    if (identities.has(raw.moduleId) || revisions.has(raw.revisionId))
      throw new Error('Duplicate canonical module or revision identity')
    identities.add(raw.moduleId)
    revisions.add(raw.revisionId)
    const from = raw.effectiveFrom === null ? -Infinity : Date.parse(raw.effectiveFrom)
    const until = raw.effectiveUntil === null ? Infinity : Date.parse(raw.effectiveUntil)
    if (until <= from) throw new Error('Invalid canonical effective interval')
    if (
      from > asOf ||
      until <= asOf ||
      (raw.payload.kind === 'OPERATIONAL_FACT' &&
        raw.payload.expiresAt &&
        Date.parse(raw.payload.expiresAt) <= asOf)
    ) {
      unresolved(raw.moduleId, 'NOT_CURRENT')
      continue
    }
    if ('placeId' in raw.payload && raw.payload.placeId && !places.has(raw.payload.placeId)) {
      unresolved(raw.moduleId, 'PLACE_NOT_AUTHORIZED')
      continue
    }
    modules.set(raw.moduleId, raw)
  }
  const sourceKey = (module: EffectivePublishedUniversalContentSnapshot) =>
    `canonical:${module.revisionId}`
  const attach = (placeId: string, rows: EffectivePublishedUniversalContentSnapshot[]) => {
    const key = `place:${placeId}`
    let keys = related.get(key)
    if (!keys) related.set(key, (keys = new Set()))
    for (const module of rows) {
      work()
      const moduleKey = sourceKey(module)
      keys.add(moduleKey)
      if (!emitted.has(moduleKey))
        emitted.set(moduleKey, {
          key: moduleKey,
          text: JSON.stringify(module),
          moduleId: module.moduleId,
          revisionId: module.revisionId,
          kind: module.kind,
          snapshot: structuredClone(module),
        })
    }
  }
  const modulePlaces = new Map<string, Set<string>>()
  for (const module of modules.values())
    if ('placeId' in module.payload && module.payload.placeId)
      modulePlaces.set(module.moduleId, new Set([module.payload.placeId]))
  const productNames = new Map<string, number>()
  for (const module of modules.values()) {
    work()
    if (module.payload.kind === 'ITEM' && module.payload.itemType === 'PRODUCT') {
      const key = normalizeGuestQueryText(module.payload.name)
      productNames.set(key, (productNames.get(key) ?? 0) + 1)
    }
  }
  const offers = new Map<
    string,
    Map<string, { name: string; sources: Map<string, GuestQueryEvidence> }>
  >()
  const exceptionEdges = new Map<
    string,
    Array<{
      exception: EffectivePublishedUniversalContentSnapshot
      edge: EffectivePublishedUniversalContentSnapshot
    }>
  >()
  const unresolvedExceptionPolicies = new Set<string>()
  for (const edge of modules.values()) {
    work()
    if (edge.payload.kind !== 'RELATIONSHIP') continue
    const from = modules.get(edge.payload.fromModuleId)
    const to = modules.get(edge.payload.toModuleId)
    if (
      edge.payload.relationshipType === GUEST_QUERY_EXCEPTION_RELATIONSHIP &&
      from?.payload.kind === 'POLICY' &&
      to?.payload.kind !== 'POLICY'
    )
      unresolvedExceptionPolicies.add(from.moduleId)
    if (!from || !to) {
      unresolved(edge.moduleId, 'MISSING_CURRENT_ENDPOINT')
      continue
    }
    const relationship = guestQueryCanonicalRelationship(edge.payload, from.payload, to.payload)
    if (relationship === 'OFFER' && from.payload.kind === 'SERVICE' && to.payload.kind === 'ITEM') {
      const placeId = from.payload.placeId
      if (!placeId || !places.has(placeId)) {
        unresolved(edge.moduleId, 'SELLER_PLACE_UNRESOLVED')
        continue
      }
      const productKey = normalizeGuestQueryText(to.payload.name)
      if (productNames.get(productKey) !== 1) {
        unresolved(edge.moduleId, 'AMBIGUOUS_PRODUCT_NAME')
        continue
      }
      const sources: GuestQueryEvidence[] = [
        { sourceKey: sourceKey(edge), fieldPath: 'payload.relationshipType' },
        { sourceKey: sourceKey(from), fieldPath: 'payload.placeId' },
        { sourceKey: sourceKey(to), fieldPath: 'payload.name' },
      ]
      let placeOffers = offers.get(placeId)
      if (!placeOffers) offers.set(placeId, (placeOffers = new Map()))
      let offer = placeOffers.get(productKey)
      if (!offer)
        placeOffers.set(productKey, (offer = { name: to.payload.name, sources: new Map() }))
      for (const proof of sources) {
        work()
        offer.sources.set(JSON.stringify(proof), proof)
      }
      let targets = modulePlaces.get(to.moduleId)
      if (!targets) modulePlaces.set(to.moduleId, (targets = new Set()))
      targets.add(placeId)
      attach(placeId, [edge, from, to])
    } else if (relationship === 'EXCEPTION') {
      let edges = exceptionEdges.get(to.moduleId)
      if (!edges) exceptionEdges.set(to.moduleId, (edges = []))
      edges.push({ exception: from, edge })
    } else unresolved(edge.moduleId, 'UNSUPPORTED_RELATIONSHIP_OR_ENDPOINT_KIND')
  }
  snapshot.records = snapshot.records.map((record) => {
    const values = record.key.startsWith('place:') ? offers.get(record.key.slice(6)) : undefined
    const deduplicated = [...(values?.values() ?? [])].map((offer) => ({
      name: offer.name,
      sources: [...offer.sources.values()],
    }))
    return values?.size
      ? {
          ...record,
          products: {
            state: 'KNOWN' as const,
            completeness: 'POSITIVE_ONLY' as const,
            sources: deduplicated.flatMap((offer) => offer.sources),
            offers: deduplicated,
          },
        }
      : record
  })
  const policies = new Map<
    string,
    { row: EffectivePublishedUniversalContentSnapshot; targets: Set<string> }
  >()
  const exceptionIds = new Set(
    [...exceptionEdges.values()].flatMap((edges) =>
      edges.map(({ exception }) => exception.moduleId),
    ),
  )
  for (const policy of modules.values()) {
    if (policy.payload.kind !== 'POLICY') continue
    if (!policy.payload.appliesTo.length && !exceptionIds.has(policy.moduleId))
      unresolved(policy.moduleId, 'POLICY_SCOPE_UNDECLARED')
    const targets = new Set<string>()
    let valid = true
    for (const targetId of policy.payload.appliesTo) {
      work()
      const bound = modulePlaces.get(targetId)
      if (!modules.has(targetId) || !bound?.size) {
        unresolved(policy.moduleId, 'POLICY_TARGET_UNRESOLVED')
        valid = false
      } else targets.add(targetId)
    }
    if (valid) policies.set(policy.moduleId, { row: policy, targets })
  }
  const bases = new Map<
    string,
    Array<{ policyId: string; edge: EffectivePublishedUniversalContentSnapshot }>
  >()
  for (const [baseId, edges] of exceptionEdges)
    for (const { exception, edge } of edges) {
      work()
      let rows = bases.get(exception.moduleId)
      if (!rows) bases.set(exception.moduleId, (rows = []))
      rows.push({ policyId: baseId, edge })
    }
  // Scope intersections use exact current module identities, never coincident place bindings.
  // Explicit scopes constrain every governing ancestor. Empty exception scopes may inherit only
  // through this exact edge contract. No explicit scope in a cycle establishes applicability.
  const effectiveTargets = new Map<string, Set<string>>()
  for (const policy of policies.values()) {
    const queue = [policy.row.moduleId]
    const seen = new Set<string>()
    let intersection: Set<string> | undefined
    let valid = true
    for (let position = 0; position < queue.length; position++) {
      work()
      const current = queue[position]!
      if (seen.has(current)) {
        unresolved(policy.row.moduleId, 'EXCEPTION_CYCLE_OR_REPEATED_PATH')
        continue
      }
      seen.add(current)
      const ancestor = policies.get(current)
      if (!ancestor || unresolvedExceptionPolicies.has(current)) {
        unresolved(policy.row.moduleId, 'EXCEPTION_SCOPE_UNRESOLVED')
        valid = false
        continue
      }
      if (ancestor.targets.size) {
        work(ancestor.targets.size)
        intersection =
          intersection === undefined
            ? new Set(ancestor.targets)
            : new Set(
                [...intersection].filter((target) => {
                  work()
                  return ancestor.targets.has(target)
                }),
              )
      }
      for (const base of bases.get(current) ?? []) {
        work()
        queue.push(base.policyId)
      }
    }
    if (intersection?.size === 0) {
      unresolved(policy.row.moduleId, 'EXCEPTION_SCOPE_CONFLICT')
      valid = false
    }
    if (intersection === undefined && bases.has(policy.row.moduleId))
      unresolved(policy.row.moduleId, 'EXCEPTION_SCOPE_UNRESOLVED')
    if (valid && intersection?.size) effectiveTargets.set(policy.row.moduleId, intersection)
  }
  // Merge all roots at their exact target identity. Every whole rule/edge is attached once per
  // target instead of walking the same connected closure again for every applicable policy.
  const policiesByTarget = new Map<string, Set<string>>()
  for (const [policyId, targets] of effectiveTargets)
    for (const target of targets) {
      work()
      let ids = policiesByTarget.get(target)
      if (!ids) policiesByTarget.set(target, (ids = new Set()))
      ids.add(policyId)
    }
  for (const [target, policyIds] of policiesByTarget) {
    for (const placeId of modulePlaces.get(target) ?? []) {
      for (const policyId of policyIds) {
        const row = policies.get(policyId)!.row
        attach(placeId, [row])
        if (row.payload.kind === 'POLICY')
          attach(
            placeId,
            row.payload.appliesTo.flatMap((target) => {
              const module = modules.get(target)
              return module ? [module] : []
            }),
          )
        for (const { policyId: baseId, edge } of bases.get(policyId) ?? [])
          if (policyIds.has(baseId)) attach(placeId, [edge])
      }
    }
  }
  // This separate, conservative proof is only for suppressing materialized Knowledge aliases.
  // Attachment alone is insufficient: a partially resolved scope may still attach some bodies.
  const tainted = new Set(unresolvedReasons.map((row) => row.moduleId))
  for (const edge of modules.values()) {
    if (edge.payload.kind !== 'RELATIONSHIP' || !tainted.has(edge.moduleId)) continue
    tainted.add(edge.payload.fromModuleId)
    tainted.add(edge.payload.toModuleId)
  }
  const completePlaces = new Map<string, Set<string>>()
  for (const module of modules.values()) {
    const payload = module.payload
    if (
      tainted.has(module.moduleId) ||
      (payload.kind !== 'SERVICE' &&
        !(payload.kind === 'ITEM' && payload.itemType === 'PRODUCT')) ||
      (payload.kind === 'ITEM' && productNames.get(normalizeGuestQueryText(payload.name)) !== 1)
    )
      continue
    const bound = modulePlaces.get(module.moduleId)
    if (bound?.size) completePlaces.set(module.moduleId, new Set(bound))
  }
  for (const policy of policies.values()) {
    const queue = [policy.row.moduleId]
    const seen = new Set<string>()
    let complete = true
    for (let position = 0; position < queue.length; position++) {
      work()
      const current = queue[position]!
      if (seen.has(current) || tainted.has(current)) {
        complete = false
        continue
      }
      seen.add(current)
      const ancestor = policies.get(current)
      if (!ancestor || ancestor.row.payload.kind !== 'POLICY') {
        complete = false
        continue
      }
      for (const target of ancestor.row.payload.appliesTo) {
        work()
        if (!completePlaces.has(target)) complete = false
      }
      for (const base of bases.get(current) ?? []) queue.push(base.policyId)
    }
    const targets = effectiveTargets.get(policy.row.moduleId)
    if (!complete || !targets?.size) continue
    const bound = new Set<string>()
    for (const target of targets) {
      for (const placeId of completePlaces.get(target) ?? []) {
        work()
        bound.add(placeId)
      }
    }
    if (bound.size) completePlaces.set(policy.row.moduleId, bound)
  }
  // Governed PRODUCT descriptions describe only their own identity. This is not a
  // syntax proof about prose, an offer, or a complete policy applicability declaration.
  for (const module of modules.values()) {
    work()
    const payload = module.payload
    if (payload.kind !== 'ITEM' || payload.itemType !== 'PRODUCT' || tainted.has(module.moduleId) || productNames.get(normalizeGuestQueryText(payload.name)) !== 1) continue
    productMetadata.push(module)
    if (!completePlaces.has(module.moduleId)) knowledgeScopes.push({
      disposition: 'IDENTITY_SCOPED_PRODUCT_METADATA', snapshot: structuredClone(module),
    })
  }
  for (const [moduleId, bound] of completePlaces) {
    const module = modules.get(moduleId)!
    knowledgeScopes.push({
      disposition: 'FULLY_SCOPED',
      snapshot: structuredClone(module),
      placeKeys: [...bound].sort().map((placeId) => `place:${placeId}`),
    })
  }
  return finish(true)
}
