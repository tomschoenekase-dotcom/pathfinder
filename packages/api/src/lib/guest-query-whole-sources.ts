import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import {
  guestCanonicalEvidenceAuthority,
  identityScopedProductMetadata,
  type compileGuestQueryCanonicalSource,
} from './guest-query-canonical-projection'
import { normalizeGuestQueryText, type GuestStructuredQuery } from './guest-structured-query'
import type { GuestQuerySource } from './guest-query-source'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Mirrors the protected SQL projection for only the kinds whose whole scope we compile. */
export function guestCanonicalAliasBody(snapshot: EffectivePublishedUniversalContentSnapshot) {
  const payload = snapshot.payload
  if (payload.kind === 'SERVICE')
    return {
      title: payload.name,
      content: [payload.description, payload.availability]
        .filter((part) => part != null)
        .join('\n'),
    }
  if (payload.kind === 'POLICY') return { title: payload.title, content: payload.rule }
  if (payload.kind === 'ITEM')
    return {
      title: payload.name,
      content: [payload.description, `Item type: ${payload.itemType}`]
        .filter((part) => part != null)
        .join('\n'),
    }
  return undefined
}

/** Prepare once. Omission authority comes only from a private compiler proof bound to whole source. */
export function prepareGuestKnowledgeAdmission(
  source: GuestQuerySource,
  compiled: ReturnType<typeof compileGuestQueryCanonicalSource>,
  query: GuestStructuredQuery,
) {
  const authority = guestCanonicalEvidenceAuthority(compiled.prepared, source)
  const scopes = new Map(authority.knowledgeScopes.map((scope) => [scope.snapshot.moduleId, scope]))
  const published = new Map(
    source.canonicalModules?.modules.map((module) => [module.moduleId, module]) ?? [],
  )
  const validated = compiled.prepared.validateQuery(query)
  if (validated.mode !== 'list') throw new Error('Whole sources require list anchor')
  const selected = new Set(compiled.prepared.evaluate(validated).page({ pageSize: 1 }).matchingKeys)
  const needed = new Set([...selected].flatMap((key) => authority.relatedKeysByPlace[key] ?? []))
  for (const module of published.values())
    if (
      module.payload.kind === 'ITEM' &&
      module.payload.itemType === 'PRODUCT' &&
      validated.predicates.some(
        (predicate) =>
          predicate.field === 'product' &&
          normalizeGuestQueryText(predicate.name) ===
            normalizeGuestQueryText(module.payload.kind === 'ITEM' ? module.payload.name : ''),
      ) &&
      identityScopedProductMetadata(
        compiled.productMetadataProof,
        compiled.prepared,
        module.moduleId,
      )
    )
      needed.add(`canonical:${module.revisionId}`)
  return (
    topic: GuestQuerySource['directory']['knowledge'][number],
  ): 'RETAIN' | 'FULLY_SCOPED' | 'IDENTITY_SCOPED_PRODUCT_METADATA' => {
    const scope = topic.contentModuleId ? scopes.get(topic.contentModuleId) : undefined
    const module = scope?.snapshot
    const projection = module ? guestCanonicalAliasBody(module) : undefined
    if (
      !scope ||
      !module ||
      !projection ||
      topic.sourceType !== 'UNIVERSAL_CONTENT' ||
      topic.contentModuleId !== module.moduleId ||
      topic.contentRevisionId !== module.revisionId ||
      topic.contentPublicationId !== module.publicationId ||
      topic.title !== projection.title ||
      topic.category !== module.kind ||
      topic.content !== projection.content ||
      !same(published.get(module.moduleId), module)
    )
      return 'RETAIN'
    if (
      scope.disposition === 'IDENTITY_SCOPED_PRODUCT_METADATA' &&
      same(
        identityScopedProductMetadata(
          compiled.productMetadataProof,
          compiled.prepared,
          module.moduleId,
        ),
        module,
      )
    )
      return 'IDENTITY_SCOPED_PRODUCT_METADATA'
    if (
      scope.disposition === 'FULLY_SCOPED' &&
      scope.placeKeys.length &&
      (scope.placeKeys.every((key) => !selected.has(key)) ||
        needed.has(`canonical:${module.revisionId}`))
    )
      return 'FULLY_SCOPED'
    return 'RETAIN'
  }
}
