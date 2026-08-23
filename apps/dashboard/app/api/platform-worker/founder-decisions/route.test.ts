import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('platform worker founder decisions route', () => {
  it('delegates only POST to the isolated policy handler', () => {
    const source = readFileSync(__filename.replace(/\.test\.ts$/u, '.ts'), 'utf8')
    expect(source).toContain('handlePlatformWorkerFounderDecisionRequest(request)')
    expect(source).not.toContain('handleMcpHttpRequest')
  })
})
