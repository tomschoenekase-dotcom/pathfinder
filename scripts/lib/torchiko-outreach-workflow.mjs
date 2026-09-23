import { createLocalCrmClient, readTorchikoWritingGuide } from './torchiko-crm-client.mjs'
import { compileNativeOutreachResult, textSha256 } from './torchiko-outreach-result.mjs'

export class OutreachWorkflowHold extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details }
}
const hold = (code, message, details) => { throw new OutreachWorkflowHold(code, message, details) }
const unwrap = value => value?.representation === 'superjson' ? value.json : value
const normalize = text => String(text).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 191

/** One native owner throughout. A name match never grants permission or chooses
 * a recipient. Explicit native IDs survive a fresh chat and disambiguation. */
export function createOutreachWorkflow({ client = createLocalCrmClient(),
  readGuide = readTorchikoWritingGuide } = {}) {
  async function resolveVenue({ name, venueId } = {}) {
    if (venueId !== undefined) {
      if (!safeId(venueId)) hold('INVALID_VENUE_ID', 'A bounded native venue ID is required.')
      return { venueId, match: 'EXPLICIT_NATIVE_ID' }
    }
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 200)
      hold('VENUE_REQUIRED', 'Name the venue or supply its exact native venue ID.')
    const result = unwrap(await client.search({ search: name, limit: 25 }))
    if (!Array.isArray(result?.items)) hold('DIRECTORY_UNAVAILABLE', 'The native directory did not return a readable page.')
    // Never assume a capped first page is a complete unique-name search.
    if (result.nextCursor || (result.totalCount != null && result.totalCount > result.items.length))
      hold('AMBIGUOUS_VENUE', 'More matches exist. Select an exact native venue ID; no additional page was selected automatically.')
    const venues = result.items.flatMap(organization => (organization.venues ?? []).map(venue => ({
      venueId: venue.id, organizationId: organization.id, name: venue.name,
      city: venue.city ?? null, region: venue.region ?? null,
    }))).filter(venue => normalize(venue.name) === normalize(name))
    const matches = [...new Map(venues.map(venue => [venue.venueId, venue])).values()]
    if (matches.length !== 1) hold(matches.length ? 'AMBIGUOUS_VENUE' : 'VENUE_NOT_FOUND',
      'The name does not identify exactly one native location. Select a record without guessing.', { matches })
    return { ...matches[0], match: 'EXACT_NATIVE_NAME' }
  }
  async function inspect(selection) {
    const resolved = await resolveVenue(selection)
    const view = unwrap(await client.read(resolved.venueId))
    if (view?.venueId !== resolved.venueId || view.SEND_AUTHORIZED !== false)
      hold('NATIVE_READ_MISMATCH', 'Native record identity or no-send boundary did not reproduce.')
    return { resolved, view, research: researchForCurrentOutreach(view) }
  }
  async function prepare(selection) {
    const { view, resolved, research } = await inspect(selection)
    if (view.suppression?.blocked) hold('SUPPRESSED', 'Native suppression blocks preparation.', view.suppression)
    if (view.gate?.canPrepare !== true) hold('RESEARCH_OR_HISTORY_HOLD',
      view.blocker ?? 'Current native research or correspondence context is held.', { research })
    const guide = await readGuide()
    // Reuse a current task with the same selected reference and requested reply
    // direction. No pointless re-preparation that changes the import binding.
    const canReuse = !selection.answerText && !selection.selectedThreadId &&
      !view.preparation?.stale && !view.writerHold && view.writerTask &&
      view.writerTask.writingReference?.sha256 === guide.sha256
    if (canReuse) return { resolved, task: view.writerTask, reused: true, research, SEND_AUTHORIZED: false }
    await client.prepare({ venueId: resolved.venueId, expectedSnapshotHash: view.snapshotHash,
      writingReference: guide,
      ...(selection.answerText ? { answerText: selection.answerText } : {}),
      ...(selection.selectedThreadId ? { selectedThreadId: selection.selectedThreadId } : {}) })
    const task = await client.task(resolved.venueId)
    if (task.writingReference?.sha256 !== guide.sha256) hold('REFERENCE_BINDING_CHANGED', 'Read the current selected writing reference before drafting.')
    return { resolved, task, reused: false, research, SEND_AUTHORIZED: false }
  }
  async function importResult(result) {
    // This is deliberately the FIRST network operation. Re-reading/re-preparing
    // before retry would destroy the original compare-and-swap binding.
    const accepted = await client.submit(result)
    return { ...accepted, SEND_AUTHORIZED: false }
  }
  return { resolveVenue, inspect, prepare, importResult,
    compile: compileNativeOutreachResult,
    async importText({ task, candidate, modelIdentity }) {
      return importResult(compileNativeOutreachResult(task, candidate, modelIdentity))
    },
    async reopen(venueId) { return client.read(venueId) },
  }
}

/** The original research gate owns sufficiency/freshness. This is an actionable
 * projection, not another freshness engine, automatic crawl or research store. */
export function researchForCurrentOutreach(view) {
  const needed = (view.gate?.questions ?? []).map(q => ({ id: q.id, question: q.question, reason: q.why }))
  const human = [...(view.gate?.humanQuestions ?? [])]
  const historyIssues = (view.threadCandidates ?? []).flatMap(thread =>
    thread.sourceComplete ? [] : (thread.sourceIssues ?? []).map(reason => ({ threadId: thread.id, reason })))
  return {
    schema: 'torchiko.outreach-research-decision/1', venueId: view.venueId,
    snapshotHash: view.snapshotHash, action: view.suppression?.blocked ? 'STOP_SUPPRESSED'
      : view.gate?.canPrepare ? 'REUSE_CURRENT_NATIVE_EVIDENCE' : 'RESOLVE_ONLY_CURRENT_BLOCKERS',
    needed, human, historyIssues, notices: view.gate?.notices ?? [],
    sourceCount: view.sourceCount, sourceState: view.sourceState,
    retentionOwner: 'Native prospect source evidence, selected claim admission and Chicago venue intelligence',
    retentionRule: 'Retain useful identity, venue context and public contact evidence with source/date/uncertainty through native evidence tools. A supplied website or writing reference is not verification. Do not copy a whole crawl into the CRM or refresh durable facts solely because another email is requested.',
    noAutomaticResearch: true, SEND_AUTHORIZED: false,
  }
}

/** A renderable exact review projection; retained pointers stay with native
 * campaign members. Never infer delivery or an incoming reply from draft text. */
export function exactOutreachReview(view) {
  if (!view?.venueId || view.SEND_AUTHORIZED !== false) hold('NATIVE_REVIEW_REQUIRED', 'Read the native venue before building its review.')
  const draft = view.draft
  return { venueId: view.venueId, name: view.name, snapshotHash: view.snapshotHash,
    recipient: view.routing?.value ?? null, routeKind: view.routing?.kind ?? 'unresolved',
    draft: draft ? { id: draft.id, version: draft.version, subject: draft.subject,
      body: draft.body, contentHash: draft.contentHash, state: draft.state,
      model: draft.writerAttribution?.generatedBy ?? null } : null,
    preparationStale: view.preparation?.stale ?? null,
    meaning: view.claimReview ?? null, suppression: view.suppression,
    outreachState: view.outreachState, correspondenceState: view.correspondenceState,
    threadCoverage: (view.threadCandidates ?? []).map(t => ({ id: t.id, count: t.messageCount,
      complete: t.sourceComplete, issues: t.sourceIssues })),
    operational: view.operational ?? null, blocker: view.blocker,
    exactTextSha256: draft ? textSha256(JSON.stringify([draft.subject, draft.body])) : null,
    SEND_AUTHORIZED: false }
}
