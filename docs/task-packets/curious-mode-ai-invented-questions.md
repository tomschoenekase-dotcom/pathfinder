# Task Packet: Curious Mode — AI-Invented Engagement Questions

## Product spec (confirmed with stakeholder before this packet was written)

This extends [engagement-questions.md](./engagement-questions.md) (already
shipped — schema, CRUD, `selectEngagementQuestion`, prompt injection,
`engagement_question.asked` analytics all exist today). That packet
explicitly scoped free-form AI-invented questions **out**, making Curious
mode behave as "Balanced but asked slightly more often." This packet builds
that deferred behavior.

**Confirmed behavior for Curious mode:**

> The client is really interested in questions and answers. The client's
> authored questions (bottom of the dashboard page) should be woven in when
> they fit. But if none of them fit naturally at the moment the AI decides to
> engage, the AI should invent one of its own. This does not mean asking a
> question on every message — the existing per-turn "should I even try to
> engage this turn" gate still applies and is not changed by this packet.

Concretely:

- The **frequency gate** (today's `MODE_BASE_CHANCE`: STOIC 0, BALANCED 0.35,
  CURIOUS 0.5 — the roll that decides "does this turn get an engagement
  attempt at all") is unchanged and continues to govern how often anything
  happens, in both modes.
- What changes is only **what the AI is offered once the gate passes** in
  CURIOUS mode:
  - If the tenant has active authored questions, weighted-pick one exactly as
    today (by `intensity`), but now tell the AI it may invent its own
    instead **if** the authored one doesn't fit a natural opening in this
    specific reply.
  - If the tenant has **no** active authored questions, CURIOUS mode still
    invites the AI to invent one from scratch — this is the main value of
    the feature for tenants who haven't written any questions yet.
  - BALANCED mode is unchanged: only ever offers the authored weighted-pick,
    no invention permission, exactly as it works today.
- The AI decides whether to actually use the authored question, invent its
  own, or ask nothing at all this turn — same as today, this is a soft
  instruction, not a hard guarantee. "At most one engagement question per
  conversation" remains a prompt-level instruction, not a structurally
  enforced constraint (matches the existing convention — see
  `engagementQuestionSection` in `venue-context.ts`).

No new UI is required — the Curious mode card already exists on
`/engagement-questions`; only its description copy needs a one-line update to
reflect the new behavior.

Run `pnpm install && pnpm typecheck && pnpm lint && pnpm test` from the repo
root before marking done.

---

## Part 1 — Selection logic: `packages/api/src/lib/engagement-questions.ts`

The current single function conflates two decisions behind one random-call
sequence: "should we attempt engagement this turn" (the gate) and "which
authored question wins the weighted pick." CURIOUS mode needs to know the
gate outcome **even when the weighted pick comes back empty** (no active
questions), so split it into two functions that together preserve the exact
same random-call order and count as today (gate roll first, consumed only if
`baseChance > 0`; weighted-pick roll second, consumed only if the gate passed
and `totalWeight > 0`). This keeps existing chat.ts random-mocking in tests
compatible without changes to call order.

Replace the full file contents:

```ts
export type EngagementQuestionForSelection = {
  id: string
  questionType: 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
  prompt: string
  choiceOptions: string[]
  intensity: number
}

export type TenantEngagementMode = 'STOIC' | 'BALANCED' | 'CURIOUS'

// Per-turn probability of attempting engagement at all this turn, before
// deciding what to offer the AI. Unchanged by this packet.
const MODE_BASE_CHANCE: Record<TenantEngagementMode, number> = {
  STOIC: 0,
  BALANCED: 0.35,
  CURIOUS: 0.5,
}

/**
 * Rolls whether this turn gets an engagement attempt at all. Split out from
 * the weighted authored-question pick so CURIOUS mode can still invite the
 * AI to invent a question even when there are zero (or zero-weight) active
 * authored questions to weight-pick from.
 */
export function rollEngagementGate(
  mode: TenantEngagementMode,
  random: () => number = Math.random,
): boolean {
  const baseChance = MODE_BASE_CHANCE[mode]
  if (baseChance === 0) return false
  return random() < baseChance
}

/**
 * Weighted pick among active authored questions by `intensity`. Does not
 * consider mode — callers only invoke this after `rollEngagementGate` has
 * already passed.
 */
export function selectAuthoredQuestion(
  questions: EngagementQuestionForSelection[],
  random: () => number = Math.random,
): EngagementQuestionForSelection | null {
  if (questions.length === 0) return null

  const totalWeight = questions.reduce((sum, question) => sum + question.intensity, 0)
  if (totalWeight <= 0) return null

  let roll = random() * totalWeight
  for (const question of questions) {
    roll -= question.intensity
    if (roll <= 0) return question
  }

  return questions[questions.length - 1] ?? null
}
```

`selectEngagementQuestion` is removed — both of its call sites (chat.ts, and
the test file) are updated below.

---

## Part 2 — Wire into chat: `packages/api/src/routers/chat.ts`

### 2a — Import (line 12)

```ts
import { rollEngagementGate, selectAuthoredQuestion } from '../lib/engagement-questions'
```

### 2b — Selection (replaces lines 350–354)

```ts
// 5. Build context — history arrives newest-first, reverse to oldest-first for Claude
const engagementMode = tenantEngagement?.engagementMode ?? 'STOIC'
const engagementGatePassed = rollEngagementGate(engagementMode)
const selectedEngagementQuestion = engagementGatePassed
  ? selectAuthoredQuestion(engagementQuestions)
  : null
// Curious mode invites the AI to invent its own question when the gate
// passed, regardless of whether an authored one was also offered — it's a
// fallback the AI uses only if the authored one (or none existing) doesn't
// fit a natural opening this turn.
const allowAiInventedQuestion = engagementGatePassed && engagementMode === 'CURIOUS'
```

### 2c — Prompt params (replaces lines 366–374)

```ts
    ...(selectedEngagementQuestion || allowAiInventedQuestion
      ? {
          engagementQuestion: {
            ...(selectedEngagementQuestion
              ? {
                  questionType: selectedEngagementQuestion.questionType,
                  prompt: selectedEngagementQuestion.prompt,
                  choiceOptions: selectedEngagementQuestion.choiceOptions,
                }
              : {}),
            allowAiInvented: allowAiInventedQuestion,
          },
        }
      : {}),
```

### 2d — Analytics emit (replaces lines 456–470)

Fire on any engagement offer this turn (authored pick, invention invite, or
both), not only when an authored question was picked — CURIOUS-with-no-
authored-questions is a real, expected case now.

```ts
if (selectedEngagementQuestion || allowAiInventedQuestion) {
  try {
    await emitEvent({
      tenantId: venue.tenantId,
      venueId: input.venueId,
      sessionId: input.anonymousToken,
      eventType: 'engagement_question.asked',
      metadata: {
        engagementQuestionId: selectedEngagementQuestion?.id ?? null,
        intensity: selectedEngagementQuestion?.intensity ?? null,
        aiInventionAllowed: allowAiInventedQuestion,
        mode: engagementMode,
      },
    })
  } catch {}
}
```

Note: `tenantEngagement?.engagementMode ?? 'STOIC'` was previously computed
inline at the emit call site — it's now the `engagementMode` local from 2b,
so remove the old inline `tenantEngagement?.engagementMode ?? 'STOIC'`
expression here.

---

## Part 3 — Prompt copy: `packages/api/src/lib/venue-context.ts`

### 3a — Type (line 47–51)

```ts
type EngagementQuestionContext = {
  questionType?: 'OPEN_ENDED' | 'MULTIPLE_CHOICE'
  prompt?: string
  choiceOptions?: string[]
  allowAiInvented: boolean
}
```

### 3b — Section builder (replaces lines 92–99)

Three cases: authored-only (Balanced today, unchanged wording), authored +
invention-allowed (Curious with questions), invention-only (Curious with no
active authored questions).

```ts
const engagementQuestionSection = (() => {
  if (!engagementQuestion) return ''

  const hasAuthored = engagementQuestion.prompt !== undefined

  if (hasAuthored && !engagementQuestion.allowAiInvented) {
    return `\n\nGuest engagement moment: The operator wants you to naturally work the following into the conversation when - and only when - a genuinely natural opening appears (e.g. the conversation is wrapping up, or the guest just finished an experience). Do not force it into an unrelated answer, and do not ask it more than once per conversation. Put it in your own words each time so it never sounds scripted - do not repeat the operator's wording verbatim.\nOperator's intent: ${engagementQuestion.prompt}${
      engagementQuestion.questionType === 'MULTIPLE_CHOICE' &&
      (engagementQuestion.choiceOptions?.length ?? 0) > 0
        ? `\nWeave in these options conversationally, never as a bullet list or menu: ${engagementQuestion.choiceOptions?.join(', ')}.`
        : ''
    }`
  }

  if (hasAuthored && engagementQuestion.allowAiInvented) {
    return `\n\nGuest engagement moment: This operator is especially interested in learning from guests, so look for one genuinely natural opening in this conversation (e.g. it's wrapping up, or the guest just finished an experience) to ask a single low-key question. Prefer weaving in the operator's intent below, in your own words - never read it verbatim. If it doesn't fit naturally in this specific reply, you may instead ask a single question of your own invention that's genuinely curious about this specific guest's visit so far. Never force either into an unrelated answer, and never ask more than one engagement question in the whole conversation.\nOperator's intent: ${engagementQuestion.prompt}${
      engagementQuestion.questionType === 'MULTIPLE_CHOICE' &&
      (engagementQuestion.choiceOptions?.length ?? 0) > 0
        ? `\nWeave in these options conversationally, never as a bullet list or menu: ${engagementQuestion.choiceOptions?.join(', ')}.`
        : ''
    }`
  }

  // No active authored questions at all — invention is the only option.
  return `\n\nGuest engagement moment: This operator is especially interested in learning from guests. Look for one genuinely natural opening in this conversation (e.g. it's wrapping up, or the guest just finished an experience) to ask a single low-key question of your own invention that's genuinely curious about this specific guest's visit so far - grounded in something they actually said or did, not generic small talk. Never force it into an unrelated answer, never present it as a survey, and never ask more than one engagement question in the whole conversation.`
})()
```

`hasAuthored` is derived from `prompt !== undefined` rather than adding a
separate boolean — `selectedEngagementQuestion` is always fully populated
(all three of `questionType`/`prompt`/`choiceOptions` together) or absent, so
checking one field is sufficient and matches how `params.engagementQuestion`
is constructed in chat.ts Part 2c.

No other lines in `venue-context.ts` change — `engagementQuestionSection`
still lands in `dynamicPart` (uncached, correct — it varies per turn).

---

## Part 4 — Dashboard copy: `apps/dashboard/components/EngagementQuestionsManager.tsx`

Update the Curious mode description (around line 41) to reflect the real
behavior:

```ts
  {
    value: 'CURIOUS',
    label: 'Curious',
    description:
      'Like Balanced, but if none of your questions fit the moment, the AI will ask a genuinely curious question of its own.',
  },
```

---

## Tests

### `packages/api/src/lib/engagement-questions.test.ts` (rewrite)

Replace the `selectEngagementQuestion` describe block with two blocks
mirroring the split:

```ts
import { describe, expect, it, vi } from 'vitest'

import {
  rollEngagementGate,
  selectAuthoredQuestion,
  type EngagementQuestionForSelection,
} from './engagement-questions'

const questions: EngagementQuestionForSelection[] = [
  {
    id: 'question_1',
    questionType: 'OPEN_ENDED',
    prompt: 'Ask about wayfinding.',
    choiceOptions: [],
    intensity: 1,
  },
  {
    id: 'question_2',
    questionType: 'MULTIPLE_CHOICE',
    prompt: 'Ask about favorite part.',
    choiceOptions: ['exhibit', 'food court'],
    intensity: 4,
  },
]

describe('rollEngagementGate', () => {
  it('never passes in stoic mode, without consuming a roll', () => {
    const random = vi.fn(() => 0)
    expect(rollEngagementGate('STOIC', random)).toBe(false)
    expect(random).not.toHaveBeenCalled()
  })

  it('passes when the roll is under the mode base chance', () => {
    expect(rollEngagementGate('BALANCED', () => 0)).toBe(true)
    expect(rollEngagementGate('CURIOUS', () => 0.49)).toBe(true)
  })

  it('fails when the roll is at or above the mode base chance', () => {
    expect(rollEngagementGate('BALANCED', () => 0.35)).toBe(false)
    expect(rollEngagementGate('CURIOUS', () => 0.5)).toBe(false)
  })
})

describe('selectAuthoredQuestion', () => {
  it('returns null for an empty question list without consuming a roll', () => {
    const random = vi.fn(() => 0)
    expect(selectAuthoredQuestion([], random)).toBeNull()
    expect(random).not.toHaveBeenCalled()
  })

  it('uses intensity weights', () => {
    expect(selectAuthoredQuestion(questions, vi.fn().mockReturnValueOnce(0.1))).toEqual(
      questions[0],
    )
    expect(selectAuthoredQuestion(questions, vi.fn().mockReturnValueOnce(0.95))).toEqual(
      questions[1],
    )
  })
})
```

### `packages/api/src/routers/chat.test.ts` (extend)

Add alongside the existing engagement-question tests (around line 356):

1. **Curious + no authored questions still offers invention** — mock
   `tenantFindUnique` with `engagementMode: 'CURIOUS'`,
   `engagementQuestionFindMany` resolves `[]`, mock `Math.random` to pass the
   gate (e.g. `mockReturnValueOnce(0)` — only one roll is consumed since
   `selectAuthoredQuestion` returns early on an empty list). Assert the
   concatenated system prompt contains `'Guest engagement moment'` and does
   **not** contain `"Operator's intent"` (no authored question was offered).
   Assert `emitEvent` was called with `eventType: 'engagement_question.asked'`
   and `metadata: expect.objectContaining({ engagementQuestionId: null,
aiInventionAllowed: true })`.

2. **Curious + an authored question offers both** — same setup as the
   existing "emits an engagement_question.asked event when a question is
   selected" test (CURIOUS mode, one active question, `Math.random` mocked
   to pass gate then pick it), but now additionally assert the system prompt
   contains both `"Operator's intent"` and language inviting invention (e.g.
   assert it contains `'your own invention'`), and that the emitted metadata
   has `aiInventionAllowed: true`.

3. **Balanced never offers invention** — mock `engagementMode: 'BALANCED'`
   with one active question and a `Math.random` sequence that passes the
   gate and picks it (mirrors existing CURIOUS test). Assert the system
   prompt contains `"Operator's intent"` but does **not** contain `'your own
invention'`, and emitted metadata has `aiInventionAllowed: false`.

---

## Definition of Done

- [ ] `selectEngagementQuestion` replaced by `rollEngagementGate` +
      `selectAuthoredQuestion` in `packages/api/src/lib/engagement-questions.ts`,
      preserving the exact random-call order/count of the original function
- [ ] `chat.ts` computes `engagementGatePassed`, `selectedEngagementQuestion`,
      and `allowAiInventedQuestion` and passes them into
      `buildVenueSystemPromptParts`
- [ ] Curious mode with active authored questions: prompt instructs the AI to
      prefer weaving in the operator's question but permits inventing its
      own if none fits
- [ ] Curious mode with zero active authored questions: prompt still invites
      the AI to invent a question of its own
- [ ] Balanced mode behavior is byte-for-byte unchanged from today (no
      invention permission ever granted)
- [ ] `engagement_question.asked` fires whenever the gate passed (authored
      pick, invention invite, or both), with `engagementQuestionId: null`
      and `aiInventionAllowed: true` when only invention was offered
- [ ] Dashboard Curious mode card copy updated to describe the fallback
      behavior
- [ ] `pnpm typecheck` passes with no new errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes, including the rewritten
      `engagement-questions.test.ts` and the three new `chat.test.ts` cases
