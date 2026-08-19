import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

describe('agent bridge route boundary', () => {
  it('is node-only, force-dynamic, default-dark, and delegates to the bounded authenticated handler', () => {
    expect(source).toContain("runtime = 'nodejs'")
    expect(source).toContain("dynamic = 'force-dynamic'")
    expect(source).toContain('if (!env.AGENT_BRIDGE_HTTP_ENABLED)')
    expect(source).toContain("'cache-control': 'no-store'")
    expect(source).toContain('handleAgentBridgeHttpRequest(request, await context.params)')
    expect(source).not.toMatch(/secretHash|console\.|logger\./u)
  })
})
