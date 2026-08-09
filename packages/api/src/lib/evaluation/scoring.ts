import {
  EVAL_SCHEMA_VERSION,
  createEvalObservation,
  EvalAggregateSchema,
  EvalCaseSchema,
  EvalObservationInputSchema,
  EvalObservationSchema,
  EvalResultSchema,
  EvalThresholdsSchema,
  type EvalAggregate,
  type EvalCase,
  type EvalObservationInput,
  type EvalObservation,
  type EvalResult,
  type EvalThresholds,
} from './contracts'
import { hashEvalCase, hashEvalObservation } from './hash'

function normalized(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

function includesPhrase(answer: string, phrase: string): boolean {
  return normalized(answer).includes(normalized(phrase))
}

function wordCount(value: string): number {
  const trimmed = value.normalize('NFC').trim()
  return trimmed ? trimmed.split(/\s+/u).length : 0
}

function expectedCheckIds(evalCase: EvalCase): string[] {
  return [
    ...evalCase.rules.requiredPhrases.map((rule) => `required:${rule.ruleId}`),
    ...evalCase.rules.requiredFacts.map((rule) => `fact:${rule.ruleId}`),
    ...evalCase.rules.forbiddenPhrases.map((rule) => `forbidden:${rule.ruleId}`),
    'max-words',
    ...(evalCase.rules.unknownAnswer.required
      ? [`unknown:${evalCase.rules.unknownAnswer.ruleId}`]
      : []),
    'place-allowlist',
  ]
}

function scoreEvalCase(rawCase: EvalCase, rawObservation: EvalObservation): EvalResult {
  const evalCase = EvalCaseSchema.parse(rawCase)
  const observation = EvalObservationSchema.parse(rawObservation)
  if (observation.caseId !== evalCase.caseId) {
    throw new Error(`Observation case ${observation.caseId} does not match ${evalCase.caseId}`)
  }

  const checks: EvalResult['checks'] = []
  for (const rule of evalCase.rules.requiredPhrases) {
    const passed = includesPhrase(observation.answer, rule.phrase)
    checks.push({
      checkId: `required:${rule.ruleId}`,
      passed,
      detail: passed ? 'Required phrase present' : 'Required phrase missing',
    })
  }
  for (const rule of evalCase.rules.requiredFacts) {
    const passed = rule.acceptablePhrases.some((phrase) =>
      includesPhrase(observation.answer, phrase),
    )
    checks.push({
      checkId: `fact:${rule.ruleId}`,
      passed,
      detail: passed
        ? 'Required lexical fact marker present'
        : 'Required lexical fact marker missing',
    })
  }
  for (const rule of evalCase.rules.forbiddenPhrases) {
    const passed = !includesPhrase(observation.answer, rule.phrase)
    checks.push({
      checkId: `forbidden:${rule.ruleId}`,
      passed,
      detail: passed ? 'Forbidden phrase absent' : 'Forbidden phrase present',
    })
  }

  const actualWords = wordCount(observation.answer)
  checks.push({
    checkId: 'max-words',
    passed: actualWords <= evalCase.rules.maxWords,
    detail: `${actualWords} words; maximum ${evalCase.rules.maxWords}`,
  })

  if (evalCase.rules.unknownAnswer.required) {
    const passed = evalCase.rules.unknownAnswer.acceptablePhrases.some((phrase) =>
      includesPhrase(observation.answer, phrase),
    )
    checks.push({
      checkId: `unknown:${evalCase.rules.unknownAnswer.ruleId}`,
      passed,
      detail: passed ? 'Unknown-answer boundary acknowledged' : 'Unknown-answer boundary missing',
    })
  }

  const normalizedAnswer = normalized(observation.answer)
  const mentionedPlaces = evalCase.venue.placeNameUniverse.filter((placeName) =>
    normalizedAnswer.includes(normalized(placeName)),
  )
  const allowedPlaces = new Set(evalCase.venue.allowedPlaceNames.map(normalized))
  const disallowedMentions = mentionedPlaces.filter(
    (placeName) => !allowedPlaces.has(normalized(placeName)),
  )
  checks.push({
    checkId: 'place-allowlist',
    passed: disallowedMentions.length === 0,
    detail:
      disallowedMentions.length === 0
        ? 'No disallowed declared place name detected'
        : `Disallowed declared place names detected: ${disallowedMentions.join(', ')}`,
  })

  const passedCheckCount = checks.filter((check) => check.passed).length
  return EvalResultSchema.parse({
    schemaVersion: EVAL_SCHEMA_VERSION,
    caseId: evalCase.caseId,
    caseHash: hashEvalCase(evalCase),
    observationHash: hashEvalObservation(observation),
    passed: passedCheckCount === checks.length,
    score: passedCheckCount / checks.length,
    checks,
  })
}

function rate(passed: number, total: number): number {
  return passed / total
}

function recomputedPassed(result: EvalResult): boolean {
  return result.checks.every((check) => check.passed)
}

function aggregateEvalResults(
  rawCases: EvalCase[],
  rawResults: EvalResult[],
  rawThresholds: EvalThresholds,
): EvalAggregate {
  const cases = rawCases.map((item) => EvalCaseSchema.parse(item))
  const results = rawResults.map((item) => EvalResultSchema.parse(item))
  const thresholds = EvalThresholdsSchema.parse(rawThresholds)
  if (cases.length === 0) throw new Error('Evaluation corpus must not be empty')

  const caseIds = new Set(cases.map((item) => item.caseId))
  const resultIds = new Set(results.map((item) => item.caseId))
  if (caseIds.size !== cases.length || resultIds.size !== results.length) {
    throw new Error('Evaluation cases and results must have unique case IDs')
  }
  if (caseIds.size !== resultIds.size || [...caseIds].some((caseId) => !resultIds.has(caseId))) {
    throw new Error('Evaluation results must match the evaluation corpus exactly')
  }

  const casesById = new Map(cases.map((item) => [item.caseId, item]))
  for (const result of results) {
    const evalCase = casesById.get(result.caseId)!
    if (result.caseHash !== hashEvalCase(evalCase)) {
      throw new Error('Evaluation result case hashes must match the evaluation corpus')
    }
    const expectedIds = expectedCheckIds(evalCase).sort()
    const actualIds = result.checks.map((check) => check.checkId).sort()
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`Evaluation result checks do not match case ${result.caseId}`)
    }
  }

  const passedCaseCount = results.filter(recomputedPassed).length
  const checks = results.flatMap((result) => result.checks)
  const passedCheckCount = checks.filter((check) => check.passed).length
  const thresholdedCategories = new Set(thresholds.categoryMinimums.map((entry) => entry.category))
  const categories = thresholds.categoryMinimums.map(({ category, minimumPassRate }) => {
    const categoryCaseIds = new Set(
      cases.filter((item) => item.category === category).map((item) => item.caseId),
    )
    if (categoryCaseIds.size === 0) {
      throw new Error(`Category threshold ${category} has no corpus cases`)
    }
    const categoryResults = results.filter((result) => categoryCaseIds.has(result.caseId))
    const categoryPassed = categoryResults.filter(recomputedPassed).length
    const passRate = rate(categoryPassed, categoryResults.length)
    return {
      category,
      caseCount: categoryResults.length,
      passedCaseCount: categoryPassed,
      passRate,
      minimumPassRate,
      passed: passRate >= minimumPassRate,
    }
  })
  const casePassRate = rate(passedCaseCount, results.length)
  const checkPassRate = rate(passedCheckCount, checks.length)
  const allCorpusCategoriesThresholded = cases.every((item) =>
    thresholdedCategories.has(item.category),
  )

  return EvalAggregateSchema.parse({
    schemaVersion: EVAL_SCHEMA_VERSION,
    passed:
      allCorpusCategoriesThresholded &&
      casePassRate >= thresholds.minimumCasePassRate &&
      checkPassRate >= thresholds.minimumCheckPassRate &&
      categories.every((category) => category.passed),
    caseCount: results.length,
    passedCaseCount,
    casePassRate,
    checkCount: checks.length,
    passedCheckCount,
    checkPassRate,
    categories,
  })
}

/**
 * Safe public evaluation path. Callers provide only case IDs and answer text; the expected
 * prompt contract, individual scoring, result integrity, and aggregation remain owned here.
 */
export function evaluateCorpus(
  rawCases: EvalCase[],
  rawObservationInputs: EvalObservationInput[],
  rawThresholds: EvalThresholds,
): { observations: EvalObservation[]; results: EvalResult[]; aggregate: EvalAggregate } {
  const cases = rawCases.map((item) => EvalCaseSchema.parse(item))
  const inputs = rawObservationInputs.map((item) => EvalObservationInputSchema.parse(item))
  const caseIds = new Set(cases.map((item) => item.caseId))
  const inputIds = new Set(inputs.map((item) => item.caseId))
  if (caseIds.size !== cases.length) throw new Error('Evaluation cases must have unique case IDs')
  if (inputIds.size !== inputs.length) {
    throw new Error('Evaluation observation inputs must have unique case IDs')
  }
  if (caseIds.size !== inputIds.size || [...caseIds].some((caseId) => !inputIds.has(caseId))) {
    throw new Error('Evaluation observation inputs must match the evaluation corpus exactly')
  }

  const inputsByCaseId = new Map(inputs.map((input) => [input.caseId, input]))
  const observations = cases.map((evalCase) =>
    createEvalObservation(inputsByCaseId.get(evalCase.caseId)!),
  )
  const results = cases.map((evalCase, index) => scoreEvalCase(evalCase, observations[index]!))
  const aggregate = aggregateEvalResults(cases, results, rawThresholds)
  return { observations, results, aggregate }
}
