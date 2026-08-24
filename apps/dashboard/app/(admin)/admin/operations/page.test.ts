import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('founder operations readiness surface', () => {
  it('loads and renders the canonical authenticated readiness projection', () => {
    expect(source).toContain('caller.admin.operationsReadiness()')
    expect(source).toContain('<OperationsReadinessSummary readiness={readiness} />')
  })
})
