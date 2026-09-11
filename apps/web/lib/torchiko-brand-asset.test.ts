import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'
import { TorchikoIcon } from '@pathfinder/ui/brand'
import { StaticCharacterFallback } from '@pathfinder/ui/character'

describe('Torchiko public brand asset', () => {
  it('keeps the historical asset available for recovery without using it in presentation', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/torchiko-logo.svg'), 'utf8')

    expect(source).toContain('<svg')
    expect(source).toContain('viewBox="0 0 1200 1200"')
    expect(source).toContain('id="flame"')
  })

  it('uses the neutral text fallback in shared and character presentation paths', () => {
    const iconMarkup = renderToStaticMarkup(createElement(TorchikoIcon, { className: 'text-xs' }))
    const fallbackMarkup = renderToStaticMarkup(
      createElement(StaticCharacterFallback, {
        manifest: {} as never,
        size: 'compact',
      }),
    )

    expect(iconMarkup).toContain('Torchiko')
    expect(iconMarkup).toContain('aria-hidden="true"')
    expect(iconMarkup).not.toContain('<img')
    expect(fallbackMarkup).toContain('data-character-fallback="brand"')
    expect(fallbackMarkup).toContain('>Torchiko</span>')
    expect(fallbackMarkup).not.toContain('<img')
  })

  it('keeps the offline fallback in the public Torchiko brand', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/offline.html'), 'utf8')

    expect(source).toContain('<title>Torchiko Offline</title>')
    expect(source).toContain('<p class="eyebrow">Torchiko</p>')
    expect(source).not.toMatch(/>PathFinder</u)
  })
})
