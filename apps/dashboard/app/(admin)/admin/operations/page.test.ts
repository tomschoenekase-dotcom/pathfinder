import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('founder operations readiness surface', () => {
  it('loads and renders the canonical authenticated readiness projection', () => {
    expect(source).toContain('caller.admin.operationsReadiness()')
    expect(source).toContain('<OperationsReadinessSummary readiness={readiness} />')
  })

  it('separates current work, detailed queues, system evidence, and AI systems', () => {
    expect(source).toContain("query.view === 'work' || query.view === 'system'")
    expect(source).toContain(
      '<OperationsAttentionConsole actorId={userId} data={data} summaryOnly />',
    )
    expect(source).toContain("['/admin/ai', 'AI systems']")
    expect(source).not.toContain('FounderProviderConnections')
  })
})
