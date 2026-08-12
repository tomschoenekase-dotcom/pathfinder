import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('universal content route states', () => {
  it('keeps scoped load failure bounded and mutation-free', () => {
    expect(source).toContain('Normalized content is unavailable')
    expect(source).toContain('No data was changed.')
    expect(source).toContain('role="alert"')
    expect(source).not.toMatch(/error\.message|String\(error\)/u)
  })

  it('renders an honest empty state and stable bounded pagination', () => {
    expect(source).toContain('No normalized modules found')
    expect(source).toContain('compatibility Place and Knowledge records may still')
    expect(source).toContain('limit: 50')
    expect(source).toContain('cursorAt: result.nextCursor.createdAt')
    expect(source).toContain('cursorId: result.nextCursor.id')
  })

  it('renders server-derived ITEM guest/native support instead of inferring it in the browser', () => {
    expect(source).toContain('result.itemDisposition.guestPublication')
    expect(source).toContain('result.itemDisposition.nativeCoreV1Materialization')
    expect(source).toContain("const kinds = ['ITEM'")
    expect(source).toContain('Generalized ITEM itemType is separate from legacy compatibility')
    expect(source).toContain('requires an exact PUBLIC revision')
    expect(source).toContain('while the generalized-content capability is enabled')
    expect(source).toContain('must be withdrawn before creating a NATIVE_CORE_V1 release')
  })
})
