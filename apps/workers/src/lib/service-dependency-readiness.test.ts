import { describe, expect, it, vi } from 'vitest'

import {
  appendBoundedScannerProbeResponse,
  probeWorkerServiceDependencies,
  recordOperationalReadinessHeartbeat,
} from './service-dependency-readiness'

const configured = {
  STORAGE_BUCKET: 'bucket',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
  STORAGE_ACCESS_KEY_ID: 'test-access-key',
  STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
  INTAKE_CLAMAV_HOST: '127.0.0.1',
  INTAKE_CLAMAV_PORT: 3310,
  INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: true,
}

describe('worker service dependency probes', () => {
  it('bounds malware scanner readiness responses by encoded bytes', () => {
    expect(appendBoundedScannerProbeResponse('', 'PONG\0')).toBe('PONG\0')
    expect(() => appendBoundedScannerProbeResponse('', 'x'.repeat(129))).toThrow(
      'malware scanner probe response exceeded its byte limit',
    )
    expect(() => appendBoundedScannerProbeResponse('', 'é'.repeat(65))).toThrow(
      'malware scanner probe response exceeded its byte limit',
    )
  })

  it('reports both configured dependencies up without retaining connection material', async () => {
    const objectStorage = vi.fn().mockResolvedValue(undefined)
    const malwareScanner = vi.fn().mockResolvedValue(undefined)

    await expect(
      probeWorkerServiceDependencies(configured, { objectStorage, malwareScanner }),
    ).resolves.toEqual({
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'up',
    })
    expect(objectStorage).toHaveBeenCalledOnce()
    expect(malwareScanner).toHaveBeenCalledOnce()
  })

  it('fails closed without calling probes when dependencies are unconfigured', async () => {
    const objectStorage = vi.fn()
    const malwareScanner = vi.fn()

    await expect(
      probeWorkerServiceDependencies(
        { INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: false },
        { objectStorage, malwareScanner },
      ),
    ).resolves.toEqual({
      intakeVerificationRequired: false,
      objectStorage: 'unconfigured',
      malwareScanner: 'unconfigured',
    })
    expect(objectStorage).not.toHaveBeenCalled()
    expect(malwareScanner).not.toHaveBeenCalled()
  })

  it('projects probe failures as bounded down states without error detail', async () => {
    const result = await probeWorkerServiceDependencies(configured, {
      objectStorage: vi.fn().mockRejectedValue(new Error('SECRET_STORAGE_DETAIL')),
      malwareScanner: vi.fn().mockRejectedValue(new Error('PRIVATE_SCANNER_DETAIL')),
    })

    expect(result).toEqual({
      intakeVerificationRequired: true,
      objectStorage: 'down',
      malwareScanner: 'down',
    })
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE/u)
  })

  it('bounds a non-cooperative probe instead of stalling the heartbeat', async () => {
    vi.useFakeTimers()
    try {
      const result = probeWorkerServiceDependencies(configured, {
        objectStorage: () => new Promise<void>(() => undefined),
        malwareScanner: vi.fn().mockResolvedValue(undefined),
      })
      await vi.advanceTimersByTimeAsync(1_501)
      await expect(result).resolves.toMatchObject({
        objectStorage: 'down',
        malwareScanner: 'up',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('records one consistent heartbeat and dependency observation', async () => {
    const now = new Date('2026-08-25T06:30:00.000Z')
    const recordWorker = vi.fn().mockResolvedValue(undefined)
    const recordServices = vi.fn().mockResolvedValue(undefined)
    const probe = vi.fn().mockResolvedValue({
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'down',
    })

    await expect(
      recordOperationalReadinessHeartbeat(
        {
          mode: 'provider-disabled',
          schedulersEnabled: false,
          revision: 'revision-1',
          environment: configured,
          now,
        },
        { probe, recordWorker, recordServices },
      ),
    ).resolves.toEqual({
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'down',
    })
    expect(recordWorker).toHaveBeenCalledWith({
      mode: 'provider-disabled',
      schedulersEnabled: false,
      revision: 'revision-1',
      now,
    })
    expect(recordServices).toHaveBeenCalledWith({
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'down',
      now,
    })
  })
})
