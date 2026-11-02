import { describe, expect, it } from 'vitest'
import { assembleGuestEvidence, type GuestEvidenceRecord } from './guest-evidence-assembly'
import { guestAnswerShape } from './guest-answer-shape'
import { guestAccessSourceNotices } from './guest-access-facts'
import { guestPriceScopeFacts } from './guest-price-scope'
import { parseGuestRecordSemantics } from './guest-record-semantics'

const record = (ref: string, title: string, content: string): GuestEvidenceRecord => ({
  ref,
  title,
  content,
  version: null,
})
const assemble = (question: string, records: GuestEvidenceRecord[], retrievedRefs: string[]) =>
  assembleGuestEvidence({
    question,
    visitorMessages: [question],
    shape: guestAnswerShape(question),
    records,
    retrievedRefs,
    previous: null,
    unavailableRefs: [],
    escape: (text) => text,
    coverage: { mode: 'FULL', incomplete: false, retrievalPartial: false, loadFailed: false },
    clock: { now: new Date('2026-11-01T15:30:00Z'), timeZone: 'America/Chicago' },
  })

describe('use advice beyond explicitly named subjects', () => {
  it('keeps retrieved access warnings and own facility hours available to a plan', () => {
    const lookout = record(
      'place:lookout',
      'Cedar Lookout',
      'Cedar Lookout is a bird hide. Its only entrance has eight steps and no ramp or lift.\nHours: Sunday 10am-4pm\nGoverned by: Lookout booking',
    )
    const booking = record(
      'knowledge:booking',
      'Lookout booking',
      'Applies to: Cedar Lookout\nCondition: reserve before entry.\nMust mention: Arrive early; missed sessions are not refunded.\nNotice class: money',
    )
    const result = assemble(
      'Plan some birdwatching with a break.',
      [lookout, booking],
      [lookout.ref],
    )
    expect(result.data).toContain('<access_requirements_from_source>')
    expect(result.data).toContain('only entrance has eight steps and no ramp or lift')
    expect(result.data).toContain('Not open yet at the request time')
    expect(result.data).toContain('<required_use_details>')
    expect(result.data).toContain('missed sessions are not refunded')
    expect(result.state.refs.some((ref) => ref.reason === 'subject')).toBe(false)
  })
  it('preserves a full qualified source line without inventing an access conclusion', () => {
    const source =
      'The tour requires stairs unless staff open the bypass; a ramp is available only in dry weather.'
    expect(guestAccessSourceNotices(source)).toEqual([source])
    expect(guestAccessSourceNotices('Stairs are shown in a photograph.')).toEqual([])
  })
  it('keeps rental tax unknown alongside scoped admission tax', () => {
    const rental = record('place:rental', 'Equipment Desk', 'Rental: Shoes $5; harness $4 per day.')
    const tickets = record(
      'knowledge:entry',
      'Entry prices',
      'Price: Adults $20.\nTax: Prices include tax.',
    )
    const result = assemble(
      'What is one adult entry with shoes and harness?',
      [rental, tickets],
      [rental.ref, tickets.ref],
    )
    expect(result.data).toContain('Shoes $5; harness $4 per day. [tax scope: unstated')
    expect(result.data).toContain('Adults $20. [tax scope: included')
    expect(result.rule).toContain('Never transfer admission tax to rental or cafe charges')
  })
  it('retains an explicit cross-record category declaration without making it venue-wide', () => {
    const facts = guestPriceScopeFacts(
      parseGuestRecordSemantics({
        title: 'Ticket charges',
        content: 'Fees: Published performance and workshop prices include all fees and tax.',
      }),
    )
    expect(facts.join(' ')).toContain(
      'Published performance and workshop prices include all fees and tax',
    )
    expect(facts.join(' ')).toContain('covers only the prices or categories this statement names')
  })
  it('preserves an offer condition stated in prose alongside its separate acceptance deadline', () => {
    const offer = record(
      'knowledge:return',
      'Weather return voucher',
      'Weather return voucher provides a return when staff close outdoor areas for weather.\nCondition: Accept before leaving.\nMust mention: Accepting ends the entire visit.\nNotice class: entry-loss',
    )
    const result = assemble('Should we take the Weather return voucher?', [offer], [offer.ref])
    expect(result.data).toContain(
      'Conditional source statement: Weather return voucher provides a return when staff close outdoor areas for weather.',
    )
    expect(result.data).toContain('Condition: Accept before leaving.')
  })
  it('carries every offer consequence into required use details even with a shorter must-mention', () => {
    const offer = record(
      'knowledge:return',
      'Storm return voucher',
      'Storm return voucher is a replacement visit.\nCondition: The supervisor must verify a staff-declared storm closure prevented a booked activity and approve before 3pm.\nConsequence: Acceptance ends remaining entry today; use one open day within 10 days; it is not a cash refund.\nMust mention: Acceptance ends remaining entry today.\nNotice class: entry-loss',
    )
    const result = assemble(
      'Could we accept the Storm return voucher after lunch?',
      [offer],
      [offer.ref],
    )
    const details = result.data.match(
      /<required_use_details>([\s\S]*?)<\/required_use_details>/u,
    )?.[1]
    expect(details).toContain('Condition: The supervisor must verify')
    expect(details).toContain('before 3pm')
    expect(details).toContain(
      'Consequence: Acceptance ends remaining entry today; use one open day within 10 days; it is not a cash refund.',
    )
  })
})
