import { describe, expect, it } from 'vitest'

import {
  resolveSupportContentReceiptChains,
  SupportContentChainError,
  type SupportContentChainReceipt,
} from './support-content-fulfillment-chain'

function receipt(overrides: Partial<SupportContentChainReceipt> = {}): SupportContentChainReceipt {
  return {
    receiptId: 'receipt_1',
    receiptKind: 'ADOPTION',
    proposalId: 'proposal_1',
    sourceProposalId: 'proposal_1',
    sourceRequestVersion: 4,
    replacementOfProposalId: null,
    moduleId: 'module_1',
    moduleKind: 'POLICY',
    revisionId: 'revision_1',
    revisionVersion: 1,
    classification: null,
    relation: null,
    expectedBaseRevisionId: null,
    expectedBaseVersion: null,
    ...overrides,
  }
}

describe('support content fulfillment chains', () => {
  it('links an adoption root to a later frozen correction', () => {
    const links = resolveSupportContentReceiptChains([
      receipt(),
      receipt({
        receiptId: 'receipt_2',
        receiptKind: 'UNIVERSAL',
        proposalId: 'proposal_2',
        sourceProposalId: 'proposal_2',
        sourceRequestVersion: 5,
        revisionId: 'revision_2',
        revisionVersion: 2,
        classification: 'CORRECTION',
        relation: 'CORRECTS',
        expectedBaseRevisionId: 'revision_1',
        expectedBaseVersion: 1,
      }),
    ])
    expect(links).toEqual(new Map([['receipt_1', 'receipt_2']]))
  })

  it('allows same-version transition only through explicit replacement lineage', () => {
    expect(() =>
      resolveSupportContentReceiptChains([
        receipt(),
        receipt({
          receiptId: 'receipt_2',
          receiptKind: 'UNIVERSAL',
          proposalId: 'replacement_2',
          sourceProposalId: 'proposal_1',
          replacementOfProposalId: 'proposal_1',
          revisionId: 'revision_2',
          revisionVersion: 2,
          classification: 'SUPERSESSION',
          relation: 'SUPERSEDES',
          expectedBaseRevisionId: 'revision_1',
          expectedBaseVersion: 1,
        }),
      ]),
    ).not.toThrow()
  })

  it('allows one external correction root followed by a local later-version successor', () => {
    expect(() =>
      resolveSupportContentReceiptChains([
        receipt({
          receiptId: 'receipt_1',
          receiptKind: 'UNIVERSAL',
          classification: 'CORRECTION',
          relation: 'CORRECTS',
          expectedBaseRevisionId: 'external_revision',
          expectedBaseVersion: 7,
          revisionId: 'revision_8',
          revisionVersion: 8,
        }),
        receipt({
          receiptId: 'receipt_2',
          receiptKind: 'UNIVERSAL',
          proposalId: 'proposal_2',
          sourceProposalId: 'proposal_2',
          sourceRequestVersion: 5,
          classification: 'SUPERSESSION',
          relation: 'SUPERSEDES',
          expectedBaseRevisionId: 'revision_8',
          expectedBaseVersion: 8,
          revisionId: 'revision_9',
          revisionVersion: 9,
        }),
      ]),
    ).not.toThrow()
  })

  it.each([
    ['backward source version', { sourceRequestVersion: 3 }],
    ['wrong base version', { expectedBaseVersion: 2 }],
    ['wrong relation', { relation: 'CORRECTS', classification: 'SUPERSESSION' }],
  ])('fails closed for %s', (_label, overrides) => {
    expect(() =>
      resolveSupportContentReceiptChains([
        receipt(),
        receipt({
          receiptId: 'receipt_2',
          receiptKind: 'UNIVERSAL',
          proposalId: 'proposal_2',
          sourceProposalId: 'proposal_2',
          sourceRequestVersion: 5,
          revisionId: 'revision_2',
          revisionVersion: 2,
          classification: 'CORRECTION',
          relation: 'CORRECTS',
          expectedBaseRevisionId: 'revision_1',
          expectedBaseVersion: 1,
          ...overrides,
        }),
      ]),
    ).toThrow(SupportContentChainError)
  })

  it('rejects forks, detached roots, and module-kind drift', () => {
    const successor = (overrides: Partial<SupportContentChainReceipt> = {}) =>
      receipt({
        receiptId: 'receipt_2',
        receiptKind: 'UNIVERSAL',
        proposalId: 'proposal_2',
        sourceProposalId: 'proposal_2',
        sourceRequestVersion: 5,
        revisionId: 'revision_2',
        revisionVersion: 2,
        classification: 'CORRECTION',
        relation: 'CORRECTS',
        expectedBaseRevisionId: 'revision_1',
        expectedBaseVersion: 1,
        ...overrides,
      })
    expect(() =>
      resolveSupportContentReceiptChains([
        receipt(),
        successor(),
        successor({ receiptId: 'receipt_3', proposalId: 'proposal_3', sourceRequestVersion: 6 }),
      ]),
    ).toThrow(SupportContentChainError)
    expect(() =>
      resolveSupportContentReceiptChains([
        receipt(),
        receipt({ receiptId: 'receipt_3', proposalId: 'proposal_3', revisionId: 'revision_3' }),
      ]),
    ).toThrow(SupportContentChainError)
    expect(() =>
      resolveSupportContentReceiptChains([
        receipt(),
        receipt({ receiptId: 'receipt_3', moduleKind: 'SERVICE', revisionId: 'revision_3' }),
      ]),
    ).toThrow(SupportContentChainError)
  })

  it.each([
    ['adoption base', receipt({ expectedBaseRevisionId: 'revision_0', expectedBaseVersion: 0 })],
    [
      'correction without base',
      receipt({
        receiptKind: 'UNIVERSAL',
        classification: 'CORRECTION',
        relation: 'CORRECTS',
      }),
    ],
    [
      'arbitrary universal relation',
      receipt({ receiptKind: 'UNIVERSAL', classification: 'UNRELATED', relation: 'NEW_FACT' }),
    ],
  ])('rejects malformed singleton %s', (_label, value) => {
    expect(() => resolveSupportContentReceiptChains([value])).toThrow(SupportContentChainError)
  })

  it('rejects duplicate receipt IDs across receipt kinds', () => {
    expect(() =>
      resolveSupportContentReceiptChains([
        receipt(),
        receipt({
          receiptKind: 'UNIVERSAL',
          classification: 'ADDITION',
          relation: 'NEW_FACT',
          revisionId: 'revision_2',
        }),
      ]),
    ).toThrow('duplicate receipt identity')
  })
})
