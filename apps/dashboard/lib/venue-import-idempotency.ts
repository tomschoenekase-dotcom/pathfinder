import { canonicalVenueContentImportPayload } from '@pathfinder/api/schemas'

type VenueContentImportPayload = Parameters<typeof canonicalVenueContentImportPayload>[0]

type ImportAttempt = {
  fingerprint: string
  idempotencyKey: string
}

type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const unavailableStorage: AttemptStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/

function storageKey(venueId: string): string {
  return `pathfinder:venue-content-import:${venueId}`
}

function resolveStorage(storage?: AttemptStorage): AttemptStorage {
  if (storage) return storage
  try {
    return globalThis.sessionStorage ?? unavailableStorage
  } catch {
    return unavailableStorage
  }
}

export async function venueContentImportFingerprint(
  payload: VenueContentImportPayload,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalVenueContentImportPayload(payload))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function getOrCreateVenueContentImportAttempt(
  payload: VenueContentImportPayload,
  storage?: AttemptStorage,
): Promise<ImportAttempt> {
  const attemptStorage = resolveStorage(storage)
  const fingerprint = await venueContentImportFingerprint(payload)

  try {
    const raw = attemptStorage.getItem(storageKey(payload.venueId))
    if (raw) {
      const candidate = JSON.parse(raw) as Partial<ImportAttempt>
      if (
        candidate.fingerprint === fingerprint &&
        HASH_PATTERN.test(candidate.fingerprint) &&
        typeof candidate.idempotencyKey === 'string' &&
        UUID_PATTERN.test(candidate.idempotencyKey)
      ) {
        return { fingerprint, idempotencyKey: candidate.idempotencyKey }
      }
    }
  } catch {
    // A blocked/corrupt session store falls back to an in-memory attempt in the component.
  }

  const attempt = { fingerprint, idempotencyKey: globalThis.crypto.randomUUID() }
  try {
    attemptStorage.setItem(storageKey(payload.venueId), JSON.stringify(attempt))
  } catch {
    // The caller retains this attempt in memory for retries in the current page lifecycle.
  }
  return attempt
}

export function clearVenueContentImportAttempt(
  venueId: string,
  attempt: ImportAttempt,
  storage?: AttemptStorage,
): void {
  const attemptStorage = resolveStorage(storage)
  try {
    const raw = attemptStorage.getItem(storageKey(venueId))
    if (!raw) return
    const candidate = JSON.parse(raw) as Partial<ImportAttempt>
    if (
      candidate.fingerprint === attempt.fingerprint &&
      candidate.idempotencyKey === attempt.idempotencyKey
    ) {
      attemptStorage.removeItem(storageKey(venueId))
    }
  } catch {
    // Clearing best-effort session state cannot change the committed import result.
  }
}
