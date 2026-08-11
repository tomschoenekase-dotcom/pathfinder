import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('external credentials admin UI boundary', () => {
  it('is explicitly read-only and never renders hash or lifecycle mutations', () => {
    expect(source).toContain('Read-only metadata')
    expect(source).toContain('cannot create, reveal, enable, rotate, revoke, or authenticate')
    expect(source).not.toContain('secretHash')
    expect(source).not.toMatch(/\.mutate\(|<button/i)
  })

  it('shows disabled, expiry, revocation, last-used and immutable evidence state', () => {
    expect(source).toContain("'Enabled' : 'Disabled'")
    expect(source).toContain("return 'Expired'")
    expect(source).toContain("return 'Revoked'")
    expect(source).toContain('Immutable lifecycle evidence')
    expect(source).toContain('Last used')
  })
})
