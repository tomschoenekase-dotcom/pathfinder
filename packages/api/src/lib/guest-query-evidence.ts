import { createHash } from 'node:crypto'
import { prepareGuestQueryLookup } from './guest-query-lookup'
import { prepareGuestSubjectEvidence } from './guest-query-subject-evidence'
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
  interpret: (request: {
    system: string
    question: string
    validatePlan?: (text: string) => void
  }) => Promise<string>
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
    directoryVisibility: source.includeSecondLayer ? ('AUTHORIZED' as const) : ('PUBLIC' as const),
  }
  const system = guestQueryPlanningPrompt(prepared, names)
  const rawPlan = await input.interpret({
    system,
    question,
    ...(input.validatePlannerOperation
      ? {
          validatePlan: (text: string) => {
            parseGuestQueryPlan(text, prepared, names)
          },
        }
      : {}),
  })
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
  if (plan.status === 'EVIDENCE_PARTIAL_SUBJECTS') {
    if (Object.keys(page).length)
      throw new Error('Partial subject evidence does not support paging')
    const evidence = prepareGuestSubjectEvidence({
      source,
      compiled,
      keys: plan.keys,
      mode: 'CONDITIONAL',
      unresolved: plan.unresolved,
    })
    const prompt =
      'PARTIAL SUBJECT EVIDENCE: questionCoverage=PARTIAL. The planner unresolved excerpts are requests still needing evidence. They are not source facts or proof that no answer exists. Answer any portion established by retained public records and explicit relationships; clearly state any remainder that those sources do not establish. An explicit public service-to-place link may establish that place record and its own facts. Do not infer a related identity or policy applicability from proximity. A proved service-to-place link does not transfer service policies to the place or place rules to the service. Preserve declared policy scopes and exceptions. Do not claim the entire question, an eligible count, or a complete eligible list has been established.\n' +
      evidence.prompt
    if (prompt.length > 30_000) throw new Error('Whole partial subject prompt bound; no truncation')
    return {
      status: 'LOOKUP_READY' as const,
      trace,
      lookup: {
        ...evidence,
        prompt,
        summary: { ...evidence.summary, questionCoverage: 'PARTIAL' as const },
      },
    }
  }
  if (plan.status === 'EVIDENCE_SUBJECTS') {
    if (input.page && Object.keys(input.page).length)
      throw new Error('Subject evidence does not support paging')
    return {
      status: 'LOOKUP_READY' as const,
      trace,
      lookup: prepareGuestSubjectEvidence({ source, compiled, keys: plan.keys, mode: 'DETAILS' }),
    }
  }
  if (plan.status === 'EVIDENCE_LOOKUP') {
    if (input.page && Object.keys(input.page).length)
      throw new Error('Lookup does not support paging')
    return {
      status: 'LOOKUP_READY' as const,
      trace,
      lookup: prepareGuestQueryLookup({
        source,
        compiled,
        question,
        anchor: plan.anchor,
        unresolved: plan.unresolved,
      }),
    }
  }
  const result = prepared.evaluate(plan.query).page(page)
  if (result.mode === 'list' && result.matchingKeys.some((key) => key.startsWith('knowledge:'))) {
    if (result.matchingKeys.length > 50 || (input.page && Object.keys(input.page).length))
      throw new Error('Whole Knowledge subject evidence bound')
    return {
      status: 'LOOKUP_READY' as const,
      trace,
      lookup: prepareGuestSubjectEvidence({
        source,
        compiled,
        keys: result.matchingKeys,
        mode: 'DETAILS',
      }),
    }
  }
  if (input.directAnswer) {
    const direct = formatGuestQueryDirectAnswer({ source, compiled, query: plan.query })
    if (direct.status === 'READY') return { ...direct, status: 'DIRECT_READY' as const, trace }
  }
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
