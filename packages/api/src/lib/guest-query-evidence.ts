import { createHash } from 'node:crypto'
import { guestQueryPlanningPrompt, parseGuestQueryPlan } from './guest-query-planning'
import { compileGuestQueryCanonicalSource } from './guest-query-canonical-projection'
import { renderGuestQueryResult } from './guest-query-result-prompt'
import { formatGuestQueryDirectAnswer } from './guest-query-direct-answer'
import type { GuestQuerySource } from './guest-query-source'
import type { GuestStructuredQueryPage } from './guest-structured-query'

/**
 * Dependency-injected query path: the existing admitted/accounted AI gateway owns interpretation.
 * This helper never opens a provider connection, retries, or authorizes a native-to-legacy fallback.
 */
export async function prepareGuestQueryEvidence(input: {
  source: GuestQuerySource
  question: string
  page?: GuestStructuredQueryPage
  directAnswer?: boolean
  validatePlannerOperation?: boolean
  interpret: (request: { system: string; question: string; validatePlan?: (text: string) => void }) => Promise<string>
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
  const compiled = compileGuestQueryCanonicalSource(source)
  const prepared = compiled.prepared
  const names = {
    question,
    catalog: prepared.discoverNamedCandidates(question),
    directoryVisibility: source.includeSecondLayer ? 'AUTHORIZED' as const : 'PUBLIC' as const,
  }
  const system = guestQueryPlanningPrompt(prepared, names)
  const rawPlan = await input.interpret({ system, question, ...(input.validatePlannerOperation ? { validatePlan: (text: string) => { parseGuestQueryPlan(text, prepared, names) } } : {}) })
  const plan = parseGuestQueryPlan(rawPlan, prepared, names)
  const trace = {
    sourceVersion: source.version,
    questionSha256: createHash('sha256').update(question).digest('hex'),
    plannerPromptSha256: createHash('sha256').update(system).digest('hex'),
    rawPlan,
    plan,
    nameCatalog: prepared.namedCatalogData(names.catalog, question),
  }
  if (plan.status === 'UNSUPPORTED') return { status: 'UNSUPPORTED' as const, trace }
  if (input.directAnswer) {
    const direct = formatGuestQueryDirectAnswer({ source, compiled, query: plan.query })
    if (direct.status === 'READY') return { ...direct, status: 'DIRECT_READY' as const, trace }
  }
  const result = prepared.evaluate(plan.query).page(page)
  const aggregate = result.mode === 'count'
  const sources = aggregate
    ? []
    : [
        ...source.directory.places.map((place) => ({
          key: `place:${place.id}`,
          text: JSON.stringify(place),
        })),
        ...source.directory.knowledge.map((entry) => ({
          key: `knowledge:${entry.id}`,
          text: JSON.stringify(entry),
        })),
        ...compiled.canonicalSources,
      ]
  const relatedKeys = new Set(
    result.rows.flatMap((row) => compiled.relatedKeysByPlace[row.key] ?? []),
  )
  const evidence = renderGuestQueryResult({
    result,
    sources,
    ...(compiled.canonicalAuthority ? { canonicalPolicyCoverage: compiled.policyCoverage } : {}),
    // Legacy rows do not expose authoritative policy-target relationships. Preserve whole topics
    // conservatively; never pretend a name match proves all applicable conditions were found.
    contextKeys: aggregate
      ? []
      : [...relatedKeys, ...source.directory.knowledge.map((entry) => `knowledge:${entry.id}`)],
  })
  return {
    status: 'READY' as const,
    trace,
    result,
    evidence,
    canonicalAuthority: compiled.canonicalAuthority,
    canonicalSources: compiled.canonicalSources.filter((body) =>
      evidence.includedContextKeys.includes(body.key),
    ),
    policyCoverage: compiled.policyCoverage,
  }
}
