import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('founder operations readiness surface', () => {
  it('loads and renders the canonical authenticated readiness projection', () => {
    expect(source).toContain('caller.admin.operationsReadiness()')
    expect(source).toContain('<OperationsReadinessSummary readiness={readiness} />')
  })

  it('separates work, bot making, and system evidence while linking to the single Needs you home', () => {
    expect(source).toContain("query.view === 'work' || query.view === 'bot-maker'")
    expect(source).toContain('<OperationsAnchorRedirect />')
    expect(source).toContain('href="/admin"')
    expect(source).toContain('<OperationsAttentionConsole actorId={userId} data={data} />')
    expect(source).not.toContain("['/admin/ai', 'AI systems']")
    expect(source).toContain("['/admin/operations?view=bot-maker', 'Bot Maker']")
    expect(source).toContain('<BotMakerWorkspace')
    expect(source).not.toContain('FounderProviderConnections')
  })
})
