import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  APP_WEBVIEW_CHROME_VALUE,
  resolveAppHeader,
  resolveEmbedPresentation,
} from './embed-presentation'

describe('embed presentation query boundary', () => {
  it('selects web-view chrome only for the one exact supported parameter', () => {
    expect(resolveEmbedPresentation({ chrome: APP_WEBVIEW_CHROME_VALUE })).toBe('webview')
    expect(resolveEmbedPresentation({ chrome: APP_WEBVIEW_CHROME_VALUE, ask: 'Where?' })).toBe(
      'webview',
    )
    expect(resolveEmbedPresentation({ ask: 'Where?', place: 'public-1' })).toBe('embed')
  })

  it.each([
    {},
    { chrome: 'Hidden' },
    { chrome: 'none' },
    { chrome: ['hidden'] },
    { chrome: ['hidden', 'hidden'] },
    { chrome: 'hidden', source: 'app' },
    { unknown: 'hidden' },
  ])('falls back to the ordinary embed for non-exact input %#', (searchParams) => {
    expect(resolveEmbedPresentation(searchParams)).toBe('embed')
  })

  it('keeps the operator guide aligned with the exact bounded contract', () => {
    const guide = readFileSync(
      resolve(process.cwd(), '../../docs/app-webview-integration.md'),
      'utf8',
    )

    expect(guide).toContain(`/embed/<slug>?chrome=${APP_WEBVIEW_CHROME_VALUE}`)
    expect(guide).toContain('distribution/README.md')
    const distributionGuide = readFileSync(
      resolve(process.cwd(), '../../docs/distribution/README.md'),
      'utf8',
    )
    expect(distributionGuide).toContain('route-declared, bounded')
    expect(distributionGuide).toContain('WEBSITE_DISTRIBUTION_ENABLED')
  })
})

describe('app header query boundary', () => {
  it('selects compact chrome only for the one exact supported parameter', () => {
    expect(resolveAppHeader({ header: 'compact' })).toBe('compact')
    expect(resolveAppHeader({ header: 'compact', ask: 'Where?' })).toBe('compact')
    expect(resolveAppHeader({ header: 'none', ask: 'Where?', place: 'public-1' })).toBe('none')
  })

  it.each([{}, { header: 'full' }, { header: ['compact'] }, { header: 'compact', source: 'app' }])(
    'keeps full chrome for non-exact input %#',
    (searchParams) => expect(resolveAppHeader(searchParams)).toBe('full'),
  )
})
