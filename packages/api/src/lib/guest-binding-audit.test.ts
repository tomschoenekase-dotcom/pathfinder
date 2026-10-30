import { describe, expect, it } from 'vitest'
import {
  GUEST_BINDING_AUDIT_INSTRUCTION_SHA256,
  guestBindingAuditEnabled,
  guestBindingAuditRecords,
  parseGuestBindingAudit,
  assertGuestBindingVisibleText,
} from './guest-binding-audit'

describe('guest binding audit boundaries', () => {
  it('keeps the pre-provider instruction frozen', () => {
    expect(GUEST_BINDING_AUDIT_INSTRUCTION_SHA256).toBe(
      '11081e596d9558179afe39bdb07c96a5f1a9351ac28169cc812dca5330bb496e',
    )
  })
  it('is explicitly on for primary Luna keys only', () => {
    expect(guestBindingAuditEnabled('guest-chat-luna-reasoning-high-fast', {})).toBe(false)
    expect(
      guestBindingAuditEnabled('guest-chat-luna-reasoning-high-fast', {
        GUEST_CHAT_BINDING_AUDIT: 'on',
      }),
    ).toBe(true)
    expect(
      guestBindingAuditEnabled('guest-chat-sol-fast', { GUEST_CHAT_BINDING_AUDIT: 'on' }),
    ).toBe(false)
    expect(guestBindingAuditEnabled('invented', { GUEST_CHAT_BINDING_AUDIT: 'on' })).toBe(false)
  })
  it('uses only rendered data blocks without the full rulebook', () => {
    const records = guestBindingAuditRecords([
      {
        text: 'RULEBOOK\n<untrusted_venue_data>\nA true record.\n</untrusted_venue_data>\nMore rules',
      },
      { text: '<untrusted_venue_data>\r\nAnother record.\r\n</untrusted_venue_data>' },
    ])
    expect(records).toBe('A true record.\n\nAnother record.')
  })
  it('requires exact record support unless the kind is not_in_records', () => {
    const problem = {
      claim: 'A claim.',
      kind: 'wrong_subject',
      recordQuote: 'actual record',
      fix: 'A correction.',
    }
    expect(
      parseGuestBindingAudit(
        JSON.stringify({ verdict: 'FIX', problems: [problem] }),
        'The actual record is here.',
      ).verdict,
    ).toBe('FIX')
    expect(() =>
      parseGuestBindingAudit(
        JSON.stringify({ verdict: 'FIX', problems: [problem] }),
        'Other text.',
      ),
    ).toThrow()
    expect(
      parseGuestBindingAudit(
        JSON.stringify({
          verdict: 'FIX',
          problems: [{ ...problem, kind: 'not_in_records', recordQuote: '' }],
        }),
        '',
      ).verdict,
    ).toBe('FIX')
  })
  it('rejects audit serialization before visitor emission', () => {
    expect(() => assertGuestBindingVisibleText('Sure! {"verdict":"PASS","problems":[]}')).toThrow()
    expect(() => assertGuestBindingVisibleText('A wrong_subject problem.')).toThrow()
    expect(assertGuestBindingVisibleText('A normal visitor answer.')).toBe(
      'A normal visitor answer.',
    )
  })
})
