import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'app/(admin)/admin/character-lab/page.tsx'), 'utf8')
const adminLayout = readFileSync(join(process.cwd(), 'app/(admin)/layout.tsx'), 'utf8')

describe('Character Lab route boundary', () => {
  it('is nested under the platform-admin layout and requires a server feature flag', () => {
    expect(adminLayout).toContain("platformRole !== 'PLATFORM_ADMIN'")
    expect(source).toContain("isFeatureEnabled('characterRegistry')")
    expect(source).toContain('notFound()')
  })

  it('loads only the trusted canonical local registry assets', () => {
    expect(source).toContain('assets/characters/tochi/definition.json')
    expect(source).toContain('assets/characters/tochi/v0-development/manifest.json')
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('searchParams.asset')
  })

  it('accepts only the three renderer-owned presentation sizes', () => {
    expect(source).toContain("requestedSize === 'compact'")
    expect(source).toContain("requestedSize === 'standard'")
    expect(source).toContain(": 'stage'")
  })
})
