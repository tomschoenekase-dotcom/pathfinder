import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const docsRoot = resolve(process.cwd(), '../../docs')
const contract = readFileSync(resolve(docsRoot, 'distribution/README.md'), 'utf8')
const website = readFileSync(resolve(docsRoot, 'distribution/website-installation.md'), 'utf8')
const app = readFileSync(resolve(docsRoot, 'distribution/app-webview-host-guide.md'), 'utf8')
const environment = readFileSync(resolve(process.cwd(), '../../.env.example'), 'utf8')

describe('distribution operator contract', () => {
  it('documents default-off website and app gates plus the compatibility alias', () => {
    expect(environment).toContain('WEBSITE_DISTRIBUTION_ENABLED=false')
    expect(environment).toContain('APP_DISTRIBUTION_ENABLED=false')
    expect(environment).toContain('EMBED_PREVIEW_ENABLED=false')
    expect(contract).toContain('widget` entitlement')
    expect(contract).toContain('app-webview` entitlement')
    expect(contract).toContain('compatibility alias')
  })

  it('pins route, origin and attribution boundaries', () => {
    expect(contract).toContain('/embed/<slug>/inline')
    expect(contract).toContain('/app/<slug>?header=compact')
    expect(contract).toContain('/embed/<slug>?chrome=hidden')
    expect(contract).toContain('route-declared, bounded, and stored once')
    expect(contract).toContain('Existing public AI usage remains `guest-web`')
    expect(website).toContain('script-src`, `style-src`, `connect-src`, and `frame-src`')
    expect(website).toContain('A readiness response does not grant framing')
  })

  it('states revocation and WebView host requirements without claiming rollout', () => {
    expect(contract).toContain('30-second TTL')
    expect(contract).toContain('before staging')
    expect(app).toContain('targetFrame == nil')
    expect(app).toContain('setSupportMultipleWindows(false)')
    expect(app).toContain('onRenderProcessGone')
    expect(app).toContain('WindowInsetsCompat.Type.ime()')
    expect(app).toContain('textZoom')
    expect(app).toContain('initial top-level load fails')
  })
})
