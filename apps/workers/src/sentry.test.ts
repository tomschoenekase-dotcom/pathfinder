import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger, setErrorMonitor } from '@pathfinder/config/logger'

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  init: vi.fn(),
  withScope: vi.fn(
    (
      callback: (scope: { setFingerprint: (value: string[]) => void; setTag: () => void }) => void,
    ) => callback({ setFingerprint: vi.fn(), setTag: vi.fn() }),
  ),
}))

vi.mock('@sentry/node', () => sentry)

const ORIGINAL_ENV = { ...process.env }

describe('worker error monitoring bootstrap', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setErrorMonitor()
    delete process.env.SENTRY_DSN
    delete process.env.SENTRY_ENABLED
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    setErrorMonitor()
  })

  it('is inert by default and has no destination', async () => {
    await import('./sentry.js')

    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: undefined,
        enableMetrics: false,
        enabled: false,
        maxBreadcrumbs: 0,
        profilesSampleRate: 0,
        sendDefaultPii: false,
        sendClientReports: false,
        tracesSampleRate: 0,
      }),
    )
    expect(sentry.captureException).not.toHaveBeenCalled()
  })

  it('captures a handled logger failure without forwarding its fields', async () => {
    process.env.SENTRY_DSN = 'https://public@example.test/1'
    process.env.SENTRY_ENABLED = 'true'
    await import('./sentry.js')
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    logger.error({
      action: 'workers.job.failed',
      error: 'provider echoed private content',
      tenantId: 'tenant-secret',
    })

    expect(sentry.captureException).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(sentry.captureException.mock.calls)).not.toMatch(
      /provider|private|tenant-secret/i,
    )
    stdout.mockRestore()
  })

  it('preloads the bootstrap in both runtime entry points', async () => {
    const [packageJson, dockerfile, tsupConfig] = await Promise.all([
      readFile(resolve(process.cwd(), 'package.json'), 'utf8'),
      readFile(resolve(process.cwd(), '../../Dockerfile.workers'), 'utf8'),
      readFile(resolve(process.cwd(), 'tsup.config.ts'), 'utf8'),
    ])

    expect(packageJson).toContain('node --require ./dist/sentry.js dist/bootstrap.js')
    expect(dockerfile).toContain(
      'CMD ["node", "--require", "./apps/workers/dist/sentry.js", "apps/workers/dist/bootstrap.js"]',
    )
    expect(tsupConfig).toContain("'src/bootstrap.ts', 'src/index.ts', 'src/sentry.ts'")
  })
})
