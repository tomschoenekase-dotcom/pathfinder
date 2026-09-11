import { describe, expect, it } from 'vitest'

import {
  agentQuestionAnswerDraftLimits,
  pruneAgentQuestionAnswerDraftRevisions,
  readAgentQuestionAnswerDraft,
  removeAgentQuestionAnswerDraft,
  saveAgentQuestionAnswerDraft,
  type AgentQuestionAnswerDraftScope,
} from './agent-question-answer-draft'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  writeRaw(value: string) {
    this.values.set('pathfinder.agent-question-answer-drafts.v1', value)
  }

  raw() {
    return this.values.get('pathfinder.agent-question-answer-drafts.v1') ?? null
  }
}

class UnavailableStorage {
  getItem(): string | null {
    throw new Error('storage unavailable')
  }

  setItem(key: string, value: string): void {
    void key
    void value
    throw new Error('storage unavailable')
  }

  removeItem(key: string): void {
    void key
    throw new Error('storage unavailable')
  }
}

const scope: AgentQuestionAnswerDraftScope = {
  actorId: 'founder-a',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  questionId: 'question-a',
  expectedUpdatedAt: '2026-09-08T12:00:00.000Z',
}

const draft = {
  answer: 'Use the greenhouse entrance.',
  selectedChoices: ['North entrance', 'Ramp'],
  multiSelectContext: 'The ramp avoids the loading area.',
}

describe('agent question answer session draft', () => {
  it('restores exactly one actor, tenant, venue, question, and revision scoped draft', () => {
    const storage = new MemoryStorage()
    saveAgentQuestionAnswerDraft({ storage, scope, draft, now: 1_000 })

    expect(readAgentQuestionAnswerDraft({ storage, scope, now: 1_001 })).toEqual(draft)
    expect(
      readAgentQuestionAnswerDraft({
        storage,
        scope: { ...scope, actorId: 'founder-b' },
        now: 1_001,
      }),
    ).toBeNull()
    expect(
      readAgentQuestionAnswerDraft({
        storage,
        scope: { ...scope, tenantId: 'tenant-b' },
        now: 1_001,
      }),
    ).toBeNull()
    expect(
      readAgentQuestionAnswerDraft({
        storage,
        scope: { ...scope, venueId: 'venue-b' },
        now: 1_001,
      }),
    ).toBeNull()
    expect(
      readAgentQuestionAnswerDraft({
        storage,
        scope: { ...scope, questionId: 'question-b' },
        now: 1_001,
      }),
    ).toBeNull()
    expect(
      readAgentQuestionAnswerDraft({
        storage,
        scope: { ...scope, expectedUpdatedAt: '2026-09-08T12:01:00.000Z' },
        now: 1_001,
      }),
    ).toBeNull()
  })

  it('prunes a prior revision when the current question revision is saved', () => {
    const storage = new MemoryStorage()
    const revised = { ...scope, expectedUpdatedAt: '2026-09-08T12:01:00.000Z' }
    saveAgentQuestionAnswerDraft({ storage, scope, draft, now: 1_000 })
    saveAgentQuestionAnswerDraft({ storage, scope: revised, draft, now: 1_001 })

    expect(readAgentQuestionAnswerDraft({ storage, scope, now: 1_003 })).toBeNull()
    expect(readAgentQuestionAnswerDraft({ storage, scope: revised, now: 1_003 })).toEqual(draft)
  })

  it('prunes stale revisions when a current revision mounts before any new input', () => {
    const storage = new MemoryStorage()
    const revised = { ...scope, expectedUpdatedAt: '2026-09-08T12:01:00.000Z' }
    storage.writeRaw(
      JSON.stringify({
        version: 1,
        drafts: [
          { ...draft, scope, savedAt: 1_000 },
          { ...draft, scope: revised, savedAt: 1_001 },
        ],
      }),
    )

    pruneAgentQuestionAnswerDraftRevisions({ storage, scope: revised, now: 1_002 })

    expect(readAgentQuestionAnswerDraft({ storage, scope, now: 1_003 })).toBeNull()
    expect(readAgentQuestionAnswerDraft({ storage, scope: revised, now: 1_003 })).toEqual(draft)
  })

  it('fails open on corrupted or expired storage', () => {
    const storage = new MemoryStorage()
    storage.writeRaw('{corrupted')
    expect(readAgentQuestionAnswerDraft({ storage, scope, now: 1_000 })).toBeNull()

    saveAgentQuestionAnswerDraft({ storage, scope, draft, now: 1_000 })
    expect(
      readAgentQuestionAnswerDraft({
        storage,
        scope,
        now: 1_000 + agentQuestionAnswerDraftLimits.ttlMs + 1,
      }),
    ).toBeNull()
  })

  it('does not persist a draft larger than the bounded session entry size', () => {
    const storage = new MemoryStorage()
    saveAgentQuestionAnswerDraft({
      storage,
      scope,
      draft: { ...draft, answer: '🧭'.repeat(agentQuestionAnswerDraftLimits.maxDraftBytes) },
      now: 1_000,
    })

    expect(readAgentQuestionAnswerDraft({ storage, scope, now: 1_001 })).toBeNull()
  })

  it('rejects oversized raw storage and invalid scopes before parsing or writing', () => {
    const storage = new MemoryStorage()
    storage.writeRaw('x'.repeat(agentQuestionAnswerDraftLimits.maxSerializedBytes + 1))
    expect(readAgentQuestionAnswerDraft({ storage, scope, now: 1_001 })).toBeNull()

    saveAgentQuestionAnswerDraft({
      storage,
      scope: { ...scope, expectedUpdatedAt: 'not-a-revision' },
      draft,
      now: 1_002,
    })
    expect(storage.raw()).toHaveLength(agentQuestionAnswerDraftLimits.maxSerializedBytes + 1)
  })

  it('evicts the oldest valid entries until a newly saved draft fits the aggregate bound', () => {
    const storage = new MemoryStorage()
    const existing = Array.from({ length: 16 }, (_, index) => ({
      ...draft,
      answer: 'x'.repeat(2_700),
      scope: { ...scope, questionId: `question-${index}` },
      savedAt: 1_000 + index,
    }))
    const raw = JSON.stringify({ version: 1, drafts: existing })
    expect(new TextEncoder().encode(raw).length).toBeLessThan(
      agentQuestionAnswerDraftLimits.maxSerializedBytes,
    )
    storage.writeRaw(raw)
    const newestScope = { ...scope, questionId: 'question-new' }
    const newestDraft = { ...draft, answer: 'n'.repeat(2_700) }

    saveAgentQuestionAnswerDraft({ storage, scope: newestScope, draft: newestDraft, now: 2_000 })

    expect(readAgentQuestionAnswerDraft({ storage, scope: newestScope, now: 2_001 })).toEqual(
      newestDraft,
    )
    expect(
      readAgentQuestionAnswerDraft({
        storage,
        scope: { ...scope, questionId: 'question-0' },
        now: 2_001,
      }),
    ).toBeNull()
    const result = JSON.parse(storage.raw() ?? '') as { drafts: unknown[] }
    expect(result.drafts).toHaveLength(16)
    expect(new TextEncoder().encode(storage.raw() ?? '').length).toBeLessThanOrEqual(
      agentQuestionAnswerDraftLimits.maxSerializedBytes,
    )
  })

  it('caps a previously oversized entry list before saving a current draft', () => {
    const storage = new MemoryStorage()
    storage.writeRaw(
      JSON.stringify({
        version: 1,
        drafts: Array.from(
          { length: agentQuestionAnswerDraftLimits.maxEntries + 1 },
          (_, index) => ({
            ...draft,
            scope: { ...scope, questionId: `question-${index}` },
            savedAt: 1_000 + index,
          }),
        ),
      }),
    )
    const current = { ...scope, questionId: 'current-question' }

    saveAgentQuestionAnswerDraft({ storage, scope: current, draft, now: 2_000 })

    const result = JSON.parse(storage.raw() ?? '') as { drafts: unknown[] }
    expect(result.drafts).toHaveLength(agentQuestionAnswerDraftLimits.maxEntries)
    expect(readAgentQuestionAnswerDraft({ storage, scope: current, now: 2_001 })).toEqual(draft)
  })

  it('does not throw when browser session storage is unavailable', () => {
    const storage = new UnavailableStorage()

    expect(() => saveAgentQuestionAnswerDraft({ storage, scope, draft, now: 1_000 })).not.toThrow()
    expect(() => readAgentQuestionAnswerDraft({ storage, scope, now: 1_001 })).not.toThrow()
    expect(() => removeAgentQuestionAnswerDraft({ storage, scope, now: 1_002 })).not.toThrow()
  })
})
