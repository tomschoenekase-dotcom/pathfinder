import { describe, expect, it } from 'vitest'
import { assembleGuestEvidence, type GuestEvidenceRecord } from './guest-evidence-assembly'
import { guestAnswerShape } from './guest-answer-shape'

const record = (title: string, content: string): GuestEvidenceRecord => ({ref: `knowledge:${title}`, title, content, version: null})
const assemble = (records: GuestEvidenceRecord[]) => assembleGuestEvidence({
  question: 'Can my companion join the Cloud Workshop?',
  visitorMessages: ['Can my companion join the Cloud Workshop?'],
  shape: guestAnswerShape('Can my companion join the Cloud Workshop?'), records,
  retrievedRefs: [], previous: null, unavailableRefs: [],
  coverage: {mode: 'FULL', incomplete: false, retrievalPartial: false, loadFailed: false},
  escape: value => value,
})

describe('independent adversarial source fidelity', () => {
  it('does not turn a plural record title into a category-wide scope', () => {
    const turn = assemble([
      record('Cloud Workshop', 'Cloud Workshop is an interactive wings exhibit.\nKind: wings exhibit'),
      record('Wings', 'Wings is a separate timed show.\nKind: show'),
      record('Show badge', 'Kind: policy\nApplies to: Wings\nCondition: A show badge is required.'),
    ])
    expect(turn.data).not.toContain('rule for Cloud Workshop: its Applies to line')
  })
  it('does not promote a See also link into a governing rule', () => {
    const turn = assemble([
      record('Cloud Workshop', 'Kind: workshop\nSee also: Admission Exchange'),
      record('Admission Exchange', 'Kind: admission offer\nMust mention: Exchanging admission ends your visit today.'),
    ])
    expect(turn.data).not.toContain('Cloud Workshop is governed by it')
    expect(turn.notices.map(n => n.text)).not.toContain('Exchanging admission ends your visit today.')
  })
  it('does not invert a need-not age statement into a positive threshold', () => {
    const turn = assemble([record('Cloud Workshop', 'Kind: workshop\nAge: Companions need not be at least 18 years old.')])
    expect(turn.data).not.toContain('companion: at least 18 years')
  })
  it('does not drop the exception when rendering a role threshold', () => {
    const turn = assemble([record('Cloud Workshop', 'Kind: workshop\nAge: Companions must be at least 18 years old unless a staff member supervises.')])
    expect(turn.data).not.toContain('<roles fact="Age">companion: at least 18 years</roles>')
  })
})

import { guestNoticeIsCovered } from './guest-required-notices'

describe('notice subject fidelity', () => {
  it('does not accept another offer notice as coverage for the selected offer', () => {
    expect(guestNoticeIsCovered(
      'Cloud Pass gives unlimited admission. Stone Pass has no refunds.',
      'Cloud Pass has no refunds.', ['Cloud Pass'], 0.5, ['Stone Pass'],
    )).toBe(false)
  })
})
