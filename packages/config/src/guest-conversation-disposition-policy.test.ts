import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GUEST_CONVERSATION_DISPOSITION_POLICY_CANONICAL as canonical,
  GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256 as sha256,
  GUEST_CONVERSATION_DISPOSITION_POLICY_VERSION as version,
  resolveGuestConversationDispositionPolicy as resolve,
} from './guest-conversation-disposition-policy'

describe('trusted guest disposition policy registry', () => {
  it('binds exact bytes and refuses stale versions or changed policy bytes', () => {
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(sha256)
    expect(resolve(version, sha256)?.decisionKey).toBe('guest-conversations')
    expect(resolve('stale-version', sha256)).toBeNull()
    const changed = canonical.replace('365', '30')
    expect(resolve(version, createHash('sha256').update(changed).digest('hex'))).toBeNull()
  })

  it('isolates resolutions from caller mutation and grants no unrelated policy', () => {
    const first = resolve(version, sha256)!
    ;(first as unknown as { retentionDays: number }).retentionDays = 1
    expect(resolve(version, sha256)?.retentionDays).toBe(365)
    expect(first).not.toHaveProperty('approvedAt')
    expect(first).not.toHaveProperty('approvedBy')
    expect(first).not.toHaveProperty('analyticsRetentionDays')
    expect(resolve(version, sha256)?.hashRetirement.originalHashesInJournal).toBe(false)
  })
})
