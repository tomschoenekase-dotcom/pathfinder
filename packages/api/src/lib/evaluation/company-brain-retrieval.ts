import {
  generateTextForCapability,
  resolveAiWorkloadConfiguration,
  routeAiCapability,
  type AiAdmissionGuard,
  type AiBudgetGate,
  type AiUsageSink,
} from '@pathfinder/ai'
import { z } from 'zod'

export const COMPANY_BRAIN_RETRIEVAL_EVAL_VERSION = 'company-brain-retrieval-eval.v1' as const

export const CompanyBrainRetrievalCaseSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    category: z.enum([
      'ACCOUNT_IDENTITY',
      'RELATIONSHIP',
      'OPEN_LOOPS',
      'MEETING',
      'CURRENT_DECISION',
      'SUPPORT_HANDOFF',
    ]),
    compactContext: z.unknown(),
    knowledgeResults: z.array(z.unknown()).default([]),
    expectedFacts: z.array(z.string().min(1)).min(1),
    requiredSourceIds: z.array(z.string().min(1)).default([]),
    forbiddenClaims: z.array(z.string().min(1)).default([]),
    deepKnowledgeRequired: z.boolean(),
    maxInputBytes: z.number().int().positive().default(24_000),
    maxAnswerBytes: z.number().int().positive().default(4_000),
  })
  .strict()

export type CompanyBrainRetrievalCase = z.infer<typeof CompanyBrainRetrievalCaseSchema>

export const CompanyBrainRetrievalAnswerSchema = z
  .object({
    answer: z.string().min(1),
    facts: z.array(z.string()).default([]),
    sourceIds: z.array(z.string()).default([]),
    usedDeepKnowledge: z.boolean(),
    uncertainty: z.array(z.string()).default([]),
  })
  .strict()

export type CompanyBrainRetrievalAnswer = z.infer<typeof CompanyBrainRetrievalAnswerSchema>

export type CompanyBrainRetrievalScore = {
  version: typeof COMPANY_BRAIN_RETRIEVAL_EVAL_VERSION
  caseId: string
  passed: boolean
  score: number
  checks: {
    factualCorrectness: boolean
    sourceGrounding: boolean
    currentVsHistorical: boolean
    retrievalEconomy: boolean
    noHallucinatedSource: boolean
    payloadEfficiency: boolean
  }
  metrics: { inputBytes: number; answerBytes: number; expectedFactsFound: number }
}

function normalized(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

function includesClaim(haystack: string, claim: string) {
  return normalized(haystack).includes(normalized(claim))
}

export function scoreCompanyBrainRetrievalAnswer(
  rawCase: CompanyBrainRetrievalCase,
  rawAnswer: CompanyBrainRetrievalAnswer,
): CompanyBrainRetrievalScore {
  const evalCase = CompanyBrainRetrievalCaseSchema.parse(rawCase)
  const answer = CompanyBrainRetrievalAnswerSchema.parse(rawAnswer)
  const answerEvidence = [answer.answer, ...answer.facts].join('\n')
  const expectedFactsFound = evalCase.expectedFacts.filter((fact) =>
    includesClaim(answerEvidence, fact),
  ).length
  const availableSourceIds = new Set([
    ...extractSourceIds(evalCase.compactContext),
    ...extractSourceIds(evalCase.knowledgeResults),
  ])
  const checks = {
    factualCorrectness: expectedFactsFound === evalCase.expectedFacts.length,
    sourceGrounding: evalCase.requiredSourceIds.every((id) => answer.sourceIds.includes(id)),
    currentVsHistorical: evalCase.forbiddenClaims.every(
      (claim) => !includesClaim(answerEvidence, claim),
    ),
    retrievalEconomy: answer.usedDeepKnowledge === evalCase.deepKnowledgeRequired,
    noHallucinatedSource: answer.sourceIds.every((id) => availableSourceIds.has(id)),
    payloadEfficiency:
      Buffer.byteLength(
        JSON.stringify({
          compactContext: evalCase.compactContext,
          knowledgeResults: evalCase.knowledgeResults,
        }),
      ) <= evalCase.maxInputBytes &&
      Buffer.byteLength(JSON.stringify(answer)) <= evalCase.maxAnswerBytes,
  }
  const values = Object.values(checks)
  return {
    version: COMPANY_BRAIN_RETRIEVAL_EVAL_VERSION,
    caseId: evalCase.id,
    passed: values.every(Boolean),
    score: values.filter(Boolean).length / values.length,
    checks,
    metrics: {
      inputBytes: Buffer.byteLength(
        JSON.stringify({
          compactContext: evalCase.compactContext,
          knowledgeResults: evalCase.knowledgeResults,
        }),
      ),
      answerBytes: Buffer.byteLength(JSON.stringify(answer)),
      expectedFactsFound,
    },
  }
}

function extractSourceIds(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (candidate: unknown, key?: string) => {
    if (typeof candidate === 'string' && key && /(^id$|Id$|sourceId$)/u.test(key)) {
      found.add(candidate)
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item))
      return
    }
    if (candidate && typeof candidate === 'object') {
      Object.entries(candidate).forEach(([childKey, child]) => visit(child, childKey))
    }
  }
  visit(value)
  return [...found]
}

function parseProviderAnswer(text: string): CompanyBrainRetrievalAnswer {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1]
  return CompanyBrainRetrievalAnswerSchema.parse(JSON.parse(fenced ?? text))
}

/**
 * Executes a bounded provider-backed replay through the shared Packet A router.
 * Callers own admission, budget reservation, and durable usage persistence.
 */
export async function runProviderBackedCompanyBrainRetrievalEvaluation(params: {
  evalCase: CompanyBrainRetrievalCase
  admissionGuard: AiAdmissionGuard
  budgetGate: AiBudgetGate
  usageSink: AiUsageSink
}) {
  const evalCase = CompanyBrainRetrievalCaseSchema.parse(params.evalCase)
  const configuration = resolveAiWorkloadConfiguration({
    workloadId: 'company-brain-retrieval-evaluation',
  })
  const route = routeAiCapability({
    workloadId: configuration.workloadId,
    configuration,
    capability: 'BACKGROUND_ANALYSIS',
    budgetPolicy: 'ECONOMY_ONLY',
    qualityPreference: 'ECONOMY',
  })
  const payload = {
    question: evalCase.question,
    compactContext: evalCase.compactContext,
    knowledgeResults: evalCase.knowledgeResults,
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > evalCase.maxInputBytes) {
    throw new Error('Company Brain retrieval evaluation input exceeds its case budget')
  }
  const result = await generateTextForCapability({
    route,
    system: [
      {
        type: 'text',
        text: [
          'You are evaluating grounded retrieval, not performing business actions.',
          'Use only the supplied Torchiko context. Never invent source IDs.',
          'Treat current/authoritative records as controlling over historical or superseded records.',
          'Return strict JSON: {"answer":string,"facts":string[],"sourceIds":string[],"usedDeepKnowledge":boolean,"uncertainty":string[]}.',
        ].join(' '),
      },
    ],
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    maxOutputTokens: 900,
    timeoutMs: configuration.timeoutMs,
    maxAttempts: configuration.maxAttempts,
    admissionGuard: params.admissionGuard,
    budgetGate: params.budgetGate,
    requestBudgetCeilingE8Usd: configuration.requestBudgetCeilingE8Usd,
    usageSink: params.usageSink,
    parseResponse: parseProviderAnswer,
  })
  return {
    answer: result.parsed,
    score: scoreCompanyBrainRetrievalAnswer(evalCase, result.parsed),
    route: result.route,
    usage: result.usage,
  }
}

export const COMPANY_BRAIN_RETRIEVAL_QUESTIONS = Object.freeze([
  'Who is this client and what is our current relationship?',
  'When did we first contact them?',
  'What communication preferences have they confirmed?',
  'Why do they have an unusual pricing arrangement?',
  'What action is waiting on Torchiko?',
  'What did the last meeting decide?',
  'Is the old pricing decision still current?',
  'What should I know before replying to this support ticket?',
])
