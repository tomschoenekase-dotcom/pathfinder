import { describe, expect, it } from 'vitest'
import { applyEnrichmentProposals, validateEnrichment } from './enrichment'
import { buildGuestPacket, runVenueQuery } from './guest-packet'
import { phraseKey } from './text'
import { VenueIndex, sha256, type EnrichmentClaim, type VenueSourceRecord } from './venue-index'

const record = (id: string, title: string, body: string): VenueSourceRecord => ({
  id,
  title,
  body,
  source: 'place',
  category: null,
  areaName: null,
  placeType: null,
  itemType: null,
  tags: [],
  hours: null,
})
const ride = record(
  'ride',
  'Moon Ride',
  'Moon Ride requires height 48 inches. Under 10 with a paying adult.',
)
const shop = record(
  'shop',
  'Moon Shop',
  'Moon Shop does not sell peanuts. Seasonal stock may change.',
)
const notice = record('notice', 'General notice', 'Visitors may bring service dogs.')

describe('model enrichment has retrieval authority only', () => {
  it('retains invented digitless and wrong-unit values only as neutral source hints', () => {
    const index = VenueIndex.build('Test', [ride])
    const result = validateEnrichment(index, ride, [
      {
        type: 'fact',
        subject: 'Moon Ride',
        field: 'status',
        value: 'open daily with no restrictions',
        quote: ride.body,
      },
      { type: 'fact', subject: 'Moon Ride', field: 'price', value: '48 dollars', quote: ride.body },
    ])
    index.setEnrichment(result.enrichment)
    expect(result.enrichment.claims).toHaveLength(2)
    expect(index.enrichmentFacts.size).toBe(0)
    expect(index.byValue.size).toBe(0)
    const packet = buildGuestPacket(index, { question: 'Moon Ride', todayLine: 'Today' })
    expect(packet.text).toContain(ride.body)
    expect(packet.text).toContain('MODEL-SELECTED SOURCE')
    expect(packet.text).not.toContain('open daily')
    expect(packet.text).not.toContain('48 dollars')
  })

  it('negative-sale proposals retrieve the complete source without creating a product or seller', () => {
    const index = VenueIndex.build('Test', [shop])
    index.setEnrichment(
      validateEnrichment(index, shop, [
        { type: 'sells', product: 'peanuts', seller: 'Moon Shop', quote: shop.body },
      ]).enrichment,
    )
    expect(index.products.size).toBe(0)
    expect(index.enrichmentSellers.size).toBe(0)
    expect(index.sellersByProduct.size).toBe(0)
    expect(runVenueQuery(index, { sells: 'peanuts' }).total).toBe(0)
    const packet = buildGuestPacket(index, { question: 'peanuts', todayLine: 'Today' })
    expect(packet.text).toContain(shop.body)
    expect(packet.text).toContain('MODEL-SELECTED SOURCE')
    expect(packet.text).not.toContain('SELLER CANDIDATES')
  })

  it('same-batch and cached aliases cannot bootstrap subject or governing support', () => {
    const index = VenueIndex.build('Test', [ride, notice])
    const proposals = [
      { type: 'alias' as const, subject: 'Moon Ride', alias: 'Visitors' },
      { type: 'applies_to' as const, subject: 'Moon Ride', quote: notice.body },
    ]
    const result = validateEnrichment(index, notice, proposals)
    expect(result.enrichment.claims.map((claim) => claim.type)).toEqual(['alias'])
    index.setEnrichment(result.enrichment)
    expect(index.resolveKey(phraseKey('Visitors'))).toEqual([])
    expect(validateEnrichment(index, notice, [proposals[1]!]).rejected[0]?.reason).toBe(
      'subject not in quote',
    )
    expect(index.appliesTo.size).toBe(0)
    applyEnrichmentProposals(index, [
      { recordId: notice.id, bodySha256: sha256(notice.body), claims: proposals },
    ])
    expect(index.appliesTo.size).toBe(0)
  })

  it('old cache and caller-declared authority never bypass source-location or typed boundaries', () => {
    const claims: EnrichmentClaim[] = [{ type: 'alias', targetKey: 'moon ride', alias: 'rocket' }]
    const cache = {
      recordId: ride.id,
      bodySha256: sha256(ride.body),
      claims,
      authority: 'AUTHORITATIVE',
    }
    const index = VenueIndex.build('Test', [ride], [cache])
    index.setEnrichment(cache)
    expect(index.proposalRecordIds('rocket')).toEqual([])
    expect(index.resolveKey('rocket')).toEqual([])
    expect(index.enrichmentAliases.size).toBe(0)
  })

  it('invalidates hints after source metadata or target changes and matches a rebuilt index', () => {
    const source = record(
      'policy',
      'Ride rules',
      'Moon Ride requires a ticket. Exceptions apply on Tuesdays.',
    )
    const index = VenueIndex.build('Test', [ride, source])
    const enrichment = validateEnrichment(index, source, [
      { type: 'alias', subject: 'Moon Ride', alias: 'rocket' },
    ]).enrichment
    index.setEnrichment(enrichment)
    expect(index.proposalRecordIds('rocket')).toEqual(['policy'])
    const changed = { ...ride, title: 'Moon Ride Junior' }
    index.upsert(changed)
    expect(index.proposalRecordIds('rocket')).toEqual([])
    expect(index.canonical()).toBe(
      VenueIndex.build('Test', [changed, source], [enrichment]).canonical(),
    )
    index.withdraw('ride')
    expect(index.proposalRecordIds('rocket')).toEqual([])
    expect(index.canonical()).toBe(VenueIndex.build('Test', [source], [enrichment]).canonical())
    index.upsert({ ...source, title: 'New policy title' })
    expect(index.proposalRecordIds('rocket')).toEqual([])
  })

  it('clones cache data and rejects malformed or oversized proposal arrays', () => {
    const index = VenueIndex.build('Test', [ride])
    const enrichment = validateEnrichment(index, ride, [
      { type: 'alias', subject: 'Moon Ride', alias: 'rocket' },
    ]).enrichment
    index.setEnrichment(enrichment)
    enrichment.claims.length = 0
    expect(index.proposalRecordIds('rocket')).toEqual(['ride'])
    expect(
      validateEnrichment(index, ride, [{ type: 'fact', subject: null }] as never).rejected,
    ).toHaveLength(1)
    expect(() => validateEnrichment(index, ride, Array(101).fill({}))).toThrow(/bound/)
    expect(() => index.setEnrichment({ recordId: 'ride', claims: null } as never)).toThrow(/cache/)
    const forged = { ...index.enrichmentFor('ride')!, targets: {} }
    index.setEnrichment(forged as never)
    expect(index.proposalRecordIds('rocket')).toEqual([])
    index.setEnrichment(
      validateEnrichment(index, ride, [{ type: 'alias', subject: 'Moon Ride', alias: 'rocket' }])
        .enrichment,
    )
    const returned = index.enrichmentFor('ride')!
    returned.claims.length = 0
    expect(index.proposalRecordIds('rocket')).toEqual(['ride'])
  })
})
