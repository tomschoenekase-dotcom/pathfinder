import { describe, expect, it } from 'vitest'
import { guestAccessFacts } from './guest-access-facts'
import { parseGuestRecordSemantics } from './guest-record-semantics'

const facts = (content: string) =>
  guestAccessFacts(parseGuestRecordSemantics({ title: 'Upper gallery tour', content }), content)

describe('computed access restrictions', () => {
  it.each([
    'Route: Includes stairs; no lift alternative.',
    'Upper Walk is a 40-minute walking tour in Main House.\nPrice: $10 per participant.\nGoverned by: Tour participation\nBooking: Advance reservation required.\nRoute: Includes stairs; no lift alternative.',
    'Access: The route requires stairs. There is no elevator.',
    'Accessibility: Uses stairs, and no elevator alternative.',
  ])('makes the same route conclusion independent of question language: %s', (source) => {
    expect(facts(source).join(' ')).toContain('wheelchairWithoutTransfer: false')
    expect(facts(source).join(' ')).toContain('stepFree: false')
  })
  it.each([
    'Route: Includes stairs; no lift alternative.\nA ramp bypasses the stairs.',
    'Route: Includes stairs; no lift alternative.\nAccess: No stairs are required.',
    'Route: Includes stairs; no lift alternative.\nUnknown: Whether the stairs are optional.',
    'Route: Includes stairs; no lift alternative.\nThis applies only during the annual inspection.',
    'Route: Includes stairs; no lift alternative.\nOnly the balcony portion uses this route.',
    'Route: Includes stairs; no lift alternative.\nDescription: An alternate way is available.',
    'Route: Includes stairs.',
    'Route: No lift alternative.',
    'Route: Optional stairs; no lift alternative.',
    'Route: Balcony includes stairs; no lift alternative.',
    'Route: Includes stairs; no lift alternative except the ramp.',
    'Route: May include stairs; no lift alternative.',
    'Route: Includes no stairs; no lift alternative.',
    'Route: Includes stairs; no lift alternative.\nAccess: A ramp bypasses the stairs.',
    'Route: Includes stairs; no lift alternative.\nException: Staff offer a step-free route.',
    'Route: Includes stairs; no lift alternative.\nCondition: Only during lift maintenance.',
    'Route: Includes stairs; no lift alternative.\nAccess: Wheelchair access is available.',
  ])('does not turn partial, unknown or conflicting evidence into a denial: %s', (source) => {
    expect(facts(source)).toEqual([])
  })
})
