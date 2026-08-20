import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(
  join(process.cwd(), 'app/(admin)/admin/prospects/outreach/page.tsx'),
  'utf8',
)
const campaignSource = readFileSync(
  join(process.cwd(), 'app/(admin)/admin/prospects/outreach/[campaignId]/page.tsx'),
  'utf8',
)
const adminLayout = readFileSync(join(process.cwd(), 'app/(admin)/layout.tsx'), 'utf8')

describe('prospect outreach route boundary', () => {
  it('requires both the platform-admin boundary and the server-owned pilot flag', () => {
    expect(adminLayout).toContain("platformRole !== 'PLATFORM_ADMIN'")
    for (const source of [indexSource, campaignSource]) {
      expect(source).toContain("isCrmFeatureAvailable('prospectOutreach', 'platform-admin')")
      expect(source).toContain('notFound()')
    }
  })
})
