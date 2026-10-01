import { describe, expect, it } from 'vitest'

import {
  evaluateProspectContactEligibility,
  type ProspectEligibilityContact,
} from './prospect-eligibility'

const clean: ProspectEligibilityContact = {
  normalizedEmail: 'person@example.com',
  doNotContact: false,
  emailReadiness: 'VALID',
  permissionState: 'UNKNOWN',
  suppressedAt: null,
  unsubscribedAt: null,
  complainedAt: null,
  lastHardBounceAt: null,
  archivedAt: null,
}

describe('shared prospect contact eligibility', () => {
  it('lets a verified, unblocked contact be drafted to and sent to', () => {
    expect(evaluateProspectContactEligibility(clean, 'draft')).toMatchObject({ eligible: true })
    expect(evaluateProspectContactEligibility(clean, 'send')).toMatchObject({ eligible: true })
  })

  it('allows drafting before verification but never sending', () => {
    for (const emailReadiness of ['UNKNOWN', 'UNVERIFIED', 'REVIEW_REQUIRED']) {
      const contact = { ...clean, emailReadiness }
      expect(evaluateProspectContactEligibility(contact, 'draft').eligible).toBe(true)
      expect(evaluateProspectContactEligibility(contact, 'send')).toMatchObject({
        eligible: false,
        reasons: ['not_verified'],
      })
    }
  })

  const blockers: Array<[string, Partial<ProspectEligibilityContact>, string]> = [
    ['do not contact', { doNotContact: true }, 'do_not_contact'],
    ['suppressed', { suppressedAt: new Date() }, 'suppressed'],
    ['unsubscribed', { unsubscribedAt: new Date() }, 'unsubscribed'],
    ['complaint', { complainedAt: new Date() }, 'complained'],
    ['hard bounce', { lastHardBounceAt: new Date() }, 'bounced'],
    ['opted out', { permissionState: 'OPTED_OUT' }, 'opted_out'],
    ['prohibited', { permissionState: 'PROHIBITED' }, 'prohibited'],
    ['invalid address', { emailReadiness: 'INVALID' }, 'invalid_address'],
    ['no address', { normalizedEmail: null }, 'no_address'],
    ['archived', { archivedAt: new Date() }, 'archived'],
  ]
  it.each(blockers)('refuses a %s contact for both purposes', (_name, overrides, reason) => {
    for (const purpose of ['draft', 'send'] as const) {
      const result = evaluateProspectContactEligibility({ ...clean, ...overrides }, purpose)
      expect(result.eligible).toBe(false)
      expect(result.reasons).toContain(reason)
    }
  })

  it('also refuses when the account is do-not-contact or the address is blocked on another row', () => {
    expect(
      evaluateProspectContactEligibility(clean, 'send', { organizationStage: 'DO_NOT_CONTACT' }),
    ).toMatchObject({ eligible: false, reasons: ['organization_do_not_contact'] })
    expect(
      evaluateProspectContactEligibility(clean, 'draft', { blockedElsewhere: true }),
    ).toMatchObject({ eligible: false, reasons: ['address_blocked_elsewhere'] })
  })

  it('reports every reason that applies, not just the first', () => {
    const result = evaluateProspectContactEligibility(
      { ...clean, suppressedAt: new Date(), complainedAt: new Date(), emailReadiness: 'INVALID' },
      'send',
    )
    expect(result.reasons).toEqual(['suppressed', 'complained', 'invalid_address'])
  })
})
