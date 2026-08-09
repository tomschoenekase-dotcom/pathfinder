import { z } from 'zod'

import { GUEST_CHAT_PROMPT_VERSION } from '../venue-context'

export const EVAL_SCHEMA_VERSION = 'pathfinder-eval-v1' as const

const MAX_ID_LENGTH = 80
const MAX_PHRASE_LENGTH = 300
const MAX_ANSWER_LENGTH = 4_000
const MAX_TURN_LENGTH = 2_000
const MAX_TURNS = 12
const MAX_RULES_PER_KIND = 20
const MAX_FACT_ALTERNATIVES = 10
const MAX_PLACE_UNIVERSE = 100

function normalized(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

const IdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const PhraseSchema = z.string().trim().min(1).max(MAX_PHRASE_LENGTH)

export const EvalCategorySchema = z.enum([
  'known-answer',
  'unknown-answer',
  'operational-closure',
  'tenant-leak-canary',
  'multi-turn-context',
])

const PhraseRuleSchema = z
  .object({
    ruleId: IdSchema,
    phrase: PhraseSchema,
  })
  .strict()

const FactRuleSchema = z
  .object({
    ruleId: IdSchema,
    acceptablePhrases: z.array(PhraseSchema).min(1).max(MAX_FACT_ALTERNATIVES),
  })
  .strict()

export const EvalCaseSchema = z
  .object({
    schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
    caseId: IdSchema,
    category: EvalCategorySchema,
    venue: z
      .object({
        fixtureId: IdSchema,
        guideMode: z.enum(['location_aware', 'non_location']),
        placeNameUniverse: z.array(PhraseSchema).max(MAX_PLACE_UNIVERSE),
        allowedPlaceNames: z.array(PhraseSchema).max(MAX_PLACE_UNIVERSE),
      })
      .strict(),
    turns: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(MAX_TURN_LENGTH),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TURNS),
    rules: z
      .object({
        requiredPhrases: z.array(PhraseRuleSchema).max(MAX_RULES_PER_KIND),
        requiredFacts: z.array(FactRuleSchema).max(MAX_RULES_PER_KIND),
        forbiddenPhrases: z.array(PhraseRuleSchema).max(MAX_RULES_PER_KIND),
        maxWords: z.number().int().positive().max(1_000),
        unknownAnswer: z
          .object({
            required: z.boolean(),
            ruleId: IdSchema,
            acceptablePhrases: z.array(PhraseSchema).max(MAX_FACT_ALTERNATIVES),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const addIssue = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message, path })

    value.turns.forEach((turn, index) => {
      const expectedRole = index % 2 === 0 ? 'user' : 'assistant'
      if (turn.role !== expectedRole) {
        addIssue('Turns must alternate, beginning with user', ['turns', index, 'role'])
      }
    })
    if (value.turns.at(-1)?.role !== 'user') {
      addIssue('The final turn must be from the user', ['turns'])
    }
    if (value.category === 'multi-turn-context' && value.turns.length < 3) {
      addIssue('Multi-turn cases require at least three turns', ['turns'])
    }

    const universe = value.venue.placeNameUniverse.map(normalized)
    const allowed = value.venue.allowedPlaceNames.map(normalized)
    if (new Set(universe).size !== universe.length) {
      addIssue('Place-name universe entries must be unique', ['venue', 'placeNameUniverse'])
    }
    if (new Set(allowed).size !== allowed.length) {
      addIssue('Allowed place names must be unique', ['venue', 'allowedPlaceNames'])
    }
    const universeSet = new Set(universe)
    if (allowed.some((placeName) => !universeSet.has(placeName))) {
      addIssue('Allowed place names must be a subset of the complete universe', [
        'venue',
        'allowedPlaceNames',
      ])
    }

    const ruleIds = [
      ...value.rules.requiredPhrases.map((rule) => rule.ruleId),
      ...value.rules.requiredFacts.map((rule) => rule.ruleId),
      ...value.rules.forbiddenPhrases.map((rule) => rule.ruleId),
      value.rules.unknownAnswer.ruleId,
    ]
    if (new Set(ruleIds).size !== ruleIds.length) {
      addIssue('Rule IDs must be unique within a case', ['rules'])
    }

    const phraseGroups = [
      ...value.rules.requiredPhrases.map((rule) => rule.phrase),
      ...value.rules.requiredFacts.flatMap((rule) => rule.acceptablePhrases),
      ...value.rules.forbiddenPhrases.map((rule) => rule.phrase),
      ...value.rules.unknownAnswer.acceptablePhrases,
    ].map(normalized)
    if (new Set(phraseGroups).size !== phraseGroups.length) {
      addIssue('Rule phrases must be unique within a case', ['rules'])
    }
    const required = new Set(
      [
        ...value.rules.requiredPhrases.map((rule) => rule.phrase),
        ...value.rules.requiredFacts.flatMap((rule) => rule.acceptablePhrases),
      ].map(normalized),
    )
    if (value.rules.forbiddenPhrases.some((rule) => required.has(normalized(rule.phrase)))) {
      addIssue('Required and forbidden phrases must not overlap', ['rules'])
    }

    if (
      value.rules.unknownAnswer.required &&
      value.rules.unknownAnswer.acceptablePhrases.length === 0
    ) {
      addIssue('Unknown-answer behavior requires an acceptable phrase', [
        'rules',
        'unknownAnswer',
        'acceptablePhrases',
      ])
    }
    if (
      !value.rules.unknownAnswer.required &&
      value.rules.unknownAnswer.acceptablePhrases.length > 0
    ) {
      addIssue('Disabled unknown-answer behavior must not carry unused phrases', [
        'rules',
        'unknownAnswer',
        'acceptablePhrases',
      ])
    }

    const hasRequiredMeaning =
      value.rules.requiredPhrases.length > 0 || value.rules.requiredFacts.length > 0
    if (
      ['known-answer', 'operational-closure', 'multi-turn-context'].includes(value.category) &&
      !hasRequiredMeaning
    ) {
      addIssue('This category requires at least one required phrase or fact', ['rules'])
    }
    if (value.category === 'unknown-answer' && !value.rules.unknownAnswer.required) {
      addIssue('Unknown-answer cases must require unknown-answer behavior', [
        'rules',
        'unknownAnswer',
      ])
    }
    if (
      value.category === 'tenant-leak-canary' &&
      (value.rules.forbiddenPhrases.length === 0 || !value.rules.unknownAnswer.required)
    ) {
      addIssue('Tenant-leak canaries require forbidden content and unknown-answer behavior', [
        'rules',
      ])
    }
    if (
      value.category === 'tenant-leak-canary' &&
      universe.every((placeName) => new Set(allowed).has(placeName))
    ) {
      addIssue('Tenant-leak canaries require a declared disallowed place in the universe', [
        'venue',
        'placeNameUniverse',
      ])
    }
  })

export const EvalObservationInputSchema = z
  .object({
    caseId: IdSchema,
    answer: z.string().trim().min(1).max(MAX_ANSWER_LENGTH),
  })
  .strict()

export const EvalObservationSchema = z
  .object({
    schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
    caseId: IdSchema,
    expectedPromptContractVersion: z.literal(GUEST_CHAT_PROMPT_VERSION),
    answer: z.string().trim().min(1).max(MAX_ANSWER_LENGTH),
  })
  .strict()

export function createEvalObservation(rawInput: EvalObservationInput): EvalObservation {
  const input = EvalObservationInputSchema.parse(rawInput)
  return EvalObservationSchema.parse({
    schemaVersion: EVAL_SCHEMA_VERSION,
    caseId: input.caseId,
    expectedPromptContractVersion: GUEST_CHAT_PROMPT_VERSION,
    answer: input.answer,
  })
}

export const EvalCheckSchema = z
  .object({
    checkId: z.string().trim().min(1).max(120),
    passed: z.boolean(),
    detail: z.string().trim().min(1).max(500),
  })
  .strict()

export const EvalResultSchema = z
  .object({
    schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
    caseId: IdSchema,
    caseHash: z.string().regex(/^[0-9a-f]{64}$/),
    observationHash: z.string().regex(/^[0-9a-f]{64}$/),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    checks: z.array(EvalCheckSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const checkIds = value.checks.map((check) => check.checkId)
    if (new Set(checkIds).size !== checkIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Check IDs must be unique' })
    }
    const passedCount = value.checks.filter((check) => check.passed).length
    const expectedPassed = passedCount === value.checks.length
    const expectedScore = passedCount / value.checks.length
    if (value.passed !== expectedPassed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Result pass flag contradicts checks',
      })
    }
    if (value.score !== expectedScore) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Result score contradicts checks' })
    }
  })

export const EvalThresholdsSchema = z
  .object({
    minimumCasePassRate: z.number().min(0).max(1),
    minimumCheckPassRate: z.number().min(0).max(1),
    categoryMinimums: z
      .array(
        z
          .object({
            category: EvalCategorySchema,
            minimumPassRate: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(EvalCategorySchema.options.length)
      .superRefine((entries, context) => {
        const categories = entries.map((entry) => entry.category)
        if (new Set(categories).size !== categories.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Category thresholds must be unique',
          })
        }
      }),
  })
  .strict()

export const EvalAggregateSchema = z
  .object({
    schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
    passed: z.boolean(),
    caseCount: z.number().int().positive(),
    passedCaseCount: z.number().int().nonnegative(),
    casePassRate: z.number().min(0).max(1),
    checkCount: z.number().int().positive(),
    passedCheckCount: z.number().int().nonnegative(),
    checkPassRate: z.number().min(0).max(1),
    categories: z.array(
      z
        .object({
          category: EvalCategorySchema,
          caseCount: z.number().int().positive(),
          passedCaseCount: z.number().int().nonnegative(),
          passRate: z.number().min(0).max(1),
          minimumPassRate: z.number().min(0).max(1),
          passed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()

export type EvalCase = z.infer<typeof EvalCaseSchema>
export type EvalObservationInput = z.infer<typeof EvalObservationInputSchema>
export type EvalObservation = z.infer<typeof EvalObservationSchema>
export type EvalResult = z.infer<typeof EvalResultSchema>
export type EvalThresholds = z.infer<typeof EvalThresholdsSchema>
export type EvalAggregate = z.infer<typeof EvalAggregateSchema>
