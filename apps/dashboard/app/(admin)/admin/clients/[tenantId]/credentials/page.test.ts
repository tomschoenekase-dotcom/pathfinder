import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('external credentials admin UI boundary', () => {
  it('keeps external access disabled and never renders hashes', () => {
    expect(source).toContain('Nothing on this page enables or authenticates external access')
    expect(source).not.toContain('secretHash')
    expect(source).toContain('ExternalCredentialLifecycleWorkspace')
  })

  it('shows disabled, expiry, revocation, last-used and immutable evidence state', () => {
    expect(source).toContain("'Marked enabled (external access disabled)' : 'Disabled'")
    expect(source).toContain("return 'Expired'")
    expect(source).toContain("return 'Revoked'")
    expect(source).toContain('Immutable lifecycle evidence')
    expect(source).toContain('Last used')
  })

  it('preserves the bounded cursor when selecting a credential from an older page', () => {
    expect(source).toContain('cursorSuffix')
    expect(source).toContain('${cursorSuffix}')
  })
})
