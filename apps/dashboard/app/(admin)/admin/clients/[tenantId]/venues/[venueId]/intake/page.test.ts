import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('Internal Workspace intake review route', () => {
  it('mounts deliberate candidate review instead of presenting raw bootstrap JSON as the workflow', () => {
    expect(source).toContain('OnboardingBootstrapReview')
    expect(source).toContain('listOnboardingBootstrapDetails')
    expect(source).not.toContain('JSON.stringify(detail.structuredBootstrap')
    expect(source).not.toMatch(/\.approve\.|\.applyPackage\.|\.publish\./)
  })
})
