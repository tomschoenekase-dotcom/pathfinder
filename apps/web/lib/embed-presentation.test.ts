import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { APP_WEBVIEW_CHROME_VALUE, resolveEmbedPresentation } from './embed-presentation'

describe('embed presentation query boundary', () => {
  it('selects web-view chrome only for the one exact supported parameter', () => {
    expect(resolveEmbedPresentation({ chrome: APP_WEBVIEW_CHROME_VALUE })).toBe('webview')
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

    expect(guide).toContain(`/embed/<venueSlug>?chrome=${APP_WEBVIEW_CHROME_VALUE}`)
    expect(guide).toContain('EMBED_PREVIEW_ENABLED=true')
    expect(guide).toContain('does not identify a tenant or venue, grant access')
    expect(guide).toContain('There is no native bridge, native SDK')
  })
})
