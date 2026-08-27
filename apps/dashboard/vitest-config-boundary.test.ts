import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('dashboard test-runner boundary', () => {
  it('keeps Playwright suites out of the Vitest unit runner', () => {
    const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8')

    expect(config).toContain("'tests/browser/**'")
    expect(config).toContain("'tests/visual/**'")
    expect(config).toContain("'tests/visitor-launch/**'")
  })
})
