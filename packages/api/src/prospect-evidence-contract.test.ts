import { describe, expect, it } from 'vitest'
import { salesLocalAction } from './prospect-sales-contract'
const input = {
  venueId: 'venue',
  expectedSnapshotHash: 'a'.repeat(64),
  expectedSelectionId: null,
  captureId: 'native-capture',
  selection: {
    claimIds: ['identity'],
    routeClaimId: null,
    purpose: 'Consider this bounded task.',
    hypothesis: 'Propose a small discussion, not a verified fact.',
  },
}
describe('ID-only native evidence admission', () => {
  it('accepts an explicit unresolved route without inventing an email', () => {
    expect(salesLocalAction.parse({ action: 'admitEvidence', input })).toEqual({
      action: 'admitEvidence',
      input,
    })
  })
  it.each(['capture', 'fetch', 'crawl', 'send', 'stageCapture', 'verifyWebsite'])(
    'does not expose %s',
    (action) => {
      expect(() => salesLocalAction.parse({ action, input })).toThrow()
    },
  )
  it.each(['sourcePath', 'sourceUrl', 'rawBytes', 'verified', 'reviewer', 'SEND_AUTHORIZED'])(
    'refuses client authority or input channel %s',
    (key) => {
      expect(() =>
        salesLocalAction.parse({ action: 'admitEvidence', input: { ...input, [key]: true } }),
      ).toThrow()
    },
  )
  it('bounds selections and rejects new free-text factual fields', () => {
    for (const selection of [
      { ...input.selection, claimIds: ['same', 'same'] },
      { ...input.selection, claimIds: Array.from({ length: 9 }, (_, i) => String(i)) },
      { ...input.selection, verifiedFact: 'Invented exhibit' },
    ])
      expect(() =>
        salesLocalAction.parse({ action: 'admitEvidence', input: { ...input, selection } }),
      ).toThrow()
  })
})
