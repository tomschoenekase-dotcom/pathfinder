export type GenerationRequestAttempt = {
  fingerprint: string
  requestId: string
}

export type GenerationRequestFingerprintInput = {
  kind: 'answer-analysis' | 'weekly-report'
  tenantId: string
  venueId: string
  rangeStart: string
  rangeEnd: string
  title?: string
  retrySeed?: string
}

type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const unavailableStorage: AttemptStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/

function resolveStorage(storage?: AttemptStorage): AttemptStorage {
  if (storage) return storage
  try {
    return globalThis.sessionStorage ?? unavailableStorage
  } catch {
    return unavailableStorage
  }
}

function storageKey(input: GenerationRequestFingerprintInput): string {
  return `pathfinder:generation-request:${input.kind}:${input.tenantId}:${input.venueId}`
}

export async function generationRequestFingerprint(
  input: GenerationRequestFingerprintInput,
): Promise<string> {
  const canonical = JSON.stringify([
    'pathfinder-generation-request-client-v1',
    input.kind,
    input.tenantId,
    input.venueId,
    new Date(input.rangeStart).toISOString(),
    new Date(input.rangeEnd).toISOString(),
    input.title?.trim() ?? '',
    input.retrySeed ?? '',
  ])
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function getOrCreateGenerationRequestAttempt(
  input: GenerationRequestFingerprintInput,
  previous?: GenerationRequestAttempt | null,
  storage?: AttemptStorage,
): Promise<GenerationRequestAttempt> {
  const fingerprint = await generationRequestFingerprint(input)
  if (previous?.fingerprint === fingerprint && UUID_PATTERN.test(previous.requestId)) {
    return previous
  }

  const attemptStorage = resolveStorage(storage)
  try {
    const raw = attemptStorage.getItem(storageKey(input))
    if (raw) {
      const candidate = JSON.parse(raw) as Partial<GenerationRequestAttempt>
      if (
        candidate.fingerprint === fingerprint &&
        HASH_PATTERN.test(candidate.fingerprint) &&
        typeof candidate.requestId === 'string' &&
        UUID_PATTERN.test(candidate.requestId)
      ) {
        return { fingerprint, requestId: candidate.requestId }
      }
    }
  } catch {
    // The caller's in-memory attempt still protects retries in this page lifecycle.
  }

  const attempt = { fingerprint, requestId: globalThis.crypto.randomUUID() }
  try {
    attemptStorage.setItem(storageKey(input), JSON.stringify(attempt))
  } catch {
    // Session persistence is best effort; the component retains the returned attempt.
  }
  return attempt
}

export function clearGenerationRequestAttempt(
  input: GenerationRequestFingerprintInput,
  attempt: GenerationRequestAttempt,
  storage?: AttemptStorage,
): void {
  const attemptStorage = resolveStorage(storage)
  try {
    const raw = attemptStorage.getItem(storageKey(input))
    if (!raw) return
    const candidate = JSON.parse(raw) as Partial<GenerationRequestAttempt>
    if (
      candidate.fingerprint === attempt.fingerprint &&
      candidate.requestId === attempt.requestId
    ) {
      attemptStorage.removeItem(storageKey(input))
    }
  } catch {
    // Clearing retry state cannot change the committed request.
  }
}
