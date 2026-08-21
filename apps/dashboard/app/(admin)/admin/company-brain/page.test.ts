import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('Company Brain admin page', () => {
  it('uses the real governed admin projection and has a truthful empty state', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(admin)/admin/company-brain/page.tsx'),
      'utf8',
    )
    expect(source).toContain('caller.admin.listCompanyBrain')
    expect(source).toContain('No knowledge matches this view')
    expect(source).toContain('Current decision')
    expect(source).not.toContain('mock')
  })
})
