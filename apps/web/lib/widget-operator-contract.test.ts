import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('widget operator contract', () => {
  const guide = readFileSync(resolve(process.cwd(), '../../docs/widget-preview.md'), 'utf8')
  const environment = readFileSync(resolve(process.cwd(), '../../.env.example'), 'utf8')

  it('documents the exact default-off server-owned controls', () => {
    expect(environment).toContain('EMBED_PREVIEW_ENABLED=false')
    expect(environment).toContain('WIDGET_PREVIEW_ORIGINS_JSON={}')
    expect(guide).toContain('RAILWAY_ENVIRONMENT=staging')
    expect(guide).toContain('EMBED_PREVIEW_ENABLED=true')
    expect(guide).toContain('WIDGET_PREVIEW_ORIGINS_JSON=')
    expect(guide).toContain("The request's `Origin` and `Referer` headers never grant authority")
  })

  it('does not overclaim identity, attribution, or packet completion', () => {
    expect(guide).toContain('default-off staging kernel')
    expect(guide).toContain('not completion of packet gate M4')
    expect(guide).toContain('There is no publishable widget key')
    expect(guide).toContain('`guest-web` attribution')
    expect(guide).toContain('It is not trustworthy `guest-widget` attribution')
    expect(guide).toContain('The only cross-window message is the fixed outbound readiness signal')
    expect(guide).toContain('There is no inbound host command')
  })

  it('documents query isolation and a data-free rollback', () => {
    expect(guide).toContain('every query-bearing embed URL')
    expect(guide).toContain('set `EMBED_PREVIEW_ENABLED=false`')
    expect(guide).toContain('No migration or persistent data rollback is involved')
    expect(guide).toContain('session-free, credential-free, no-referrer')
    expect(guide).toContain('unavailable Torchiko does not leave a broken launcher')
    expect(guide).toContain('`script-src`, `style-src`, `connect-src`, and `frame-src`')
    expect(guide).toContain('closed launcher creates no iframe, visitor session, or location work')
    expect(guide).toContain('ten-second readiness timeout removes the complete widget')
  })
})
