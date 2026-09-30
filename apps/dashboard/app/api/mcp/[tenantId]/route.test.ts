import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

describe('tenant-scoped MCP route boundary', () => {
  it('is node-only, force-dynamic, default-dark, and delegates tenant scope to the authenticated dispatcher', () => {
    expect(source).toContain("runtime = 'nodejs'")
    expect(source).toContain("dynamic = 'force-dynamic'")
    expect(source).toContain('if (!env.AGENT_BRIDGE_HTTP_ENABLED)')
    expect(source).toContain("'cache-control': 'no-store'")
    expect(source).toContain('handleMcpHttpRequest(request, await context.params)')
    expect(source).toContain('Promise<{ tenantId: string }>')
    expect(source).not.toMatch(/venueId|secretHash|console\.|logger\./u)
  })
})
