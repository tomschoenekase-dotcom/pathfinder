import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('platform worker release evidence route', () => {
  it('delegates to the reviewed server-only HTTP boundary', () => {
    const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')
    expect(source).toContain('handlePlatformWorkerReleaseEvidenceRequest(request)')
    expect(source).not.toContain('NEXT_PUBLIC_')
  })
})
