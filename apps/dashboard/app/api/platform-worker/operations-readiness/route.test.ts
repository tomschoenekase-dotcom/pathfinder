import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('platform worker operations readiness route', () => {
  it('delegates only POST to the isolated readiness handler', () => {
    const source = readFileSync(__filename.replace(/\.test\.ts$/u, '.ts'), 'utf8')
    expect(source).toContain('handlePlatformWorkerOperationsReadinessRequest(request)')
    expect(source).not.toContain('handleMcpHttpRequest')
  })
})
