import { createHash } from 'node:crypto'
import { identityScopedProductMetadata } from './guest-query-canonical-projection'
import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import type {
  compileGuestQueryCanonicalSource,
  GuestCanonicalSourceBody,
} from './guest-query-canonical-projection'
import type { GuestQuerySource } from './guest-query-source'
import {
  isPreparedGuestSnapshot,
  normalizeGuestQueryText,
  type GuestStructuredQuery,
  type GuestStructuredQueryResult,
} from './guest-structured-query'

export const GUEST_QUERY_DIRECT_ANSWER_VERSION = 'guest-query-direct-answer-v4'
export const DIRECT_ANSWER_MAX_MATCHES = 200
// Must not exceed the real guest-chat-turn-actions finalizeSchema assistantResponse bound.
export const DIRECT_ANSWER_MAX_CHARS = 10_000
export const DIRECT_ANSWER_MAX_SOURCES = 99
type Compilation = ReturnType<typeof compileGuestQueryCanonicalSource>
type Failure =
  | 'SOURCE_MISMATCH'
  | 'UNSUPPORTED_QUERY'
  | 'RESULT_BOUND'
  | 'ANSWER_BOUND'
  | 'SOURCE_BOUND'
  | 'UNSAFE_TEXT'
  | 'UNRESOLVED_SCOPE'
  | 'PAGINATION_MISMATCH'
class Decline extends Error {
  constructor(readonly reason: Failure) {
    super(reason)
  }
}

/** React text-node output: preserve punctuation, never interpret source markup or actions. */
function literal(text: string): string {
  if (typeof text !== 'string' || /[\p{Cf}\p{Cs}]/u.test(text) || text.includes('[['))
    throw new Decline('UNSAFE_TEXT')
  for (const character of text) {
    const code = character.codePointAt(0)!
    if ((code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159))
      throw new Decline('UNSAFE_TEXT')
  }
  return text.replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ')
}
const quote = (text: string) =>
  literal(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
const canonicalKey = (row: EffectivePublishedUniversalContentSnapshot) =>
  `canonical:${row.revisionId}`
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function recordUnit(domain: GuestStructuredQueryResult['domain'], count: number) {
  if (domain === 'PLACE') return count === 1 ? 'place' : 'places'
  if (domain === 'KNOWLEDGE') return count === 1 ? 'knowledge topic' : 'knowledge topics'
  return count === 1 ? 'record' : 'records'
}

/** Mirrors the protected SQL projection for only the kinds whose whole scope we compile. */
function aliasBody(snapshot: EffectivePublishedUniversalContentSnapshot) {
  const payload = snapshot.payload
  if (payload.kind === 'SERVICE')
    return {
      title: payload.name,
      content: [payload.description, payload.availability]
        .filter((part) => part != null)
        .join('\n'),
    }
  if (payload.kind === 'POLICY') return { title: payload.title, content: payload.rule }
  if (payload.kind === 'ITEM' && payload.itemType === 'PRODUCT')
    return {
      title: payload.name,
      content: [payload.description, `Item type: ${payload.itemType}`]
        .filter((part) => part != null)
        .join('\n'),
    }
  return undefined
}

function countText(result: GuestStructuredQueryResult): string {
  if (result.exactEligibleCount !== null)
    return `${result.exactEligibleCount} matching listed ${recordUnit(result.domain, result.exactEligibleCount)}.`
  return (
    `${result.knownMatchCount} confirmed matching listed ${recordUnit(result.domain, result.knownMatchCount)}. ` +
    (result.unknownCandidateCount
      ? `${result.unknownCandidateCount} other listed ${recordUnit(result.domain, result.unknownCandidateCount)} ${result.unknownCandidateCount === 1 ? 'has' : 'have'} unknown matching status. `
      : '') +
    'An exact total is not available.'
  )
}

/**
 * Supported stored-record queries only. This is not a general question-answerer or eligibility
 * solver. Caller still owns current-source/native admission and the full evidence preflight.
 */
export function formatGuestQueryDirectAnswer(input: {
  source: GuestQuerySource
  compiled: Compilation
  query: GuestStructuredQuery
}) {
  let result: GuestStructuredQueryResult | undefined
  try {
    const source = structuredClone(input.source)
    const compiled = input.compiled
    if (
      !isPreparedGuestSnapshot(compiled.prepared) ||
      compiled.prepared.scope.tenantId !== source.tenantId ||
      compiled.prepared.scope.venueId !== source.venueId ||
      compiled.prepared.sourceVersion !== source.version ||
      compiled.prepared.asOf !== source.asOf ||
      source.directory.searchVersion !== source.version ||
      source.directory.incomplete ||
      !['LEGACY', 'DARK'].includes(source.readPath)
    )
      throw new Decline('SOURCE_MISMATCH')
    if (input.query.tenantId !== source.tenantId || input.query.venueId !== source.venueId)
      throw new Decline('SOURCE_MISMATCH')
    const query = compiled.prepared.validateQuery(input.query)
    if (
      query.predicates.some(
        (predicate) =>
          predicate.field === 'feature' ||
          (predicate.field === 'product' && !compiled.canonicalAuthority),
      )
    )
      throw new Decline('UNSUPPORTED_QUERY')
    const evaluated = compiled.prepared.evaluate(query)
    result = evaluated.page(query.mode === 'list' ? { pageSize: 50 } : {})
    const first = result
    const consistency = (page: GuestStructuredQueryResult) => {
      return Object.fromEntries(
        Object.entries(page).filter(
          ([key]) => !['rows', 'returnedCount', 'hasMore', 'nextCursor'].includes(key),
        ),
      )
    }
    const identity = consistency(first)
    const rows = [...first.rows]
    if (first.knownMatchCount > DIRECT_ANSWER_MAX_MATCHES && query.mode === 'list')
      throw new Decline('RESULT_BOUND')
    const cursors = new Set<string>()
    let page = first
    while (page.hasMore) {
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Decline('PAGINATION_MISMATCH')
      cursors.add(page.nextCursor)
      page = evaluated.page({ pageSize: 50, cursor: page.nextCursor })
      if (!same(consistency(page), identity)) throw new Decline('PAGINATION_MISMATCH')
      rows.push(...page.rows)
      if (rows.length > DIRECT_ANSWER_MAX_MATCHES) throw new Decline('RESULT_BOUND')
    }
    if (
      query.mode === 'list' &&
      (rows.length !== first.knownMatchCount ||
        !same(
          rows.map((row) => row.key),
          first.matchingKeys,
        ))
    )
      throw new Decline('PAGINATION_MISMATCH')
    result = { ...first, rows, returnedCount: rows.length, hasMore: false, nextCursor: null }
    const places: GuestQuerySource['directory']['places'] = []
    const knowledge: GuestQuerySource['directory']['knowledge'] = []
    const canonicalSources: GuestCanonicalSourceBody[] = []
    const retained = new Set<string>()
    const omittedProductMetadata: Array<{ knowledgeKey: string; moduleId: string; revisionId: string; publicationId: string; reason: 'UNRELATED_PRODUCT_METADATA' | 'WHOLE_CANONICAL_METADATA_RETAINED' }> = []
    const retain = (key: string) => {
      retained.add(key)
      if (retained.size > DIRECT_ANSWER_MAX_SOURCES) throw new Decline('SOURCE_BOUND')
    }
    const pieces = [countText(result)]
    const add = (text: string) => {
      pieces.push(text)
      if (pieces.join('\n\n').length > DIRECT_ANSWER_MAX_CHARS) throw new Decline('ANSWER_BOUND')
    }
    if (query.mode === 'list') {
      const placeMap = new Map(source.directory.places.map((row) => [`place:${row.id}`, row]))
      const knowledgeMap = new Map(
        source.directory.knowledge.map((row) => [`knowledge:${row.id}`, row]),
      )
      if (
        placeMap.size !== source.directory.places.length ||
        knowledgeMap.size !== source.directory.knowledge.length
      )
        throw new Decline('SOURCE_MISMATCH')
      const published = new Map(
        source.canonicalModules?.modules.map((row) => [row.moduleId, row]) ?? [],
      )
      const canonical = new Map(compiled.canonicalSources.map((body) => [body.key, body]))
      if (canonical.size !== compiled.canonicalSources.length) throw new Decline('SOURCE_MISMATCH')
      const scopedAliases = new Map(
        compiled.knowledgeScopes.map((scope) => [scope.snapshot.moduleId, scope]),
      )
      const needed = new Set(rows.flatMap((row) => compiled.relatedKeysByPlace[row.key] ?? []))
      const productNameCounts = new Map<string, number>()
      for (const module of published.values()) if (module.payload.kind === 'ITEM' && module.payload.itemType === 'PRODUCT') {
        const name = normalizeGuestQueryText(module.payload.name)
        productNameCounts.set(name, (productNameCounts.get(name) ?? 0) + 1)
      }
      const requestedMetadata = new Set<string>()
      for (const module of published.values()) {
        const payload = module.payload
        if (payload.kind !== 'ITEM' || payload.itemType !== 'PRODUCT' || !query.predicates.some(predicate => predicate.field === 'product' && normalizeGuestQueryText(predicate.name) === normalizeGuestQueryText(payload.name))) continue
        const proof = identityScopedProductMetadata(compiled.productMetadataProof, compiled.prepared, module.moduleId)
        if (!proof) {
          // Keep the conservative alias path for tainted/ambiguous identities, but a
          // unique requested item must not silently lose its only whole current body.
          if ((productNameCounts.get(normalizeGuestQueryText(payload.name)) ?? 0) > 1) continue
          const body = aliasBody(module)
          const exactAlias = body && [...knowledgeMap.values()].some(topic => topic.sourceType === 'UNIVERSAL_CONTENT' && topic.contentModuleId === module.moduleId && topic.contentRevisionId === module.revisionId && topic.contentPublicationId === module.publicationId && topic.title === body.title && topic.category === module.kind && topic.content === body.content)
          if (!exactAlias && !canonical.has(canonicalKey(module))) throw new Decline('UNRESOLVED_SCOPE')
          if (canonical.has(canonicalKey(module))) {
            requestedMetadata.add(canonicalKey(module))
            needed.add(canonicalKey(module))
          }
          continue
        }
        if (!same(proof, module)) throw new Decline('SOURCE_MISMATCH')
        const key = canonicalKey(module)
        requestedMetadata.add(key)
        needed.add(key)
        if (!canonical.has(key)) canonical.set(key, { key, text: JSON.stringify(proof), moduleId: proof.moduleId, revisionId: proof.revisionId, kind: proof.kind, snapshot: proof })
      }
      const labels = new Map<string, string>()
      const labelOwners = new Map<string, string>()
      for (const key of needed) {
        const body = canonical.get(key)
        if (
          !body ||
          canonicalKey(body.snapshot) !== key ||
          !same(published.get(body.moduleId), body.snapshot) ||
          body.text !== JSON.stringify(body.snapshot)
        )
          throw new Decline('SOURCE_MISMATCH')
        const payload = body.snapshot.payload
        if (payload.kind === 'RELATIONSHIP') continue
        const title =
          'name' in payload ? payload.name : 'title' in payload ? payload.title : payload.label
        const place =
          'placeId' in payload && payload.placeId
            ? placeMap.get(`place:${payload.placeId}`)
            : undefined
        if ('placeId' in payload && payload.placeId && !place) throw new Decline('SOURCE_MISMATCH')
        const label = `${payload.kind === 'POLICY' ? 'rule' : payload.kind === 'ITEM' ? 'item' : 'service'} "${title}"${place ? ` at ${place.name}` : ''}`
        const owner = labelOwners.get(label.normalize('NFKC').toLowerCase())
        if (owner && owner !== body.moduleId) throw new Decline('UNRESOLVED_SCOPE')
        labelOwners.set(label.normalize('NFKC').toLowerCase(), body.moduleId)
        labels.set(body.moduleId, label)
      }
      const label = (id: string) => {
        const value = labels.get(id)
        if (!value) throw new Decline('UNRESOLVED_SCOPE')
        return literal(value)
      }
      const renderCanonical = (key: string) => {
        const body = canonical.get(key)
        if (!body) throw new Decline('SOURCE_MISMATCH')
        const payload = body.snapshot.payload
        retain(key)
        if (!canonicalSources.some((row) => row.key === key))
          canonicalSources.push(structuredClone(body))
        if (payload.kind === 'SERVICE')
          return [
            label(body.moduleId),
            ...(payload.description ? [quote(payload.description)] : []),
            ...(payload.availability
              ? [`Availability as stated:\n${quote(payload.availability)}`]
              : []),
          ].join('\n')
        if (payload.kind === 'ITEM')
          return [
            label(body.moduleId),
            `Item type: ${literal(payload.itemType)}`,
            ...(payload.description ? [quote(payload.description)] : []),
          ].join('\n')
        if (payload.kind === 'POLICY')
          return [
            label(body.moduleId),
            payload.appliesTo.length
              ? `Applies to: ${payload.appliesTo.map(label).join('; ')}.`
              : 'Scope is inherited only through its stated exception link.',
            quote(payload.rule),
          ].join('\n')
        if (payload.kind === 'RELATIONSHIP') {
          if (!['EXCEPTION_TO_V1', 'OFFERS_PRODUCT_V1'].includes(payload.relationshipType))
            throw new Decline('UNSUPPORTED_QUERY')
          return [
            `${payload.relationshipType === 'EXCEPTION_TO_V1' ? 'Exception link' : 'Offering link'}: ${label(payload.fromModuleId)} -> ${label(payload.toModuleId)}.`,
            ...(payload.description ? [quote(payload.description)] : []),
          ].join('\n')
        }
        throw new Decline('UNSUPPORTED_QUERY')
      }
      for (const [position, row] of rows.entries()) {
        const place = placeMap.get(row.key)
        const topic = knowledgeMap.get(row.key)
        if (place) {
          if (
            row.name !== place.name ||
            row.tenantId !== source.tenantId ||
            row.venueId !== source.venueId
          )
            throw new Decline('SOURCE_MISMATCH')
          retain(row.key)
          places.push(structuredClone(place))
          add(
            `${position + 1}. ${literal(place.name)}${place.areaName ? ` (${literal(place.areaName)})` : ''}`,
          )
          for (const text of [place.shortDescription, place.longDescription])
            if (text) add(quote(text))
          if (place.hours) add(`Hours as stated:\n${quote(place.hours)}`)
          for (const key of compiled.relatedKeysByPlace[row.key] ?? []) add(renderCanonical(key))
          const products = row.products
          if (products?.state === 'KNOWN' && products.offers.length > 0) {
            const names = new Map<string, string>()
            for (const offer of products.offers) {
              // The count is of validated names, not product identities or exhaustive stock.
              // Every summary proof must be among the exact current sources retained above.
              const bodies = offer.sources.map((proof) => {
                const body = canonical.get(proof.sourceKey)
                if (!body || !retained.has(proof.sourceKey)) throw new Decline('SOURCE_MISMATCH')
                return { proof, body }
              })
              const items = bodies.filter(
                ({ proof, body }) =>
                  proof.fieldPath === 'payload.name' &&
                  body.snapshot.payload.kind === 'ITEM' &&
                  body.snapshot.payload.itemType === 'PRODUCT' &&
                  body.snapshot.payload.name === offer.name,
              )
              const services = bodies.filter(
                ({ proof, body }) =>
                  proof.fieldPath === 'payload.placeId' &&
                  body.snapshot.payload.kind === 'SERVICE' &&
                  body.snapshot.payload.placeId === place.id,
              )
              const supported =
                items.length === 1 &&
                bodies.some(({ proof, body }) => {
                  const payload = body.snapshot.payload
                  return (
                    proof.fieldPath === 'payload.relationshipType' &&
                    payload.kind === 'RELATIONSHIP' &&
                    payload.relationshipType === 'OFFERS_PRODUCT_V1' &&
                    payload.toModuleId === items[0]!.body.moduleId &&
                    services.some(({ body: service }) => service.moduleId === payload.fromModuleId)
                  )
                })
              if (!supported) throw new Decline('SOURCE_MISMATCH')
              names.set(normalizeGuestQueryText(offer.name), literal(offer.name))
            }
            add(
              `${names.size} confirmed distinct listed product ${names.size === 1 ? 'name' : 'names'}: ${[...names.values()].map((name) => `"${name}"`).join('; ')}. This is not an exhaustive product inventory or a live availability check.`,
            )
          } else {
            add('Listed product names/count: unknown; no exhaustive inventory is established.')
          }
        } else if (topic) {
          if (row.name !== topic.title) throw new Decline('SOURCE_MISMATCH')
          retain(row.key)
          knowledge.push(structuredClone(topic))
          add(`${position + 1}. ${literal(topic.title)}\n${quote(topic.content)}`)
        } else throw new Decline('SOURCE_MISMATCH')
      }
      // Metadata emission never creates a selected row, seller or place relationship.
      for (const key of requestedMetadata) if (!retained.has(key)) add(renderCanonical(key))
      for (const [key, topic] of knowledgeMap) {
        if (retained.has(key)) continue
        const scope = topic.contentModuleId ? scopedAliases.get(topic.contentModuleId) : undefined
        const module = scope?.snapshot
        const projection = module ? aliasBody(module) : undefined
        if (scope?.disposition === 'IDENTITY_SCOPED_PRODUCT_METADATA' && module && projection &&
          topic.sourceType === 'UNIVERSAL_CONTENT' && topic.contentModuleId === module.moduleId &&
          topic.contentRevisionId === module.revisionId && topic.contentPublicationId === module.publicationId &&
          topic.title === projection.title && topic.category === module.kind && topic.content === projection.content &&
          same(published.get(module.moduleId), module) &&
          same(identityScopedProductMetadata(compiled.productMetadataProof, compiled.prepared, module.moduleId), module)) {
          // Selected Knowledge was already retained above. Relevant requested item bodies
          // were retained above; unrelated metadata is scoped by identity, not no-sale proof.
          omittedProductMetadata.push({ knowledgeKey: key, moduleId: module.moduleId, revisionId: module.revisionId, publicationId: module.publicationId, reason: retained.has(canonicalKey(module)) ? 'WHOLE_CANONICAL_METADATA_RETAINED' : 'UNRELATED_PRODUCT_METADATA' })
          continue
        }
        if (
          scope?.disposition === 'FULLY_SCOPED' &&
          module &&
          projection &&
          topic.sourceType === 'UNIVERSAL_CONTENT' &&
          topic.contentModuleId === module.moduleId &&
          topic.contentRevisionId === module.revisionId &&
          topic.contentPublicationId === module.publicationId &&
          topic.title === projection.title &&
          topic.category === module.kind &&
          topic.content === projection.content &&
          same(published.get(module.moduleId), module) &&
          scope.placeKeys.length > 0 &&
          (scope.placeKeys.every((placeKey) => !rows.some((row) => row.key === placeKey)) ||
            retained.has(canonicalKey(module)))
        )
          continue
        retain(key)
        knowledge.push(structuredClone(topic))
        add(
          `Other guide information (only applies where its text says): ${literal(topic.title)}\n${quote(topic.content)}`,
        )
      }
      add(
        'Other rules may apply; I cannot confirm this includes every applicable condition. These listings do not establish visitor eligibility or live availability.',
      )
    }
    add(
      'This describes listed entries, not a complete physical inventory or a live availability check.',
    )
    const answer = pieces.join('\n\n')
    return {
      status: 'READY' as const,
      answer,
      result,
      places,
      knowledge,
      canonicalSources,
      retainedKeys: [...retained],
      omittedProductMetadata,
      policyCoverage: 'UNKNOWN' as const,
      receipt: {
        formatterVersion: GUEST_QUERY_DIRECT_ANSWER_VERSION,
        productMetadataOmission: {
          contract: 'identity-scoped-product-metadata-v1' as const,
          count: omittedProductMetadata.length,
          proofSha256: createHash('sha256').update(JSON.stringify({ sourceVersion: source.version, snapshotIdentity: compiled.prepared.snapshotIdentity, queryIdentity: result.queryIdentity, omitted: omittedProductMetadata })).digest('hex'),
        },
        textFormat: 'PLAIN_TEXT' as const,
        sourceVersion: source.version,
        queryIdentity: result.queryIdentity,
        mode: query.mode,
        domain: result.domain,
        candidateCount: result.candidateCount,
        recordCountUnit: recordUnit(result.domain, 1),
        domainContract: result.domainContract,
        knownMatchCount: result.knownMatchCount,
        unknownCandidateCount: result.unknownCandidateCount,
        exactEligibleCount: result.exactEligibleCount,
        coverage: result.coverage,
        inventoryScope: result.inventoryScope,
        returnedCount: result.returnedCount,
        completeKnownSet: query.mode === 'count' || rows.length === result.knownMatchCount,
        retainedSourceCount: retained.size,
        policyCoverage: 'UNKNOWN' as const,
      },
    }
  } catch (error) {
    if (!(error instanceof Decline)) throw error
    return { status: 'UNSUPPORTED' as const, reason: error.reason, ...(result ? { result } : {}) }
  }
}
