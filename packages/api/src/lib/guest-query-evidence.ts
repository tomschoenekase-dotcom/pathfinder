import { createHash } from 'node:crypto'
import { guestQueryPlanningPrompt, parseGuestQueryPlan } from './guest-query-planning'
import { projectGuestQuerySource } from './guest-query-projection'
import { renderGuestQueryResult } from './guest-query-result-prompt'
import type { GuestQuerySource } from './guest-query-source'
import {
  executeGuestStructuredQuery,
  type GuestStructuredQueryPage,
} from './guest-structured-query'

/**
 * Dependency-injected query path: the existing admitted/accounted AI gateway owns interpretation.
 * This helper never opens a provider connection, retries, or authorizes a native-to-legacy fallback.
 */
export async function prepareGuestQueryEvidence(input: {
  source: GuestQuerySource
  question: string
  page?: GuestStructuredQueryPage
  interpret: (request: { system: string; question: string }) => Promise<string>
}) {
  if (
    typeof input.question !== 'string' ||
    !input.question.trim() ||
    input.question.length > 16_000
  )
    throw new Error('Invalid guest query question')
  const question = input.question
  const page = structuredClone(input.page ?? {})
  // The model callback cannot mutate the authoritative source used for execution and rendering.
  const source = structuredClone(input.source)
  const snapshot = projectGuestQuerySource(source)
  const system = guestQueryPlanningPrompt(snapshot)
  const rawPlan = await input.interpret({ system, question })
  const plan = parseGuestQueryPlan(rawPlan, snapshot)
  const trace = {
    sourceVersion: source.version,
    questionSha256: createHash('sha256').update(question).digest('hex'),
    plannerPromptSha256: createHash('sha256').update(system).digest('hex'),
    rawPlan,
    plan,
  }
  if (plan.status === 'UNSUPPORTED') return { status: 'UNSUPPORTED' as const, trace }
  const result = executeGuestStructuredQuery(snapshot, plan.query, page)
  const sources = [
    ...source.directory.places.map((place) => ({
      key: `place:${place.id}`,
      text: JSON.stringify(place),
    })),
    ...source.directory.knowledge.map((entry) => ({
      key: `knowledge:${entry.id}`,
      text: JSON.stringify(entry),
    })),
  ]
  const evidence = renderGuestQueryResult({
    result,
    sources,
    // Legacy rows do not expose authoritative policy-target relationships. Preserve whole topics
    // conservatively; never pretend a name match proves all applicable conditions were found.
    contextKeys: source.directory.knowledge.map((entry) => `knowledge:${entry.id}`),
  })
  return { status: 'READY' as const, trace, result, evidence }
}
