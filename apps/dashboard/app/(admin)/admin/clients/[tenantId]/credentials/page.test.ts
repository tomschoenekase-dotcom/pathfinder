import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('external credentials admin UI boundary', () => {
  it('describes narrow bridge activation without claiming transport and never renders hashes', () => {
    expect(source).toContain('may be activated for the staged agent bridge')
    expect(source).toContain('not deploy or authenticate a runner transport')
    expect(source).not.toContain('secretHash')
    expect(source).toContain('ExternalCredentialLifecycleWorkspace')
  })

  it('shows active, disabled, expiry, revocation, last-used and immutable evidence state', () => {
    expect(source).toContain("credential.enabled ? 'Active' : 'Disabled'")
    expect(source).toContain("return 'Expired'")
    expect(source).toContain("return 'Revoked'")
    expect(source).toContain('Immutable lifecycle evidence')
    expect(source).toContain('Activated for bridge access')
    expect(source).toContain('Last used')
  })

  it('preserves the bounded cursor when selecting a credential from an older page', () => {
    expect(source).toContain('cursorSuffix')
    expect(source).toContain('${cursorSuffix}')
  })
})
