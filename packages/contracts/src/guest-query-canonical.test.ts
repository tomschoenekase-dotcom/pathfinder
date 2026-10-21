import { describe, expect, it } from 'vitest'
import { guestQueryCanonicalRelationship } from './guest-query-canonical'
import type { GeneralizedContentPayload } from './universal-content-actions'

const seller: GeneralizedContentPayload = { kind: 'SERVICE', name: 'Cafe', placeId: 'cafe' }
const product: GeneralizedContentPayload = { kind: 'ITEM', name: 'Tea', itemType: 'PRODUCT' }
const policy: GeneralizedContentPayload = {
  kind: 'POLICY',
  title: 'Rule',
  rule: 'Adults only',
  appliesTo: [],
}
const edge = (type: string): GeneralizedContentPayload => ({
  kind: 'RELATIONSHIP',
  fromModuleId: 'a',
  toModuleId: 'b',
  relationshipType: type,
})
describe('governed canonical query graph', () => {
  it('recognizes only explicit offers and actual endpoint kinds', () => {
    expect(guestQueryCanonicalRelationship(edge('OFFERS_PRODUCT_V1'), seller, product)).toBe(
      'OFFER',
    )
    for (const type of ['offers', 'SELLS', 'OFFERS_PRODUCT_V2', 'offers_product_v1'])
      expect(guestQueryCanonicalRelationship(edge(type), seller, product)).toBeNull()
    expect(guestQueryCanonicalRelationship(edge('OFFERS_PRODUCT_V1'), product, seller)).toBeNull()
    expect(
      guestQueryCanonicalRelationship(edge('OFFERS_PRODUCT_V1'), seller, {
        ...product,
        itemType: 'EXHIBIT',
      }),
    ).toBeNull()
  })
  it('exceptions connect whole policies exclusively', () => {
    expect(guestQueryCanonicalRelationship(edge('EXCEPTION_TO_V1'), policy, policy)).toBe(
      'EXCEPTION',
    )
    expect(guestQueryCanonicalRelationship(edge('EXCEPTION_TO_V1'), seller, policy)).toBeNull()
    expect(guestQueryCanonicalRelationship(policy, policy, policy)).toBeNull()
  })
})
