import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('root service-worker wiring', () => {
  it('uses the testable registrar and the forward-retirement flag without inline script', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/layout.tsx'), 'utf8')

    expect(source).toContain(
      "import { ServiceWorkerRegistration } from '../components/ServiceWorkerRegistration'",
    )
    expect(source).toContain(
      "<ServiceWorkerRegistration enabled={process.env.NEXT_PUBLIC_PWA_ENABLED !== 'false'} />",
    )
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(source).not.toContain("navigator.serviceWorker.register('/sw.js')")
  })

  it('derives canonical social metadata from the documented public web URL', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/layout.tsx'), 'utf8')

    expect(source).toContain('process.env.NEXT_PUBLIC_WEB_URL')
    expect(source).toContain('metadataBase: publicWebUrl')
    expect(source).toContain('url: publicWebUrl')
    expect(source).not.toContain('NEXT_PUBLIC_APP_URL')
  })
})
