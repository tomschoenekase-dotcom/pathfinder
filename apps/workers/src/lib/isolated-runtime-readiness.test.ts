import { describe, expect, it, vi } from 'vitest'

import { startIsolatedRuntimeReadinessHeartbeat } from './isolated-runtime-readiness'

describe('isolated runtime readiness heartbeat', () => {
  it('reports exact dark-provider state and normalized dependencies', async () => {
    const stop = vi.fn(async () => undefined)
    const recordHeartbeat = vi.fn(async () => ({
      intakeVerificationRequired: true,
      objectStorage: 'up' as const,
      malwareScanner: 'unconfigured' as const,
    }))
    const startHeartbeat = vi.fn(async ({ write }: { write: () => Promise<unknown> }) => {
      await write()
      return stop
    })

    const result = await startIsolatedRuntimeReadinessHeartbeat(
      {
        schedulersEnabled: true,
        environment: {
          PATHFINDER_RELEASE_SHA: 'a'.repeat(40),
          STORAGE_BUCKET: 'staging-media',
          STORAGE_REGION: 'us-east-1',
          STORAGE_ACCESS_KEY_ID: 'test-access',
          STORAGE_SECRET_ACCESS_KEY: 'test-secret',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'true',
        },
      },
      { startHeartbeat: startHeartbeat as never, recordHeartbeat },
    )

    expect(result).toBe(stop)
    expect(recordHeartbeat).toHaveBeenCalledWith({
      mode: 'provider-disabled',
      schedulersEnabled: true,
      revision: 'a'.repeat(40),
      environment: {
        STORAGE_BUCKET: 'staging-media',
        STORAGE_REGION: 'us-east-1',
        STORAGE_ENDPOINT: undefined,
        STORAGE_ACCESS_KEY_ID: 'test-access',
        STORAGE_SECRET_ACCESS_KEY: 'test-secret',
        INTAKE_CLAMAV_HOST: undefined,
        INTAKE_CLAMAV_PORT: undefined,
        INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: true,
      },
    })
  })
})
