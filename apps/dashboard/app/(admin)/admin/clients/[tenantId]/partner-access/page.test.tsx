/* @vitest-environment jsdom */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import axe from 'axe-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  partnerReadApiEnabled: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('notFound')
  }),
}))

vi.mock('@pathfinder/config/feature-flags', () => ({
  isFeatureEnabled: mocks.partnerReadApiEnabled,
}))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))

import PartnerAccessPage from './page'

const adminLayout = readFileSync(join(process.cwd(), 'app/(admin)/layout.tsx'), 'utf8')
const pageSource = readFileSync(
  join(process.cwd(), 'app/(admin)/admin/clients/[tenantId]/partner-access/page.tsx'),
  'utf8',
)

describe('partner access page boundary', () => {
  it('renders an honest disconnected inventory and disabled lifecycle controls', async () => {
    mocks.partnerReadApiEnabled.mockReturnValue(true)
    const element = await PartnerAccessPage({
      params: Promise.resolve({ tenantId: 'tenant_demo' }),
    })
    const html = renderToStaticMarkup(element)

    expect(html).toContain('Partner access')
    expect(html).toContain('tenant_demo')
    expect(html).toContain('Key management is not connected')
    expect(html).toContain('Connect the admin read procedure to view keys')
    expect(html).toContain('Not loaded')
    expect(html).toContain('Rotate selected</button>')
    expect(html).toContain('Revoke selected</button>')
    expect(html).toContain('Create key</button>')
    expect(html).toContain('Set by server configuration')
    expect(html).not.toContain('name="environment"')
    expect(html.match(/disabled=""/g)).toHaveLength(3)
    expect(html).not.toMatch(/tk_(?:dev|test|live)_/)

    // The admin shell owns the page-level main landmark around this route.
    document.body.innerHTML = `<main>${html}</main>`
    const fieldset = document.querySelector('fieldset')
    const createButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Create key'),
    )
    expect(fieldset?.disabled).toBe(true)
    expect(createButton?.matches(':disabled')).toBe(true)
    expect(
      (
        await axe.run(document.body, {
          rules: { 'color-contrast': { enabled: false } },
        })
      ).violations,
    ).toEqual([])
  })

  it('hides behind the default-off partner-read API flag', async () => {
    mocks.partnerReadApiEnabled.mockReturnValue(false)
    await expect(
      PartnerAccessPage({ params: Promise.resolve({ tenantId: 'tenant_demo' }) }),
    ).rejects.toThrow('notFound')
    expect(mocks.partnerReadApiEnabled).toHaveBeenCalledWith('partnerReadApi')
    expect(mocks.notFound).toHaveBeenCalledOnce()
  })

  it('inherits the platform-admin server route gate and does not bind another credential domain', () => {
    expect(adminLayout).toContain("platformRole !== 'PLATFORM_ADMIN'")
    expect(adminLayout).toContain("redirect('/')")
    expect(pageSource).toContain("isFeatureEnabled('partnerReadApi')")
    expect(pageSource).not.toContain('ExternalCredential')
    expect(pageSource).not.toContain('createAdminCaller')
    expect(pageSource).not.toContain('fetch(')
    expect(pageSource).not.toContain('partnerApiCredential')
  })
})
