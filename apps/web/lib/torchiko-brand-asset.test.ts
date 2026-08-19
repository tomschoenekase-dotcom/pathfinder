import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('Torchiko public brand asset', () => {
  it('ships the asset requested by the shared Torchiko brand component', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/torchiko-logo.svg'), 'utf8')

    expect(source).toContain('<svg')
    expect(source).toContain('viewBox="0 0 1200 1200"')
    expect(source).toContain('id="flame"')
  })

  it('keeps the offline fallback in the public Torchiko brand', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/offline.html'), 'utf8')

    expect(source).toContain('<title>Torchiko Offline</title>')
    expect(source).toContain('<p class="eyebrow">Torchiko</p>')
    expect(source).not.toMatch(/>PathFinder</u)
  })
})
