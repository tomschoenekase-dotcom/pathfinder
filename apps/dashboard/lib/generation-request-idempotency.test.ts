import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearGenerationRequestAttempt,
  generationRequestFingerprint,
  getOrCreateGenerationRequestAttempt,
  type GenerationRequestFingerprintInput,
} from './generation-request-idempotency'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  }
}

const analysisInput: GenerationRequestFingerprintInput = {
  kind: 'answer-analysis',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  rangeStart: '2026-08-01T00:00:00.000Z',
  rangeEnd: '2026-08-08T00:00:00.000Z',
}

describe('generation request idempotency', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: globalThis.crypto,
    })
  })

  it('retains one opaque request UUID across unchanged ambiguous retries', async () => {
    const storage = memoryStorage()
    const first = await getOrCreateGenerationRequestAttempt(analysisInput, null, storage)
    const retry = await getOrCreateGenerationRequestAttempt(analysisInput, first, storage)
    const reload = await getOrCreateGenerationRequestAttempt(analysisInput, null, storage)

    expect(retry).toEqual(first)
    expect(reload).toEqual(first)
    expect(JSON.stringify([...storage.values.values()])).not.toContain(analysisInput.rangeStart)
  })

  it('rotates the request UUID when effective input changes', async () => {
    const storage = memoryStorage()
    const first = await getOrCreateGenerationRequestAttempt(analysisInput, null, storage)
    const changed = await getOrCreateGenerationRequestAttempt(
      { ...analysisInput, rangeEnd: '2026-08-09T00:00:00.000Z' },
      first,
      storage,
    )

    expect(changed.requestId).not.toBe(first.requestId)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
  })

  it('includes the effective report title without storing it', async () => {
    const storage = memoryStorage()
    const report = { ...analysisInput, kind: 'weekly-report' as const, title: 'Board draft' }
    const first = await getOrCreateGenerationRequestAttempt(report, null, storage)
    const changed = await getOrCreateGenerationRequestAttempt(
      { ...report, title: 'Staff draft' },
      first,
      storage,
    )

    expect(changed.requestId).not.toBe(first.requestId)
    expect(JSON.stringify([...storage.values.values()])).not.toContain('Board draft')
  })

  it('clears only the matching confirmed attempt', async () => {
    const storage = memoryStorage()
    const attempt = await getOrCreateGenerationRequestAttempt(analysisInput, null, storage)
    clearGenerationRequestAttempt(
      analysisInput,
      { ...attempt, requestId: crypto.randomUUID() },
      storage,
    )
    expect(await getOrCreateGenerationRequestAttempt(analysisInput, null, storage)).toEqual(attempt)

    clearGenerationRequestAttempt(analysisInput, attempt, storage)
    const next = await getOrCreateGenerationRequestAttempt(analysisInput, null, storage)
    expect(next.requestId).not.toBe(attempt.requestId)
  })

  it('canonicalizes equivalent timestamps before hashing', async () => {
    await expect(
      generationRequestFingerprint({
        ...analysisInput,
        rangeStart: '2026-08-01T01:00:00.000+01:00',
      }),
    ).resolves.toBe(await generationRequestFingerprint(analysisInput))
  })
})
