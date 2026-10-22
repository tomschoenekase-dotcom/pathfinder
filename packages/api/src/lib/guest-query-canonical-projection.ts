import { createHash } from 'node:crypto'
import { guestQueryTiming } from './guest-query-timing'
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
  type PreparedGuestSnapshot,
} from './guest-structured-query'

const ownedEvidence = new WeakMap<
  object,
  {
    source: string
    knowledgeScopes: GuestCanonicalKnowledgeScope[]
    lookupScopes: GuestCanonicalKnowledgeScope[]
    currentModules: EffectivePublishedUniversalContentSnapshot[]
    relatedKeysByPlace: Record<string, string[]>
    canonicalSources: GuestCanonicalSourceBody[]
    subjectModules: EffectivePublishedUniversalContentSnapshot[]
    subjectOffers: Array<{ edgeId: string; serviceId: string; productId: string; placeId: string }>
    subjectPolicyScopes: Array<{ moduleId: string; targetModuleIds: string[] }>
    subjectPolicyApplicability: Array<{ moduleId: string; targetModuleIds: string[] }>
    subjectFactApplicability: GuestFactApplicabilityProof[]
  }
>()
/** Compiler-issued whole-source scope only; public metadata cannot authorize omissions. */
export function guestCanonicalEvidenceAuthority(
  prepared: PreparedGuestSnapshot,
  source: GuestQuerySource,
) {
  return guestQueryTiming('authority', () => {
    const proof = ownedEvidence.get(prepared)
    if (
      !proof ||
      proof.source !== guestQueryTiming('authority.stringify', () => JSON.stringify(source))
    )
      throw new Error('Current compiler-owned source authority required')
    return guestQueryTiming('authority.clone', () =>
      structuredClone({
        knowledgeScopes: proof.knowledgeScopes,
        lookupScopes: proof.lookupScopes,
        currentModules: proof.currentModules,
        relatedKeysByPlace: proof.relatedKeysByPlace,
        canonicalSources: proof.canonicalSources,
        subjectModules: proof.subjectModules,
        subjectOffers: proof.subjectOffers,
        subjectPolicyScopes: proof.subjectPolicyScopes,
        subjectPolicyApplicability: proof.subjectPolicyApplicability,
        subjectFactApplicability: proof.subjectFactApplicability,
      }),
    )
  })
}

export const GUEST_QUERY_CANONICAL_COMPILER_CONTRACT =
  `${GUEST_QUERY_CANONICAL_CONTRACT}:entity-domain-v1:scoped-alias-v2:product-identity-metadata-v1:fact-applicability-v1` as const

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

/**
 * Compiler-certified authored applicability of one exact current fact revision. VENUE never
 * permits omission. SUBJECTS permits omitting this whole body only from evidence that selects
 * none of its listed subjects or places.
 */
export type GuestFactApplicabilityProof =
  | { moduleId: string; revisionId: string; publicationId: string; scope: 'VENUE' }
  | {
      moduleId: string
      revisionId: string
      publicationId: string
      scope: 'SUBJECTS'
      subjectModuleIds: string[]
      placeIds: string[]
    }

export type GuestCanonicalKnowledgeScope =
  | {
      disposition: 'FULLY_SCOPED'
      snapshot: EffectivePublishedUniversalContentSnapshot
      placeKeys: string[]
    }
  | {
      disposition: 'IDENTITY_SCOPED_PRODUCT_METADATA'
      snapshot: EffectivePublishedUniversalContentSnapshot
    }

// Opaque proof is owned by this exact private prepared snapshot, never caller-authored scopes.
const productMetadataIssuer = Symbol('product-metadata-compiler-issuer')
class ProductMetadataProof {
  #prepared: ReturnType<typeof prepareGuestStructuredSnapshot>
  #rows: Map<string, EffectivePublishedUniversalContentSnapshot>
  constructor(
    prepared: ReturnType<typeof prepareGuestStructuredSnapshot>,
    rows: EffectivePublishedUniversalContentSnapshot[],
    issuer: symbol,
  ) {
    if (issuer !== productMetadataIssuer)
      throw new Error('Product metadata proof requires compiler authority')
    this.#prepared = prepared
    this.#rows = new Map(rows.map((row) => [row.moduleId, structuredClone(row)]))
    Object.freeze(this)
  }
  static read(
    proof: unknown,
    prepared: ReturnType<typeof prepareGuestStructuredSnapshot>,
    id: string,
  ) {
    if (!proof || typeof proof !== 'object' || !(#rows in proof) || proof.#prepared !== prepared)
      return undefined
    const row = proof.#rows.get(id)
    return row ? structuredClone(row) : undefined
  }
}
export function identityScopedProductMetadata(
  proof: unknown,
  prepared: ReturnType<typeof prepareGuestStructuredSnapshot>,
  moduleId: string,
) {
  return ProductMetadataProof.read(proof, prepared, moduleId)
}

/** Pure compilation of an admitted source, never a publication or visibility grant. */
export function compileGuestQueryCanonicalSource(source: GuestQuerySource) {
  return compileCanonicalSource(source, false)
}

function compileCanonicalSource(source: GuestQuerySource, retainReusable: boolean) {
  const owned = guestQueryTiming('compile.clone', () => structuredClone(source))
  const snapshot: GuestStructuredSnapshot = projectGuestQuerySource(owned)
  const unresolvedReasons: Array<{ moduleId: string; reason: string }> = []
  const unresolvedKeys = new Set<string>()
  const related = new Map<string, Set<string>>()
  const emitted = new Map<string, GuestCanonicalSourceBody>()
  const knowledgeScopes: GuestCanonicalKnowledgeScope[] = []
  const lookupRelationshipScopes: GuestCanonicalKnowledgeScope[] = []
  const lookupCurrentModules: EffectivePublishedUniversalContentSnapshot[] = []
  const subjectModules: EffectivePublishedUniversalContentSnapshot[] = []
  const subjectOffers: Array<{
    edgeId: string
    serviceId: string
    productId: string
    placeId: string
  }> = []
  const subjectPolicyScopes: Array<{ moduleId: string; targetModuleIds: string[] }> = []
  const subjectPolicyApplicability: Array<{ moduleId: string; targetModuleIds: string[] }> = []
  const subjectFactApplicability: GuestFactApplicabilityProof[] = []
  const factApplicabilityRejections: Array<{ moduleId: string; reason: string }> = []
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
    const prepared = guestQueryTiming('compile.snapshot', () =>
      prepareGuestStructuredSnapshot(snapshot),
    )
    ownedEvidence.set(prepared, {
      source: guestQueryTiming('compile.authority.stringify', () => JSON.stringify(owned)),
      knowledgeScopes: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(knowledgeScopes),
      ),
      lookupScopes: guestQueryTiming('compile.authority.clone', () =>
        structuredClone([...knowledgeScopes, ...lookupRelationshipScopes]),
      ),
      currentModules: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(lookupCurrentModules),
      ),
      relatedKeysByPlace: Object.fromEntries(
        [...related]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, values]) => [key, [...values].sort()]),
      ),
      canonicalSources: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(canonicalSources),
      ),
      subjectModules: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(subjectModules),
      ),
      subjectOffers: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(subjectOffers),
      ),
      subjectPolicyScopes: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(subjectPolicyScopes),
      ),
      subjectPolicyApplicability: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(subjectPolicyApplicability),
      ),
      subjectFactApplicability: guestQueryTiming('compile.authority.clone', () =>
        structuredClone(subjectFactApplicability),
      ),
    })
    const compiled = {
      contract: GUEST_QUERY_CANONICAL_COMPILER_CONTRACT,
      snapshot,
      prepared,
      productMetadataProof: new ProductMetadataProof(
        prepared,
        productMetadata,
        productMetadataIssuer,
      ),
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
      factApplicabilityRejections,
    }
    if (retainReusable && guestQuerySourceIsTemporallyAdmitted(owned)) {
      const proof = ownedEvidence.get(prepared)!
      const { source: _source, ...authority } = proof
      void _source
      const {
        prepared: _prepared,
        productMetadataProof: _productProof,
        snapshot: _snapshot,
        ...fields
      } = compiled
      void _prepared
      void _productProof
      void _snapshot
      const serialized = JSON.stringify({
        snapshot: withoutObservationTime(snapshot),
        fields,
        authority,
        productMetadata,
      })
      const fingerprint = guestQueryReusableSourceFingerprint(owned)
      const handle = Object.freeze({
        serializedBytes:
          Buffer.byteLength(serialized, 'utf8') +
          Buffer.byteLength(owned.version, 'utf8') +
          Buffer.byteLength(fingerprint, 'utf8'),
      })
      reusablePayloads.set(handle, { serialized, version: owned.version, fingerprint })
      reusableByPrepared.set(prepared, handle)
    }
    return compiled
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
    // A public subject body remains evidence even if its location is not guest-authorized.
    // It does not enter QUERY compilation or grant access to that place.
    subjectModules.push(raw)
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
  const nonProductItemNames = new Map<string, number>()
  const eventNames = new Map<string, number>()
  for (const module of modules.values()) {
    work()
    if (module.payload.kind === 'ITEM' && module.payload.itemType === 'PRODUCT') {
      const key = normalizeGuestQueryText(module.payload.name)
      productNames.set(key, (productNames.get(key) ?? 0) + 1)
    } else if (module.payload.kind === 'ITEM') {
      const key = normalizeGuestQueryText(module.payload.name)
      nonProductItemNames.set(key, (nonProductItemNames.get(key) ?? 0) + 1)
    } else if (module.payload.kind === 'EVENT') {
      const key = normalizeGuestQueryText(module.payload.name)
      eventNames.set(key, (eventNames.get(key) ?? 0) + 1)
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
      subjectOffers.push({
        edgeId: edge.moduleId,
        serviceId: from.moduleId,
        productId: to.moduleId,
        placeId,
      })
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
  // An explicitly located non-product ITEM or EVENT describes its own visitor identity, just as a
  // SERVICE does. Only current, untainted, uniquely named bodies with a public place
  // receive omission authority; place metadata never becomes a product offering link.
  const completePlaces = new Map<string, Set<string>>()
  for (const module of modules.values()) {
    const payload = module.payload
    if (
      tainted.has(module.moduleId) ||
      (payload.kind !== 'SERVICE' && payload.kind !== 'ITEM' && payload.kind !== 'EVENT') ||
      (payload.kind === 'EVENT' && eventNames.get(normalizeGuestQueryText(payload.name)) !== 1) ||
      (payload.kind === 'ITEM' &&
        (payload.itemType === 'PRODUCT' ? productNames : nonProductItemNames).get(
          normalizeGuestQueryText(payload.name),
        ) !== 1)
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
    if (
      payload.kind !== 'ITEM' ||
      payload.itemType !== 'PRODUCT' ||
      tainted.has(module.moduleId) ||
      productNames.get(normalizeGuestQueryText(payload.name)) !== 1
    )
      continue
    productMetadata.push(module)
    if (!completePlaces.has(module.moduleId))
      knowledgeScopes.push({
        disposition: 'IDENTITY_SCOPED_PRODUCT_METADATA',
        snapshot: structuredClone(module),
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
  lookupCurrentModules.push(...modules.values())
  for (const [moduleId, targets] of effectiveTargets)
    if (completePlaces.has(moduleId))
      subjectPolicyScopes.push({ moduleId, targetModuleIds: [...targets].sort() })
  // Lookup-only whole relationship scope. No new query facts or policy applicability
  // are created: both endpoints must already have complete compiler-issued scope.
  // This optional omission proof has its own budget. Exhaustion keeps remaining
  // bodies conservative; it must never change historical QUERY compilation admission.
  let lookupWork = 0
  for (const edge of modules.values()) {
    if (++lookupWork > MAX_CANONICAL_QUERY_GRAPH_WORK) break
    if (edge.payload.kind !== 'RELATIONSHIP' || tainted.has(edge.moduleId)) continue
    const from = modules.get(edge.payload.fromModuleId)
    const to = modules.get(edge.payload.toModuleId)
    if (!from || !to || tainted.has(from.moduleId) || tainted.has(to.moduleId)) continue
    const relationship = guestQueryCanonicalRelationship(edge.payload, from.payload, to.payload)
    const fromPlaces = completePlaces.get(from.moduleId)
    const toPlaces = completePlaces.get(to.moduleId)
    if (!relationship || !fromPlaces?.size || !toPlaces?.size) continue
    const targets: string[] = []
    for (const placeId of fromPlaces) {
      if (++lookupWork > MAX_CANONICAL_QUERY_GRAPH_WORK) break
      if (toPlaces.has(placeId)) targets.push(placeId)
    }
    if (lookupWork > MAX_CANONICAL_QUERY_GRAPH_WORK) break
    if (targets.length)
      lookupRelationshipScopes.push({
        disposition: 'FULLY_SCOPED',
        snapshot: structuredClone(edge),
        placeKeys: targets.sort().map((placeId) => `place:${placeId}`),
      })
  }
  subjectPolicyApplicability.push(...certifySubjectPolicyApplicability(subjectModules))
  const facts = certifySubjectFactApplicability(subjectModules, owned.directory.places)
  subjectFactApplicability.push(...facts.certified)
  factApplicabilityRejections.push(...facts.rejected)
  return finish(true)
}

/**
 * Wording that a complete subject declaration must not carry: it can quantify over other
 * subjects ("every outdoor ride", "the rest of the zoo"). This is a fail-closed lint with known
 * false positives and false negatives, never proof of meaning. Authored review owns semantics.
 */
const VENUE_WIDE_MARKERS = new Set([
  'all',
  'any',
  'anyone',
  'anything',
  'anywhere',
  'each',
  'elsewhere',
  'entire',
  'every',
  'everybody',
  'everyone',
  'everything',
  'everywhere',
  'other',
  'others',
  'rest',
  'throughout',
  'whole',
  'wide',
])
const WORD = /[\p{L}\p{N}\p{M}_]/u
type NameNode = { children: Map<string, NameNode>; keys?: Set<string> }

/**
 * Certifies authored fact applicability against the current public subjects of this exact
 * source. Identity: each target is a current public SERVICE/ITEM/EVENT module or visible place
 * with a unique normalized name. Freshness: the claim lives in the fact revision itself and is
 * re-checked every compile, so a withdrawn, hidden, expired, renamed-into-ambiguity or wrong-kind
 * target certifies nothing. Completeness: the body may not name any other current subject or
 * place, nor use venue-wide wording. Any failure, or exhausting its own budget, leaves the
 * fact's scope unknown, so it stays whole. It never changes QUERY admission.
 */
function certifySubjectFactApplicability(
  current: readonly EffectivePublishedUniversalContentSnapshot[],
  places: readonly GuestQuerySource['directory']['places'][number][],
) {
  const certified: GuestFactApplicabilityProof[] = []
  const rejected: Array<{ moduleId: string; reason: string }> = []
  const declared = current.filter(
    (m) => m.payload.kind === 'OPERATIONAL_FACT' && m.payload.applicability !== undefined,
  )
  if (!declared.length) return { certified, rejected }
  let budget = 0
  const spend = (amount = 1) => (budget += amount) <= MAX_CANONICAL_QUERY_GRAPH_WORK
  const identities = new Map<string, string>()
  for (const m of current) {
    const p = m.payload
    if (p.kind === 'SERVICE' || p.kind === 'ITEM' || p.kind === 'EVENT')
      identities.set(`module:${m.moduleId}`, normalizeGuestQueryText(p.name))
  }
  for (const place of places)
    identities.set(`place:${place.id}`, normalizeGuestQueryText(place.name))
  const nameCounts = new Map<string, number>()
  const root: NameNode = { children: new Map() }
  for (const [key, name] of identities) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    let node = root
    for (const character of name) {
      if (!spend()) return exhausted()
      let next = node.children.get(character)
      if (!next) node.children.set(character, (next = { children: new Map() }))
      node = next
    }
    node.keys ??= new Set()
    node.keys.add(key)
  }
  function exhausted() {
    const decided = new Set([...certified, ...rejected].map((row) => row.moduleId))
    for (const m of declared)
      if (!decided.has(m.moduleId))
        rejected.push({ moduleId: m.moduleId, reason: 'APPLICABILITY_WORK_BOUND' })
    return { certified, rejected }
  }
  for (const fact of declared) {
    const p = fact.payload
    if (p.kind !== 'OPERATIONAL_FACT' || !p.applicability) continue
    const ids = {
      moduleId: fact.moduleId,
      revisionId: fact.revisionId,
      publicationId: fact.publicationId,
    }
    if (p.applicability.scope === 'VENUE') {
      certified.push({ ...ids, scope: 'VENUE' })
      continue
    }
    const { subjectModuleIds, placeIds } = p.applicability
    const targets = new Set([
      ...subjectModuleIds.map((id) => `module:${id}`),
      ...placeIds.map((id) => `place:${id}`),
    ])
    const reject = (reason: string) => rejected.push({ moduleId: fact.moduleId, reason })
    if (!targets.size || targets.size !== subjectModuleIds.length + placeIds.length) {
      reject('MALFORMED_APPLICABILITY')
      continue
    }
    if ([...targets].some((key) => !identities.has(key))) {
      reject('TARGET_NOT_CURRENT_PUBLIC_SUBJECT')
      continue
    }
    if ([...targets].some((key) => nameCounts.get(identities.get(key)!) !== 1)) {
      reject('AMBIGUOUS_TARGET_NAME')
      continue
    }
    const characters = [...normalizeGuestQueryText(`${p.label}\n${p.value}`)]
    if (!spend(characters.length)) return exhausted()
    let reason: string | undefined
    let wordStart = -1
    for (let start = 0; start <= characters.length && !reason; start++) {
      const isWord = start < characters.length && WORD.test(characters[start]!)
      if (isWord && wordStart < 0) wordStart = start
      if (!isWord && wordStart >= 0) {
        if (VENUE_WIDE_MARKERS.has(characters.slice(wordStart, start).join('')))
          reason = 'VENUE_WIDE_WORDING'
        wordStart = -1
      }
      if (start === characters.length || (start > 0 && WORD.test(characters[start - 1]!))) continue
      let node: NameNode | undefined = root
      for (let end = start; end < characters.length; end++) {
        if (!spend()) return exhausted()
        node = node.children.get(characters[end]!)
        if (!node) break
        if (
          node.keys &&
          !(end + 1 < characters.length && WORD.test(characters[end + 1]!)) &&
          [...node.keys].some((key) => !targets.has(key))
        ) {
          reason = 'MENTIONS_UNDECLARED_SUBJECT'
          break
        }
      }
    }
    if (reason) {
      reject(reason)
      continue
    }
    certified.push({
      ...ids,
      scope: 'SUBJECTS',
      subjectModuleIds: [...subjectModuleIds].sort(),
      placeIds: [...placeIds].sort(),
    })
  }
  return { certified, rejected }
}

/**
 * Which current public subjects each current public policy governs, for name-resolved subject
 * facts only. This is separate from place-complete omission scope: a service whose place is
 * hidden or absent, or that sells an ambiguously named product, still has exactly its declared
 * rules. It never authorizes omitting a body or attaching evidence to a place. Any missing,
 * malformed, cyclic or repeated exception path, any non-current target, or an empty scope
 * intersection certifies nothing. Its own budget never changes QUERY compilation admission.
 */
function certifySubjectPolicyApplicability(
  current: readonly EffectivePublishedUniversalContentSnapshot[],
) {
  const byId = new Map(current.map((m) => [m.moduleId, m]))
  const basesOf = new Map<string, string[]>()
  const broken = new Set<string>()
  let budget = 0
  const spend = (amount = 1) => (budget += amount) <= MAX_CANONICAL_QUERY_GRAPH_WORK
  for (const edge of current) {
    if (!spend()) return []
    const p = edge.payload
    if (p.kind !== 'RELATIONSHIP' || p.relationshipType !== GUEST_QUERY_EXCEPTION_RELATIONSHIP)
      continue
    const from = byId.get(p.fromModuleId),
      to = byId.get(p.toModuleId)
    // A non-current exception does not narrow a current base policy.
    if (!from) continue
    if (to && guestQueryCanonicalRelationship(p, from.payload, to.payload) === 'EXCEPTION') {
      const bases = basesOf.get(from.moduleId) ?? []
      bases.push(to.moduleId)
      basesOf.set(from.moduleId, bases)
    } else if (from.payload.kind === 'POLICY') broken.add(from.moduleId)
    // A malformed current exception claim leaves its policy target's effective scope unknown.
    else if (to?.payload.kind === 'POLICY') broken.add(to.moduleId)
  }
  const certified: Array<{ moduleId: string; targetModuleIds: string[] }> = []
  for (const policy of current) {
    if (policy.payload.kind !== 'POLICY') continue
    const queue = [policy.moduleId]
    const seen = new Set<string>()
    let intersection: Set<string> | undefined
    let valid = true
    for (let i = 0; valid && i < queue.length; i++) {
      if (!spend()) return certified
      const id = queue[i]!
      const ancestor = byId.get(id)
      if (seen.has(id) || broken.has(id) || ancestor?.payload.kind !== 'POLICY') {
        valid = false
        break
      }
      seen.add(id)
      const targets = new Set(ancestor.payload.appliesTo)
      if (!spend(targets.size + (intersection?.size ?? 0))) return certified
      if ([...targets].some((target) => !byId.has(target))) valid = false
      else if (targets.size)
        intersection =
          intersection === undefined
            ? targets
            : new Set([...intersection].filter((target) => targets.has(target)))
      queue.push(...(basesOf.get(id) ?? []))
    }
    if (valid && intersection?.size)
      certified.push({ moduleId: policy.moduleId, targetModuleIds: [...intersection].sort() })
  }
  return certified
}

/** A lookalike handle cannot register compiler authority: payloads stay in this private WeakMap. */
export type GuestQueryReusableCompilation = Readonly<{ serializedBytes: number }>
const reusablePayloads = new WeakMap<
  object,
  { serialized: string; version: string; fingerprint: string }
>()
const reusableByPrepared = new WeakMap<object, GuestQueryReusableCompilation>()

function withoutObservationTime<T extends { asOf: string }>(value: T): Omit<T, 'asOf'> {
  const copy = { ...value }
  delete (copy as Partial<T>).asOf
  return copy
}

export function guestQueryReusableSourceFingerprint(source: GuestQuerySource) {
  return createHash('sha256')
    .update(JSON.stringify(withoutObservationTime(source)))
    .digest('hex')
}

/** Every raw row must still be admitted. Non-current hand-built sources always use normal compile. */
export function guestQuerySourceIsTemporallyAdmitted(source: GuestQuerySource) {
  if (!['LEGACY', 'DARK'].includes(source.readPath)) return false
  if (!timestamp.safeParse(source.asOf).success) return false
  const at = Date.parse(source.asOf)
  if (!Number.isFinite(at)) return false
  return (source.canonicalModules?.modules ?? []).every((row) => {
    const from = row.effectiveFrom === null ? -Infinity : Date.parse(row.effectiveFrom)
    const until = row.effectiveUntil === null ? Infinity : Date.parse(row.effectiveUntil)
    const expiry =
      row.payload.kind === 'OPERATIONAL_FACT' && row.payload.expiresAt
        ? Date.parse(row.payload.expiresAt)
        : Infinity
    return from <= at && at < until && from < until && at < expiry
  })
}

export function compileGuestQueryCanonicalSourceForReuse(source: GuestQuerySource) {
  const compiled = compileCanonicalSource(source, true)
  const reusable = reusableByPrepared.get(compiled.prepared)
  reusableByPrepared.delete(compiled.prepared)
  return { compiled, reusable }
}

/** Reissues fresh per-turn private brands and exact-source authority, never caller-authored scopes. */
export function rebindGuestQueryCanonicalSource(
  reusable: GuestQueryReusableCompilation,
  source: GuestQuerySource,
) {
  const payload = reusablePayloads.get(reusable)
  if (
    !payload ||
    payload.version !== source.version ||
    payload.fingerprint !== guestQueryReusableSourceFingerprint(source) ||
    !guestQuerySourceIsTemporallyAdmitted(source)
  )
    throw new Error('Exact compiler-owned source rebind required')
  const data = JSON.parse(payload.serialized) as {
    snapshot: Omit<GuestStructuredSnapshot, 'asOf'>
    fields: Omit<
      ReturnType<typeof compileGuestQueryCanonicalSource>,
      'snapshot' | 'prepared' | 'productMetadataProof'
    >
    authority: Omit<NonNullable<ReturnType<typeof ownedEvidence.get>>, 'source'>
    productMetadata: EffectivePublishedUniversalContentSnapshot[]
  }
  const snapshot = { ...data.snapshot, asOf: source.asOf }
  const prepared = prepareGuestStructuredSnapshot(snapshot)
  ownedEvidence.set(prepared, { ...data.authority, source: JSON.stringify(source) })
  return {
    ...data.fields,
    snapshot,
    prepared,
    productMetadataProof: new ProductMetadataProof(
      prepared,
      data.productMetadata,
      productMetadataIssuer,
    ),
  }
}
