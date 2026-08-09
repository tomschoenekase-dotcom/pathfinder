import { describe, expect, it, vi } from 'vitest'

import {
  assertGlobalAiAvailable,
  GlobalAiAdmissionError,
  readGlobalAiControl,
} from './incident-control'

function client(row: unknown) {
  return {
    platformConfig: {
      findUnique: vi.fn().mockResolvedValue(row),
    },
  }
}

describe('global AI incident control', () => {
  it('keeps the rollout active when the versioned row is absent', async () => {
    const testClient = client(null)
    await expect(readGlobalAiControl(testClient as never)).resolves.toEqual({
      schemaVersion: 1,
      paused: false,
      reason: null,
      configured: false,
      malformed: false,
      updatedAt: null,
      updatedBy: null,
    })
    await expect(assertGlobalAiAvailable(testClient as never)).resolves.toBeUndefined()
  })

  it('reads an exact configured state and denies a pause', async () => {
    const updatedAt = new Date('2026-08-08T20:00:00.000Z')
    const testClient = client({
      value: { schemaVersion: 1, paused: true, reason: 'Provider incident' },
      updatedAt,
      updatedBy: 'admin_1',
    })
    await expect(readGlobalAiControl(testClient as never)).resolves.toMatchObject({
      paused: true,
      reason: 'Provider incident',
      configured: true,
      malformed: false,
      updatedAt,
      updatedBy: 'admin_1',
    })
    await expect(assertGlobalAiAvailable(testClient as never)).rejects.toMatchObject({
      name: 'GlobalAiAdmissionError',
      code: 'global-ai-paused',
    })
  })

  it('fails closed on malformed stored JSON', async () => {
    const testClient = client({
      value: { paused: false },
      updatedAt: new Date('2026-08-08T20:00:00.000Z'),
      updatedBy: 'admin_1',
    })
    const state = await readGlobalAiControl(testClient as never)
    expect(state).toMatchObject({ paused: true, configured: true, malformed: true, reason: null })
    await expect(assertGlobalAiAvailable(testClient as never)).rejects.toBeInstanceOf(
      GlobalAiAdmissionError,
    )
  })

  it('propagates read failures so callers can fail closed', async () => {
    const testClient = {
      platformConfig: { findUnique: vi.fn().mockRejectedValue(new Error('database unavailable')) },
    }
    await expect(assertGlobalAiAvailable(testClient as never)).rejects.toMatchObject({
      name: 'GlobalAiAdmissionError',
      code: 'global-ai-control-unavailable',
    })
  })
})
