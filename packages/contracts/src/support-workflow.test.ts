import { describe, expect, it } from 'vitest'

import {
  SupportMessage,
  canTransitionSupportRequest,
  visibleSupportMessages,
} from './support-workflow'

const clientMessage = SupportMessage.parse({
  id: 'message-client',
  authorKind: 'CLIENT',
  visibility: 'CLIENT_VISIBLE',
  body: 'The accessibility hours need to be corrected.',
  attachments: [],
  createdAt: '2026-08-11T19:30:00.000Z',
})

const internalMessage = SupportMessage.parse({
  id: 'message-internal',
  authorKind: 'OPERATOR',
  visibility: 'INTERNAL_ONLY',
  body: 'Verify this against the signed source before drafting a patch.',
  attachments: [],
  createdAt: '2026-08-11T19:31:00.000Z',
})

describe('support workflow contract', () => {
  it('allows the reviewed patch path but not an approval bypass', () => {
    expect(canTransitionSupportRequest('IN_REVIEW', 'PATCH_DRAFTED')).toBe(true)
    expect(canTransitionSupportRequest('PATCH_DRAFTED', 'VALIDATING')).toBe(true)
    expect(canTransitionSupportRequest('VALIDATING', 'AWAITING_APPROVAL')).toBe(true)
    expect(canTransitionSupportRequest('PATCH_DRAFTED', 'APPLYING')).toBe(false)
  })

  it('keeps terminal requests terminal', () => {
    expect(canTransitionSupportRequest('COMPLETED', 'OPEN')).toBe(false)
    expect(canTransitionSupportRequest('CANCELLED', 'OPEN')).toBe(false)
  })

  it('never exposes internal notes to the client view', () => {
    expect(visibleSupportMessages([clientMessage, internalMessage], 'CLIENT')).toEqual([
      clientMessage,
    ])
    expect(visibleSupportMessages([clientMessage, internalMessage], 'INTERNAL')).toEqual([
      clientMessage,
      internalMessage,
    ])
  })

  it('rejects client-authored internal notes', () => {
    expect(
      SupportMessage.safeParse({
        ...clientMessage,
        visibility: 'INTERNAL_ONLY',
      }).success,
    ).toBe(false)
  })
})
