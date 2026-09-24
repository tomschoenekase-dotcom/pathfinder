import { describe, expect, it } from 'vitest'
import { isLocalProspectResearchRequest } from './local-prospect-research-boundary'

const env = {
  NODE_ENV: 'development',
  TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED: '1',
  TORCHIKO_VISUAL_FIXTURES_ENABLED: '1',
}
describe('local CRM read-only HTTP boundary', () => {
  it('requires an explicit development opt-in and exact loopback host/port', () => {
    expect(isLocalProspectResearchRequest(new Headers({ host: '127.0.0.1:58618' }), env)).toBe(true)
    for (const host of [
      'example.com',
      'localhost:3001',
      '127.0.0.1:58619',
      '127.0.0.1.example.com:58618',
    ]) {
      expect(isLocalProspectResearchRequest(new Headers({ host }), env)).toBe(false)
    }
    expect(
      isLocalProspectResearchRequest(new Headers({ host: '127.0.0.1:58618' }), {
        ...env,
        NODE_ENV: 'production',
      }),
    ).toBe(false)
    expect(
      isLocalProspectResearchRequest(new Headers({ host: '127.0.0.1:58618' }), {
        ...env,
        TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED: '',
      }),
    ).toBe(false)
  })
  it('refuses cross-origin, cross-site and forwarded remote-host reads', () => {
    for (const extra of [
      { origin: 'https://remote.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'x-forwarded-host': 'remote.example' },
    ]) {
      expect(
        isLocalProspectResearchRequest(
          new Headers({ host: '127.0.0.1:58618', ...extra } as Record<string, string>),
          env,
        ),
      ).toBe(false)
    }
  })
})
