import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routes: Array<[string, string, string[]]> = [
  [
    '../.well-known/oauth-authorization-server/route.ts',
    'handleAuthorizationServerMetadata()',
    ['GET'],
  ],
  [
    '../.well-known/oauth-protected-resource/route.ts',
    'handleProtectedResourceMetadata()',
    ['GET'],
  ],
  [
    '../.well-known/oauth-protected-resource/api/operator/mcp/route.ts',
    'handleProtectedResourceMetadata()',
    ['GET'],
  ],
  ['./register/route.ts', 'handleClientRegistration(request)', ['POST']],
  ['./token/route.ts', 'handleTokenRequest(request)', ['POST']],
  ['./revoke/route.ts', 'handleRevocationRequest(request)', ['POST']],
  ['../api/operator/mcp/route.ts', 'handleOperatorMcpRequest(request)', ['POST', 'GET']],
]

describe('operator OAuth route boundaries', () => {
  it.each(routes)(
    '%s is node-only, dynamic and a thin delegate to the dark-by-default handler',
    (path, call, methods) => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(source).toContain("runtime = 'nodejs'")
      expect(source).toContain("dynamic = 'force-dynamic'")
      expect(source).toContain(`return ${call}`)
      expect(source).toContain("from '@pathfinder/api/operator'")
      for (const method of methods) expect(source).toContain(`export async function ${method}(`)
      // No token handling, logging or environment reads in the route layer.
      expect(source).not.toMatch(/console\.|logger\.|process\.env|secret|headers\.get/iu)
    },
  )
})
