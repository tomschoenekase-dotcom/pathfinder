import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('platform worker founder directive task route', () => {
  it('delegates to the capability-gated HTTP handler', () => {
    const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')
    expect(source).toContain('handlePlatformWorkerFounderDirectiveTasksRequest(request)')
    expect(source).toContain("export const runtime = 'nodejs'")
    expect(source).toContain("export const dynamic = 'force-dynamic'")
  })
})
