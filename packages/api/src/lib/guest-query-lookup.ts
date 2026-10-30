import {
  guestCanonicalEvidenceAuthority,
  identityScopedProductMetadata,
  type compileGuestQueryCanonicalSource,
} from './guest-query-canonical-projection'
import { prepareGuestSubjectEvidence } from './guest-query-subject-evidence'
import type { GuestQuerySource } from './guest-query-source'
import { normalizeGuestQueryText, type GuestStructuredQuery } from './guest-structured-query'

export const GUEST_QUERY_LOOKUP_CONTRACT = 'guest-query-evidence-lookup-v1' as const
const MAX_MATCHES = 50

/** Subject evidence only. No unresolved constraint is executed or counted here. */
export function prepareGuestQueryLookup(input: {
  source: GuestQuerySource
  compiled: ReturnType<typeof compileGuestQueryCanonicalSource>
  anchor: GuestStructuredQuery
  question: string
  unresolved: readonly string[]
}) {
  const { source, compiled } = input
  if (
    !input.unresolved.length ||
    input.unresolved.length > 8 ||
    new Set(input.unresolved).size !== input.unresolved.length ||
    input.unresolved.some(
      (span) =>
        typeof span !== 'string' ||
        !span.trim() ||
        span.length > 256 ||
        !input.question.includes(span),
    )
  )
    throw new Error('Lookup unresolved spans must be exact question text')
  const authority = guestCanonicalEvidenceAuthority(compiled.prepared, source)
  const anchor = compiled.prepared.validateQuery(input.anchor)
  if (
    !anchor.predicates.length ||
    anchor.predicates.length > 8 ||
    anchor.mode !== 'list' ||
    source.directory.incomplete ||
    source.directory.searchVersion !== source.version ||
    anchor.predicates.some(
      (predicate) =>
        predicate.field === 'feature' ||
        (predicate.field === 'product' && !compiled.canonicalAuthority),
    )
  )
    throw new Error('Unsupported lookup anchor authority')
  const result = compiled.prepared.evaluate(anchor).page({ pageSize: MAX_MATCHES })
  if (
    result.hasMore ||
    result.knownMatchCount > MAX_MATCHES ||
    result.rows.length !== result.knownMatchCount
  )
    throw new Error('Lookup anchor bound')
  const extraModuleIds: string[] = []
  for (const module of authority.subjectModules) {
    const payload = module.payload
    if (payload.kind !== 'ITEM' || payload.itemType !== 'PRODUCT' || !anchor.predicates.some(
      predicate => predicate.field === 'product' && normalizeGuestQueryText(predicate.name) === normalizeGuestQueryText(payload.name),
    )) continue
    const proof = identityScopedProductMetadata(compiled.productMetadataProof, compiled.prepared, module.moduleId)
    if (proof && JSON.stringify(proof) === JSON.stringify(module)) extraModuleIds.push(module.moduleId)
  }
  const evidence = prepareGuestSubjectEvidence({ source, compiled, keys: result.matchingKeys,
    extraModuleIds, mode: 'CONDITIONAL', anchor, unresolved: input.unresolved,
    anchorUnknownCandidateCount: result.unknownCandidateCount })
  return { ...evidence, summary: { ...evidence.summary, contract: GUEST_QUERY_LOOKUP_CONTRACT } }
}
