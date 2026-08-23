import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('platform worker founder operating view route', () => {
  it('delegates only POST to the isolated read-only handler', () => {
    const source = readFileSync(__filename.replace(/\.test\.ts$/u, '.ts'), 'utf8')
    expect(source).toContain('handlePlatformWorkerFounderOperatingViewRequest(request)')
    expect(source).not.toContain('handleMcpHttpRequest')
  })
})
