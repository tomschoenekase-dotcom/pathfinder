const STORAGE_KEY = 'pathfinder.agent-question-answer-drafts.v1'
const VERSION = 1
const MAX_ENTRIES = 20
const MAX_SERIALIZED_BYTES = 48 * 1024
const MAX_DRAFT_BYTES = 12 * 1024
const TTL_MS = 24 * 60 * 60 * 1000

export type AgentQuestionAnswerDraftScope = Readonly<{
  actorId: string
  tenantId: string
  venueId: string
  questionId: string
  expectedUpdatedAt: string
}>

export type AgentQuestionAnswerDraft = Readonly<{
  answer: string
  selectedChoices: readonly string[]
  multiSelectContext: string
}>

type StoredDraft = AgentQuestionAnswerDraft & {
  scope: AgentQuestionAnswerDraftScope
  savedAt: number
}

type StoredEnvelope = { version: number; drafts: StoredDraft[] }

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function sameScope(
  left: AgentQuestionAnswerDraftScope,
  right: AgentQuestionAnswerDraftScope,
): boolean {
  return (
    left.actorId === right.actorId &&
    left.tenantId === right.tenantId &&
    left.venueId === right.venueId &&
    left.questionId === right.questionId &&
    left.expectedUpdatedAt === right.expectedUpdatedAt
  )
}

function sameQuestion(
  left: AgentQuestionAnswerDraftScope,
  right: AgentQuestionAnswerDraftScope,
): boolean {
  return (
    left.actorId === right.actorId &&
    left.tenantId === right.tenantId &&
    left.venueId === right.venueId &&
    left.questionId === right.questionId
  )
}

function isScope(value: unknown): value is AgentQuestionAnswerDraftScope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const fields = [
    candidate.actorId,
    candidate.tenantId,
    candidate.venueId,
    candidate.questionId,
    candidate.expectedUpdatedAt,
  ]
  if (
    !fields.every(
      (field) => typeof field === 'string' && field.trim().length > 0 && field.length <= 191,
    )
  )
    return false
  const expectedUpdatedAt = candidate.expectedUpdatedAt as string
  try {
    return new Date(expectedUpdatedAt).toISOString() === expectedUpdatedAt
  } catch {
    return false
  }
}

function isDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    isScope(candidate.scope) &&
    typeof candidate.savedAt === 'number' &&
    Number.isSafeInteger(candidate.savedAt) &&
    candidate.savedAt > 0 &&
    typeof candidate.answer === 'string' &&
    candidate.answer.length <= 5_000 &&
    Array.isArray(candidate.selectedChoices) &&
    candidate.selectedChoices.length <= 100 &&
    candidate.selectedChoices.every(
      (choice) => typeof choice === 'string' && choice.length <= 500,
    ) &&
    typeof candidate.multiSelectContext === 'string' &&
    candidate.multiSelectContext.length <= 5_000 &&
    byteLength(
      JSON.stringify({
        answer: candidate.answer,
        selectedChoices: candidate.selectedChoices,
        multiSelectContext: candidate.multiSelectContext,
      }),
    ) <= MAX_DRAFT_BYTES
  )
}

function isFresh(draft: StoredDraft, now: number): boolean {
  return draft.savedAt <= now + 5 * 60 * 1000 && now - draft.savedAt <= TTL_MS
}

function parseEnvelope(raw: string | null, now: number): StoredEnvelope {
  if (!raw) return { version: VERSION, drafts: [] }
  if (byteLength(raw) > MAX_SERIALIZED_BYTES) return { version: VERSION, drafts: [] }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { version: VERSION, drafts: [] }
    const candidate = parsed as Record<string, unknown>
    if (candidate.version !== VERSION || !Array.isArray(candidate.drafts))
      return { version: VERSION, drafts: [] }
    return {
      version: VERSION,
      drafts: candidate.drafts
        .filter(isDraft)
        .filter((draft) => isFresh(draft, now))
        .sort((left, right) => right.savedAt - left.savedAt)
        .slice(0, MAX_ENTRIES),
    }
  } catch {
    return { version: VERSION, drafts: [] }
  }
}

function readEnvelope(storage: StorageLike, now: number): StoredEnvelope | null {
  try {
    return parseEnvelope(storage.getItem(STORAGE_KEY), now)
  } catch {
    return null
  }
}

function writeEnvelope(storage: StorageLike, envelope: StoredEnvelope): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    // Browser privacy settings and quota exhaustion must leave the answer form usable.
  }
}

function normalizedDraft(draft: AgentQuestionAnswerDraft): AgentQuestionAnswerDraft | null {
  const value = {
    answer: draft.answer,
    selectedChoices: [...new Set(draft.selectedChoices)],
    multiSelectContext: draft.multiSelectContext,
  }
  if (
    value.answer.length > 5_000 ||
    value.selectedChoices.length > 100 ||
    value.selectedChoices.some((choice) => choice.length > 500) ||
    value.multiSelectContext.length > 5_000 ||
    byteLength(JSON.stringify(value)) > MAX_DRAFT_BYTES
  )
    return null
  return value
}

export function readAgentQuestionAnswerDraft(input: {
  storage: StorageLike
  scope: AgentQuestionAnswerDraftScope
  now?: number
}): AgentQuestionAnswerDraft | null {
  if (!isScope(input.scope)) return null
  const envelope = readEnvelope(input.storage, input.now ?? Date.now())
  const stored = envelope?.drafts.find((draft) => sameScope(draft.scope, input.scope))
  return stored
    ? {
        answer: stored.answer,
        selectedChoices: [...stored.selectedChoices],
        multiSelectContext: stored.multiSelectContext,
      }
    : null
}

export function saveAgentQuestionAnswerDraft(input: {
  storage: StorageLike
  scope: AgentQuestionAnswerDraftScope
  draft: AgentQuestionAnswerDraft
  now?: number
}): void {
  if (!isScope(input.scope)) return
  const normalized = normalizedDraft(input.draft)
  if (
    !normalized ||
    (!normalized.answer && !normalized.selectedChoices.length && !normalized.multiSelectContext)
  ) {
    removeAgentQuestionAnswerDraft(input)
    return
  }
  const now = input.now ?? Date.now()
  const envelope = readEnvelope(input.storage, now)
  if (!envelope) return
  const next: StoredDraft = { ...normalized, scope: input.scope, savedAt: now }
  let drafts = [
    ...envelope.drafts.filter(
      (draft) => !sameScope(draft.scope, input.scope) && !sameQuestion(draft.scope, input.scope),
    ),
    next,
  ]
    .sort((left, right) => right.savedAt - left.savedAt)
    .slice(0, MAX_ENTRIES)
  while (
    drafts.length > 1 &&
    byteLength(JSON.stringify({ version: VERSION, drafts })) > MAX_SERIALIZED_BYTES
  )
    drafts = drafts.slice(0, -1)
  const result = { version: VERSION, drafts }
  if (byteLength(JSON.stringify(result)) > MAX_SERIALIZED_BYTES) return
  writeEnvelope(input.storage, result)
}

export function removeAgentQuestionAnswerDraft(input: {
  storage: StorageLike
  scope: AgentQuestionAnswerDraftScope
  now?: number
}): void {
  if (!isScope(input.scope)) return
  const envelope = readEnvelope(input.storage, input.now ?? Date.now())
  if (!envelope) return
  const drafts = envelope.drafts.filter((draft) => !sameScope(draft.scope, input.scope))
  if (drafts.length === 0) {
    try {
      input.storage.removeItem(STORAGE_KEY)
    } catch {
      // Storage unavailability cannot block form recovery or submission.
    }
    return
  }
  writeEnvelope(input.storage, { version: VERSION, drafts })
}

/** Removes previous revisions for this exact actor, tenant, venue, and question. */
export function pruneAgentQuestionAnswerDraftRevisions(input: {
  storage: StorageLike
  scope: AgentQuestionAnswerDraftScope
  now?: number
}): void {
  if (!isScope(input.scope)) return
  const envelope = readEnvelope(input.storage, input.now ?? Date.now())
  if (!envelope) return
  const drafts = envelope.drafts.filter(
    (draft) => !sameQuestion(draft.scope, input.scope) || sameScope(draft.scope, input.scope),
  )
  if (drafts.length !== envelope.drafts.length)
    writeEnvelope(input.storage, { version: VERSION, drafts })
}

export const agentQuestionAnswerDraftLimits = {
  maxEntries: MAX_ENTRIES,
  maxSerializedBytes: MAX_SERIALIZED_BYTES,
  maxDraftBytes: MAX_DRAFT_BYTES,
  ttlMs: TTL_MS,
} as const
