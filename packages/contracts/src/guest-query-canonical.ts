import type { GeneralizedContentPayload } from './universal-content-actions'

/** Governed interpretation of existing published fields; this is not an authoring schema. */
export const GUEST_QUERY_CANONICAL_CONTRACT = 'guest-query-canonical-v1' as const
export const GUEST_QUERY_PRODUCT_ITEM_TYPE = 'PRODUCT' as const
export const GUEST_QUERY_OFFERS_RELATIONSHIP = 'OFFERS_PRODUCT_V1' as const
export const GUEST_QUERY_EXCEPTION_RELATIONSHIP = 'EXCEPTION_TO_V1' as const

export function guestQueryCanonicalRelationship(
  relationship: GeneralizedContentPayload,
  from: GeneralizedContentPayload,
  to: GeneralizedContentPayload,
): 'OFFER' | 'EXCEPTION' | null {
  if (relationship.kind !== 'RELATIONSHIP') return null
  if (
    relationship.relationshipType === GUEST_QUERY_OFFERS_RELATIONSHIP &&
    from.kind === 'SERVICE' &&
    to.kind === 'ITEM' &&
    to.itemType === GUEST_QUERY_PRODUCT_ITEM_TYPE
  )
    return 'OFFER'
  if (
    relationship.relationshipType === GUEST_QUERY_EXCEPTION_RELATIONSHIP &&
    from.kind === 'POLICY' &&
    to.kind === 'POLICY'
  )
    return 'EXCEPTION'
  return null
}

/** PRODUCT description is governed metadata about its own item identity, never a global
 * guest rule or sale/location proof. Arbitrary prose is not syntactically verified;
 * operators must publish global/applicable rules through POLICY. Missing offers stay unknown. */
export const GUEST_QUERY_PRODUCT_METADATA_CONTRACT = 'identity-scoped-product-metadata-v1' as const
