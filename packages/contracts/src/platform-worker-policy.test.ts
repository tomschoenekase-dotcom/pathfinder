import { describe, expect, it } from 'vitest'

import {
  PlatformWorkerFounderDecisionRequest,
  PlatformWorkerFounderOperatingViewRequest,
  VerifiedPlatformWorkerPolicyCredential,
} from './platform-worker-policy'

describe('platform worker policy contracts', () => {
  it('accepts only exact unique founder decision keys', () => {
    expect(PlatformWorkerFounderDecisionRequest.parse({ keys: ['codex-autonomy'] })).toEqual({
      keys: ['codex-autonomy'],
    })
    expect(() =>
      PlatformWorkerFounderDecisionRequest.parse({ keys: ['codex-autonomy', 'codex-autonomy'] }),
    ).toThrow(/unique/u)
    expect(() => PlatformWorkerFounderDecisionRequest.parse({ keys: ['Codex autonomy'] })).toThrow()
  })

  it('permits no customer or mutation capability', () => {
    expect(
      VerifiedPlatformWorkerPolicyCredential.parse({
        credentialId: 'credential-1',
        workerId: 'edith-primary',
        capabilities: ['founder-decisions:read'],
      }),
    ).toBeTruthy()
    expect(() =>
      VerifiedPlatformWorkerPolicyCredential.parse({
        credentialId: 'credential-1',
        workerId: 'edith-primary',
        capabilities: ['questions:ask'],
      }),
    ).toThrow()
  })

  it('supports a separate read-only operating-view capability and bounded request', () => {
    expect(
      VerifiedPlatformWorkerPolicyCredential.parse({
        credentialId: 'credential-1',
        workerId: 'edith-primary',
        capabilities: ['founder-decisions:read', 'founder-operating-view:read'],
      }).capabilities,
    ).toEqual(['founder-decisions:read', 'founder-operating-view:read'])
    expect(PlatformWorkerFounderOperatingViewRequest.parse({})).toEqual({ limit: 25 })
    expect(() => PlatformWorkerFounderOperatingViewRequest.parse({ limit: 101 })).toThrow()
  })
})
