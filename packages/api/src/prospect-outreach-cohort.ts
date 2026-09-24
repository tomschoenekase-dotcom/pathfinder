import { randomUUID } from 'node:crypto'
import {
  db,
  readNativeSalesSnapshot,
  withTenantIsolationBypass,
  type DbInputJsonValue,
} from '@pathfinder/db'
import { getNativeSalesWorkflow } from './prospect-sales-workflow'
import {
  cohortHash,
  cohortObject,
  planOutreachCohort,
  readCohortMemberState,
  outreachCohortPreviewInput,
  outreachCohortReserveInput,
  outreachCohortReadInput,
  outreachCohortWindowInput,
  outreachCohortCheckpointInput,
  outreachCohortAcknowledgeInput,
  outreachCohortListInput,
  outreachCohortControlInput,
  outreachCohortControlReceipt,
  type CohortCandidate,
  type CohortMemberState,
} from './prospect-outreach-cohort-contract'
import type { SalesWorkflowView } from './prospect-sales-contract'

export type OutreachCohortActor = {
  id: string
  type: 'HUMAN' | 'AGENT'
  runId: string
  scope: { mode: 'ALL' } | { mode: 'TERRITORIES'; territoryIds: readonly string[] }
  capabilities: readonly string[]
}
type Client = typeof db
type Tx = Parameters<Parameters<Client['$transaction']>[0]>[0]
const json = (value: unknown): DbInputJsonValue => JSON.parse(JSON.stringify(value))
const schema = 'torchiko.outreach-preparation-cohort/1'
const sender = 'tomschoenekase@torchiko.com'
export class OutreachCohortError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND' | 'HELD',
    message: string,
  ) {
    super(message)
    this.name = 'OutreachCohortError'
  }
}
function fail(code: OutreachCohortError['code'], message: string): never {
  throw new OutreachCohortError(code, message)
}

/** Callers obtain actors from the existing authenticated admin context or the
 * live leased prospect registry. Actor/scope/capabilities are NEVER RPC input. */
function authorize(actor: OutreachCohortActor, write = false) {
  if (
    !actor.id ||
    !actor.runId ||
    !['HUMAN', 'AGENT'].includes(actor.type) ||
    !actor.capabilities.includes('prospects.read') ||
    !actor.capabilities.includes('prospects.correspondence.read') ||
    (write && !actor.capabilities.includes('prospects.maintain'))
  )
    fail('FORBIDDEN', 'Current native prospect read/maintenance authority is required.')
  if (actor.scope.mode === 'TERRITORIES' && !actor.scope.territoryIds.length)
    fail('FORBIDDEN', 'An empty territory grant does not grant organization history.')
}
function organizationWhere(actor: OutreachCohortActor) {
  if (actor.scope.mode === 'ALL') return {}
  const territoryId = { in: [...actor.scope.territoryIds] }
  return {
    AND: [
      {
        OR: [
          { venues: { some: { archivedAt: null, territoryId } } },
          { territoryId, venues: { none: {} } },
        ],
      },
      { venues: { every: { AND: [{ territoryId: { not: null } }, { territoryId }] } } },
    ],
  }
}
async function scopedVenue(tx: Tx, venueId: string, actor: OutreachCohortActor) {
  const venue = await tx.prospectVenue.findFirst({
    where: { id: venueId, organization: organizationWhere(actor) },
    include: {
      intelligence: true,
      geography: true,
      intelligenceReviews: { where: { status: 'OPEN' }, select: { id: true, kind: true } },
    },
  })
  if (!venue) fail('NOT_FOUND', 'Venue is unavailable in the current complete organization scope.')
  return venue
}
async function readGroup(tx: Tx, cohortId: string, actor: OutreachCohortActor) {
  const group = await tx.prospectOutreachCampaign.findUnique({
    where: { id: cohortId },
    include: { members: { orderBy: { id: 'asc' }, take: 51 } },
  })
  if (!group || cohortObject(group.cohortSnapshot).schema !== schema)
    fail('NOT_FOUND', 'Native preparation cohort not found.')
  if (!group.members.length || group.members.length > 50)
    fail('HELD', 'Native cohort size no longer matches the bounded contract.')
  const allowed = await tx.prospectOrganization.count({
    where: {
      id: { in: [...new Set(group.members.map((m) => m.organizationId))] },
      ...organizationWhere(actor),
    },
  })
  if (allowed !== new Set(group.members.map((m) => m.organizationId)).size)
    fail(
      'FORBIDDEN',
      'The entire retained cohort must remain inside the current grant. No partial list is presented as complete.',
    )
  return group
}
async function candidate(
  tx: Tx,
  selected: { venueId: string; contactId: string | null },
  actor: OutreachCohortActor,
  excludeGroupId?: string,
): Promise<CohortCandidate> {
  const venue = await scopedVenue(tx, selected.venueId, actor)
  const snapshot = await readNativeSalesSnapshot(venue.id, tx)
  const contact = snapshot.contacts.find((c) => c.id === selected.contactId)
  if (selected.contactId && !contact)
    fail(
      'CONFLICT',
      'Selected contact no longer belongs to this exact native venue. No replacement is chosen.',
    )
  const [draft, prior, legacyActivity] = await Promise.all([
    tx.prospectOutreachDraft.findFirst({
      where: { venueId: venue.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    }),
    tx.prospectCampaignMember.findMany({
      where: {
        ...(excludeGroupId ? { campaignId: { not: excludeGroupId } } : {}),
        OR: [
          { organizationId: venue.organizationId },
          { venueId: venue.id },
          ...(selected.contactId ? [{ contactId: selected.contactId }] : []),
          ...(contact?.normalizedEmail
            ? [{ contact: { normalizedEmail: contact.normalizedEmail } }]
            : []),
        ],
      },
      take: 51,
      select: { campaignId: true, organizationId: true },
    }),
    tx.prospectActivity.count({
      where: {
        organizationId: venue.organizationId,
        type: { in: ['OUTREACH_SENT', 'REPLY_RECEIVED'] },
      },
    }),
  ])
  const fields = cohortObject(venue.intelligence?.fields)
  const sizeField = cohortObject(fields.estimatedSize)
  const sizeUrls = Array.isArray(sizeField.sourceUrls) ? sizeField.sourceUrls : []
  const claims = Array.isArray(venue.intelligence?.contactClaims)
    ? venue.intelligence.contactClaims
    : []
  const publishedRoute = claims
    .map(cohortObject)
    .some(
      (c) =>
        c.channel === 'email' &&
        typeof c.value === 'string' &&
        c.value.toLowerCase() === contact?.normalizedEmail &&
        c.status === 'verified-public-claim' &&
        Array.isArray(c.sourceUrls) &&
        c.sourceUrls.length > 0 &&
        c.sourceUrls.every((url) => snapshot.sources.some((s) => s.sourceUrl === url)),
    )
  // Cross-scope matching addresses are used only for an exclusion boolean. Do
  // not disclose another organization's campaign IDs through that check.
  const priorGroupIds = [
    ...new Set(
      prior.filter((p) => p.organizationId === venue.organizationId).map((p) => p.campaignId),
    ),
  ]
  return {
    venueId: venue.id,
    organizationId: venue.organizationId,
    name: venue.name,
    contactId: contact?.id ?? null,
    recipient: contact?.normalizedEmail ?? null,
    city: venue.city,
    region: venue.region,
    geographyStatus: venue.geography?.status ?? null,
    countyGeoid: venue.geography?.countyGeoid ?? null,
    size: venue.estimatedSize,
    sizeVerified:
      sizeField.status === 'verified' &&
      sizeField.value === venue.estimatedSize &&
      sizeUrls.length > 0 &&
      sizeUrls.every((url) => snapshot.sources.some((s) => s.sourceUrl === url)),
    relationshipTier: snapshot.organization.relationshipTier,
    opportunityStage: snapshot.organization.opportunity?.stage ?? null,
    nativeSnapshotHash: snapshot.snapshotHash,
    currentDraftId: draft?.id ?? null,
    sourceIds: snapshot.sources.map((s) => s.id),
    sourceCount: snapshot.sources.length,
    suppressed: snapshot.suppression.blocked,
    suppressionReasons: snapshot.suppression.reasons,
    history:
      snapshot.threadCoverage.some((t) => !t.complete) ||
      (!snapshot.threads.length && legacyActivity > 0)
        ? 'INCOMPLETE_OR_UNAVAILABLE'
        : snapshot.threads.length
          ? 'RETAINED_HISTORY'
          : 'NO_RETAINED_HISTORY',
    identityReviewOpen: venue.intelligenceReviews.some((r) =>
      /IDENTITY|DUPLICATE|SAME_OPERATOR|QUARANTINE/u.test(r.kind),
    ),
    priorGroupIds,
    priorContactReservation: prior.some((p) => p.organizationId !== venue.organizationId),
    contactSelected: Boolean(contact),
    contactVerified: Boolean(publishedRoute && contact?.emailReadiness === 'VALID'),
  }
}

/** Native campaign/member persistence, native source/gate/draft owners and native
 * activity history. No JSON-file CRM, second outbox, sender or approval owner. */
export function createOutreachCohortService(
  dependencies: {
    client?: Client
    readView?: (venueId: string) => Promise<SalesWorkflowView>
    now?: () => Date
    revalidate?: () => Promise<void>
  } = {},
) {
  const client = dependencies.client ?? db
  const readView =
    dependencies.readView ?? ((venueId) => getNativeSalesWorkflow(venueId, 'authenticated-admin'))
  const now = dependencies.now ?? (() => new Date())
  async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.$transaction(
          async (tx) => {
            const result = await fn(tx)
            await dependencies.revalidate?.()
            return result
          },
          { isolationLevel: 'Serializable', timeout: 60000, maxWait: 10000 },
        )
      } catch (error) {
        if (attempt < 2 && ['P2034', 'P2002'].includes(String(cohortObject(error).code))) continue
        throw error
      }
    }
  }
  async function previewIn(tx: Tx, raw: unknown, actor: OutreachCohortActor) {
    const input = outreachCohortPreviewInput.parse(raw)
    const candidates: CohortCandidate[] = []
    for (const selected of input.candidates) candidates.push(await candidate(tx, selected, actor))
    return planOutreachCohort(input, candidates)
  }
  async function audit(
    tx: Tx,
    group: { id: string },
    member: { organizationId: string; venueId: string | null; contactId: string | null },
    actor: OutreachCohortActor,
    operation: string,
    evidence: unknown,
  ) {
    await tx.prospectActivity.create({
      data: {
        organizationId: member.organizationId,
        venueId: member.venueId,
        contactId: member.contactId,
        type: 'NOTE_ADDED',
        summary: `No-send outreach preparation: ${operation}`,
        actorId: actor.id,
        evidence: json({
          schema,
          cohortId: group.id,
          operation,
          actorType: actor.type,
          actorRunId: actor.runId,
          detail: evidence,
          SEND_AUTHORIZED: false,
        }),
      },
    })
  }
  async function updateMember(
    tx: Tx,
    member: { id: string; updatedAt: Date },
    state: CohortMemberState,
  ) {
    const changed = await tx.prospectCampaignMember.updateMany({
      where: { id: member.id, updatedAt: member.updatedAt },
      data: {
        selection: json({ ...state, revision: state.revision + 1 }),
        status: state.state === 'REVIEW_REQUIRED' ? 'NEEDS_REVIEW' : 'SELECTED',
      },
    })
    if (changed.count !== 1)
      fail('CONFLICT', 'Preparation lease or result changed. Reopen the native cohort.')
  }
  async function appendAggregateReceipt(
    tx: Tx,
    group: Awaited<ReturnType<typeof readGroup>>,
    collection: 'windows' | 'reviews' | 'controls',
    receipt: { id: string; inputHash: string; result: unknown },
    lifecycle?: {
      status: 'DRAFT' | 'PAUSED' | 'CANCELLED'
      pausedAt: Date | null
      updatedBy: string
    },
  ) {
    const snapshot = cohortObject(group.cohortSnapshot)
    const retained = Array.isArray(snapshot[collection]) ? (snapshot[collection] as unknown[]) : []
    const limit = collection === 'windows' ? 200 : 30
    if (retained.length >= limit)
      fail(
        'HELD',
        'This native cohort has reached its retained receipt bound. An operator must review it; no history was discarded.',
      )
    const changed = await tx.prospectOutreachCampaign.updateMany({
      where: { id: group.id, updatedAt: group.updatedAt },
      data: {
        ...lifecycle,
        cohortSnapshot: json({ ...snapshot, [collection]: [...retained, receipt] }),
      },
    })
    if (changed.count !== 1) fail('CONFLICT', 'Native aggregate changed while saving its receipt.')
  }
  async function reviewIn(group: Awaited<ReturnType<typeof readGroup>>) {
    const rows = []
    for (const member of group.members) {
      const state = readCohortMemberState(member.selection)
      let view: SalesWorkflowView | null = null
      let unavailable = false
      try {
        view = await readView(member.venueId!)
      } catch {
        unavailable = true
      }
      const draft = view?.draft
      const exact = Boolean(
        draft && state.draft?.id === draft.id && state.draft.contentHash === draft.contentHash,
      )
      rows.push({
        memberId: member.id,
        organizationId: member.organizationId,
        venueId: member.venueId,
        contactId: member.contactId,
        selectionHash: cohortHash(state),
        state: state.state,
        leaseExpired: Boolean(state.lease && Date.parse(state.lease.expiresAt) <= now().getTime()),
        attempt: state.attempt,
        name: state.selection.name,
        reasons: state.reasons,
        pinnedDraft: state.draft,
        task: state.task,
        nativeRead: unavailable ? 'UNAVAILABLE' : 'READ',
        currentSnapshotHash: view?.snapshotHash ?? null,
        recipient: view?.routing?.value ?? state.selection.recipient,
        routeKind: view?.routing?.kind ?? null,
        draft: draft
          ? {
              id: draft.id,
              version: draft.version,
              contentHash: draft.contentHash,
              subject: draft.subject,
              body: draft.body,
              state: draft.state,
              generatedBy: draft.writerAttribution?.generatedBy ?? null,
            }
          : null,
        exactSelectedDraft: exact,
        stale: view?.preparation?.stale ?? null,
        writerHold: view?.writerHold ?? null,
        suppression: view?.suppression ?? {
          blocked: true,
          reasons: ['CURRENT_NATIVE_READ_UNAVAILABLE'],
        },
        sourceState: view?.sourceState ?? 'UNAVAILABLE',
        blocker: view?.blocker ?? null,
        outreachState: view?.outreachState ?? 'UNAVAILABLE',
        correspondenceState: view?.correspondenceState ?? 'UNAVAILABLE',
        threadCoverage:
          view?.threadCandidates.map((t) => ({
            id: t.id,
            count: t.messageCount,
            complete: t.sourceComplete,
            issues: t.sourceIssues,
          })) ?? [],
        operational: view?.operational ?? null,
      })
    }
    const snapshot = {
      schema: 'torchiko.outreach-exact-review/1',
      cohortId: group.id,
      name: group.name,
      status: group.status,
      pausedAt: group.pausedAt?.toISOString() ?? null,
      preparationAvailable: group.status === 'DRAFT' && !group.pausedAt,
      question: cohortObject(group.cohortSnapshot).question,
      count: rows.length,
      rows,
      readyForHumanReview: rows.filter(
        (r) =>
          r.exactSelectedDraft &&
          r.stale === false &&
          !r.writerHold &&
          !r.suppression.blocked &&
          r.nativeRead === 'READ',
      ).length,
      sender,
      SEND_AUTHORIZED: false as const,
    }
    return { ...snapshot, reviewHash: cohortHash(snapshot) }
  }
  return {
    async list(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor)
      const input = outreachCohortListInput.parse(raw)
      return withTenantIsolationBypass(async () => {
        const where = {
          cohortSnapshot: { path: ['schema'], equals: schema },
          members: { some: {}, every: { organization: organizationWhere(actor) } },
        }
        if (
          input.cursor &&
          !(await client.prospectOutreachCampaign.findFirst({
            where: { id: input.cursor, ...where },
            select: { id: true },
          }))
        )
          fail(
            'NOT_FOUND',
            'This cursor is not a current authorized preparation group. Restart the native listing; do not infer an empty directory.',
          )
        const rows = await client.prospectOutreachCampaign.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { members: true } },
          },
        })
        await dependencies.revalidate?.()
        return {
          items: rows
            .slice(0, input.limit)
            .map((r) => ({
              cohortId: r.id,
              name: r.name,
              status: r.status,
              count: r._count.members,
              createdAt: r.createdAt.toISOString(),
              updatedAt: r.updatedAt.toISOString(),
            })),
          nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
          SEND_AUTHORIZED: false,
        }
      })
    },
    async preview(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor)
      return withTenantIsolationBypass(() => transaction((tx) => previewIn(tx, raw, actor)))
    },
    async control(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor, true)
      if (actor.type !== 'HUMAN')
        fail(
          'FORBIDDEN',
          'Only the authenticated operator may pause, cancel or resume an entire exact group.',
        )
      const input = outreachCohortControlInput.parse(raw)
      return withTenantIsolationBypass(() =>
        transaction(async (tx) => {
          const group = await readGroup(tx, input.cohortId, actor)
          const receiptId = `outreach-control_${cohortHash({ group: group.id, actor: actor.id, key: input.requestKey }).slice(0, 40)}`
          const saved = cohortObject(group.cohortSnapshot).controls
          const prior = Array.isArray(saved)
            ? saved.map(cohortObject).find((r) => r.id === receiptId)
            : undefined
          if (prior) {
            if (prior.inputHash !== cohortHash(input))
              fail('CONFLICT', 'This control request key belongs to different exact parameters.')
            return {
              ...outreachCohortControlReceipt.parse(prior.result),
              replayed: true,
              currentContextNotRevalidated: true,
              SEND_AUTHORIZED: false,
            }
          }
          if (!['DRAFT', 'PAUSED', 'CANCELLED'].includes(group.status))
            fail('HELD', 'Only no-send preparation lifecycle states may be changed here.')
          const review = await reviewIn(group)
          if (review.reviewHash !== input.expectedReviewHash)
            fail(
              'CONFLICT',
              'The exact group changed. Reopen before changing its preparation state.',
            )
          const status =
            input.action === 'pause'
              ? ('PAUSED' as const)
              : input.action === 'cancel'
                ? ('CANCELLED' as const)
                : ('DRAFT' as const)
          const result = outreachCohortControlReceipt.parse({
            cohortId: group.id,
            receiptId,
            status,
            reason: input.reason,
            retainedMembers: group.members.length,
            priorGroupExclusionRetained: true,
            draftsDeleted: false,
            deliveryChanged: false,
            replayed: false,
            SEND_AUTHORIZED: false,
          })
          await appendAggregateReceipt(
            tx,
            group,
            'controls',
            { id: receiptId, inputHash: cohortHash(input), result },
            { status, pausedAt: status === 'DRAFT' ? null : now(), updatedBy: actor.id },
          )
          for (const member of group.members)
            await audit(tx, group, member, actor, `group-${input.action}`, {
              receiptId,
              reason: input.reason,
              status,
              priorGroupExclusionRetained: true,
            })
          return result
        }),
      )
    },
    async reserve(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor, true)
      const input = outreachCohortReserveInput.parse(raw)
      const id = `outreach-cohort_${cohortHash({ actorId: actor.id, requestKey: input.requestKey }).slice(0, 40)}`
      const requestHash = cohortHash(input)
      return withTenantIsolationBypass(() =>
        transaction(async (tx) => {
          const existing = await tx.prospectOutreachCampaign.findUnique({ where: { id } })
          if (existing) {
            if (cohortObject(existing.cohortSnapshot).requestHash !== requestHash)
              fail(
                'CONFLICT',
                'Request key already belongs to different exact selections. Original cohort preserved.',
              )
            const retained = await readGroup(tx, id, actor)
            return {
              cohortId: id,
              count: retained.members.length,
              replayed: true,
              SEND_AUTHORIZED: false,
            }
          }
          const preview = await previewIn(tx, input.preview, actor)
          if (preview.previewHash !== input.expectedPreviewHash)
            fail(
              'CONFLICT',
              'Native candidates, prior groups or contact state changed after preview. Review the new exact set.',
            )
          const selected = preview.rows.filter((r) => r.selected)
          if (!selected.length)
            fail('HELD', 'No eligible or explicitly held rows remain. Nothing was reserved.')
          const created = await tx.prospectOutreachCampaign.create({
            data: {
              id,
              name: input.name,
              status: 'DRAFT',
              playbookVersion: 'torchiko-connected-outreach/1',
              createdBy: actor.id,
              updatedBy: actor.id,
              cohortSnapshot: json({
                schema,
                requestHash,
                requestKey: input.requestKey,
                question: input.preview.question,
                createdBy: actor.id,
                createdByType: actor.type,
                actorRunId: actor.runId,
                preview,
                sender,
                purpose: 'PREPARATION_AND_REVIEW_ONLY',
                SEND_AUTHORIZED: false,
              }),
              members: {
                create: selected.map((row, index) => ({
                  id: `${id}_member_${String(index + 1).padStart(2, '0')}`,
                  organizationId: row.organizationId,
                  venueId: row.venueId,
                  contactId: row.contactId,
                  status: 'SELECTED' as const,
                  selection: json({
                    schema: 'torchiko.outreach-cohort-member/1',
                    revision: 1,
                    state: row.disposition === 'HELD' ? 'HELD' : 'RESERVED',
                    selection: row,
                    reasons: row.reasons,
                    lease: null,
                    task: null,
                    draft: null,
                    attempt: 0,
                  } satisfies CohortMemberState),
                })),
              },
            },
            include: { members: true },
          })
          for (const member of created.members)
            await audit(tx, created, member, actor, 'reserved', {
              previewHash: preview.previewHash,
            })
          return {
            cohortId: id,
            count: created.members.length,
            held: preview.heldCount,
            replayed: false,
            SEND_AUTHORIZED: false,
          }
        }),
      )
    },
    async claimWindow(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor, true)
      const input = outreachCohortWindowInput.parse(raw)
      return withTenantIsolationBypass(() =>
        transaction(async (tx) => {
          const group = await readGroup(tx, input.cohortId, actor)
          const receiptId = `outreach-window_${cohortHash({ group: group.id, actorId: actor.id, key: input.requestKey }).slice(0, 40)}`
          const windows = cohortObject(group.cohortSnapshot).windows
          const priorReceipt = Array.isArray(windows)
            ? windows.map(cohortObject).find((r) => r.id === receiptId)
            : undefined
          if (priorReceipt) {
            if (priorReceipt.inputHash !== cohortHash(input))
              fail('CONFLICT', 'Window request key already belongs to different parameters.')
            return {
              ...cohortObject(priorReceipt.result),
              replayed: true,
              currentLeaseValidity: 'RECHECK_EXACT_RETAINED_LEASES',
              SEND_AUTHORIZED: false,
            }
          }
          if (group.status !== 'DRAFT' || group.pausedAt)
            fail('HELD', 'Only an unpaused preparation cohort may be claimed.')
          const claims = [],
            held = []
          for (const member of group.members) {
            if (claims.length >= input.limit) break
            const state = readCohortMemberState(member.selection)
            if (
              state.state === 'PREPARING' &&
              state.lease &&
              Date.parse(state.lease.expiresAt) <= now().getTime()
            ) {
              state.state = 'IMPORT_RECOVERY_REQUIRED'
              state.reasons = [
                'Previous lease expired. Check the native import receipt before resuming; do not blindly regenerate.',
              ]
              await updateMember(tx, member, state)
              await audit(tx, group, member, actor, 'lease-expired', { task: state.task })
              held.push({ memberId: member.id, reason: 'IMPORT_RECOVERY_REQUIRED' })
              continue
            }
            if (state.state !== 'RESERVED') continue
            const live = await readNativeSalesSnapshot(member.venueId!, tx)
            if (
              live.suppression.blocked ||
              live.organization.id !== member.organizationId ||
              !live.contacts.some(
                (c) => c.id === member.contactId && c.normalizedEmail === state.selection.recipient,
              ) ||
              live.snapshotHash !== state.selection.nativeSnapshotHash
            ) {
              state.state = 'HELD'
              state.reasons = [
                'Native scope, source, history, contact or suppression changed after reservation. Reconcile before resuming.',
              ]
              await updateMember(tx, member, state)
              held.push({ memberId: member.id, reason: state.reasons[0] })
              continue
            }
            state.state = 'PREPARING'
            state.attempt++
            state.lease = {
              token: randomUUID(),
              actorId: actor.id,
              runId: actor.runId,
              expiresAt: new Date(now().getTime() + input.leaseSeconds * 1000).toISOString(),
            }
            await updateMember(tx, member, state)
            await audit(tx, group, member, actor, 'claimed', {
              attempt: state.attempt,
              lease: state.lease,
            })
            claims.push({
              memberId: member.id,
              venueId: member.venueId,
              organizationId: member.organizationId,
              contactId: member.contactId,
              recipient: state.selection.recipient,
              lease: state.lease,
              task: state.task,
              instructions:
                'Use native read/prepare/task -> actual model -> immutable import. Persist the exact result before import. Do not approve or send.',
            })
          }
          const counts = group.members.reduce<Record<string, number>>((result, member) => {
            const state = readCohortMemberState(member.selection).state
            result[state] = (result[state] ?? 0) + 1
            return result
          }, {})
          const result = {
            cohortId: group.id,
            claims,
            held,
            counts,
            receiptId,
            replayed: false,
            SEND_AUTHORIZED: false,
          }
          // Aggregate scope stays on the campaign; an individual venue activity
          // must never disclose another organization's recipients or lease data.
          await appendAggregateReceipt(tx, group, 'windows', {
            id: receiptId,
            inputHash: cohortHash(input),
            result,
          })
          return result
        }),
      )
    },
    async checkpoint(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor, true)
      const input = outreachCohortCheckpointInput.parse(raw)
      return withTenantIsolationBypass(() =>
        transaction(async (tx) => {
          const group = await readGroup(tx, input.cohortId, actor)
          const member = group.members.find((m) => m.id === input.memberId)
          if (!member) fail('NOT_FOUND', 'Member is not in the exact selected cohort.')
          const state = readCohortMemberState(member.selection)
          if (
            !['imported', 'release'].includes(input.action) &&
            (group.status !== 'DRAFT' || group.pausedAt)
          )
            fail(
              'HELD',
              'The preparation cohort is paused or no longer a draft. Exact committed import recovery remains available.',
            )
          if (input.action === 'resume') {
            if (cohortHash(state) !== input.expectedSelectionHash)
              fail('CONFLICT', 'Member changed before recovery.')
            if (!['HELD', 'RELEASED', 'IMPORT_RECOVERY_REQUIRED'].includes(state.state))
              fail('HELD', 'Only a held, explicitly released or expired attempt can be resumed.')
            // A prepared result may already have committed while the response was
            // lost. Recover that immutable receipt before authorizing a new draft.
            if (state.task)
              fail(
                'HELD',
                'A native task is retained. Recover its exact result/import receipt; do not reset its preparation automatically.',
              )
            const current = await candidate(
              tx,
              { venueId: member.venueId!, contactId: member.contactId },
              actor,
              group.id,
            )
            const checked = planOutreachCohort(
              {
                question: 'Recheck this exact retained preparation member.',
                candidates: [{ venueId: member.venueId!, contactId: member.contactId }],
                count: 1,
                excludePriorGroups: true,
              },
              [current],
            ).rows[0]!
            if (checked.disposition !== 'ELIGIBLE')
              fail('HELD', `Current member remains held: ${checked.reasons.join(', ')}`)
            state.selection = { ...checked, selected: true }
            state.state = 'RESERVED'
            state.reasons = []
            state.lease = null
            await updateMember(tx, member, state)
            await audit(tx, group, member, actor, 'resumed', { reason: input.reason })
            return { memberId: member.id, state: state.state, SEND_AUTHORIZED: false }
          }
          if (
            !state.lease ||
            state.lease.token !== input.leaseToken ||
            state.lease.actorId !== actor.id
          )
            fail(
              'CONFLICT',
              'Exact retained lease and actor are required; another attempt is not overwritten.',
            )
          if (
            (input.action === 'imported' &&
              state.draft?.receiptId === input.receiptId &&
              state.draft.id === input.draftId) ||
            (input.action === 'prepared' &&
              state.task?.id === input.taskId &&
              state.task.preparationId === input.preparationId)
          )
            return {
              memberId: member.id,
              state: state.state,
              task: state.task,
              draft: state.draft,
              replayed: true,
              currentContextNotRevalidated: true,
              SEND_AUTHORIZED: false,
            }
          if (input.action === 'release') {
            if (state.state === 'REVIEW_REQUIRED')
              fail('HELD', 'A completed review draft cannot be released as unfinished work.')
            if (
              ['RELEASED', 'IMPORT_RECOVERY_REQUIRED'].includes(state.state) &&
              state.reasons[0] === input.reason
            )
              return {
                memberId: member.id,
                state: state.state,
                task: state.task,
                replayed: true,
                SEND_AUTHORIZED: false,
              }
            state.state = state.task ? 'IMPORT_RECOVERY_REQUIRED' : 'RELEASED'
            state.reasons = [input.reason]
            // Preserve the original lease/task so an uncertain committed import
            // can be reconciled. Releasing never authorizes blind regeneration.
            await updateMember(tx, member, state)
            await audit(tx, group, member, actor, 'released', {
              reason: input.reason,
              task: state.task,
            })
            return {
              memberId: member.id,
              state: state.state,
              task: state.task,
              SEND_AUTHORIZED: false,
            }
          }
          if (input.action !== 'imported' && Date.parse(state.lease.expiresAt) <= now().getTime())
            fail('HELD', 'Lease expired. Recover the native import outcome before resuming.')
          if (['prepared', 'hold'].includes(input.action) && state.state !== 'PREPARING')
            fail(
              'HELD',
              'This work was released, held or completed. Reopen and explicitly resume instead of reviving an old attempt.',
            )
          if (input.action === 'hold') {
            state.state = 'HELD'
            state.reasons = [input.reason]
          }
          if (input.action === 'prepared') {
            const view = await readView(member.venueId!)
            if (
              view.writerTask?.taskId !== input.taskId ||
              view.preparation?.id !== input.preparationId ||
              view.preparation.stale ||
              view.writerHold ||
              view.writerTask.binding.recipient !== state.selection.recipient
            )
              fail(
                'CONFLICT',
                'Only the exact current native task for the reserved contact may be checkpointed.',
              )
            state.task = { id: input.taskId, preparationId: input.preparationId }
          }
          if (input.action === 'imported') {
            const receipt = await tx.prospectActivity.findUnique({ where: { id: input.receiptId } })
            const evidence = cohortObject(receipt?.evidence)
            const draft = await tx.prospectOutreachDraft.findUnique({
              where: { id: input.draftId },
            })
            if (
              !receipt ||
              receipt.organizationId !== member.organizationId ||
              receipt.venueId !== member.venueId ||
              evidence.schema !== 'torchiko.native-writer-import/1' ||
              evidence.draftId !== input.draftId ||
              evidence.taskId !== state.task?.id ||
              !draft ||
              draft.venueId !== member.venueId ||
              draft.toEmail !== state.selection.recipient ||
              !draft.preparationKey
            )
              fail(
                'CONFLICT',
                'A native immutable writer receipt for this exact reserved task, venue and recipient is required.',
              )
            const view = await readView(member.venueId!)
            if (view.draft?.id !== draft.id || view.draft.contentHash !== draft.contentHash)
              fail(
                'CONFLICT',
                'The imported revision was superseded. Reopen rather than pin an older draft as current.',
              )
            const head = await tx.prospectOutreachDraft.findFirst({
              where: { venueId: member.venueId, preparationKey: { not: null } },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { id: true, contentHash: true },
            })
            if (head?.id !== draft.id || head.contentHash !== draft.contentHash)
              fail(
                'CONFLICT',
                'The native draft head changed while checkpointing. Original receipt retained.',
              )
            state.draft = {
              id: draft.id,
              receiptId: receipt.id,
              version: draft.version,
              contentHash: draft.contentHash,
            }
            state.state = 'REVIEW_REQUIRED'
            state.reasons = []
          }
          await updateMember(tx, member, state)
          await audit(tx, group, member, actor, input.action, {
            task: state.task,
            draft: state.draft,
            reasons: state.reasons,
          })
          return {
            memberId: member.id,
            state: state.state,
            task: state.task,
            draft: state.draft,
            SEND_AUTHORIZED: false,
          }
        }),
      )
    },
    async read(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor)
      const input = outreachCohortReadInput.parse(raw)
      return withTenantIsolationBypass(async () => {
        const group = await readGroup(client as unknown as Tx, input.cohortId, actor)
        const review = await reviewIn(group)
        // Recheck membership and grant after bounded asynchronous native reads.
        const current = await readGroup(client as unknown as Tx, input.cohortId, actor)
        const version = (value: typeof group) =>
          cohortHash({
            name: value.name,
            status: value.status,
            pausedAt: value.pausedAt?.toISOString() ?? null,
            question: cohortObject(value.cohortSnapshot).question,
            members: value.members.map((m) => [m.id, m.selection]),
          })
        if (version(current) !== version(group))
          fail('CONFLICT', 'Cohort changed during review; reopen the current exact set.')
        await dependencies.revalidate?.()
        // Only the original authorized actor sees its retained lease tokens.
        // These are recovery references, not new authority, and are deliberately
        // excluded from the human review hash/document and per-venue evidence.
        const recoverableWork = actor.capabilities.includes('prospects.maintain')
          ? group.members.flatMap((member) => {
              const state = readCohortMemberState(member.selection)
              return state.lease?.actorId === actor.id &&
                ['PREPARING', 'HELD', 'RELEASED', 'IMPORT_RECOVERY_REQUIRED'].includes(state.state)
                ? [
                    {
                      memberId: member.id,
                      venueId: member.venueId,
                      lease: state.lease,
                      task: state.task,
                      recovery:
                        'Locate and retry the exact retained model result before any new preparation. A retained task cannot be silently reset.',
                    },
                  ]
                : []
            })
          : []
        return { ...review, recoverableWork }
      })
    },
    async acknowledge(raw: unknown, actor: OutreachCohortActor) {
      authorize(actor, true)
      if (actor.type !== 'HUMAN')
        fail(
          'FORBIDDEN',
          'Only the authenticated human operator can acknowledge reading the aggregate review.',
        )
      const input = outreachCohortAcknowledgeInput.parse(raw)
      return withTenantIsolationBypass(() =>
        transaction(async (tx) => {
          const group = await readGroup(tx, input.cohortId, actor)
          const id = `outreach-review_${cohortHash({ cohortId: group.id, actorId: actor.id, reviewHash: input.expectedReviewHash }).slice(0, 40)}`
          const reviews = cohortObject(group.cohortSnapshot).reviews
          const existing = Array.isArray(reviews)
            ? reviews.map(cohortObject).find((r) => r.id === id)
            : undefined
          if (existing) {
            if (existing.inputHash !== cohortHash(input))
              fail('CONFLICT', 'Exact review receipt has different parameters.')
            return {
              receiptId: id,
              replayed: true,
              reviewedCount: input.expectedCount,
              currentContextNotRevalidated: true,
              meaningApprovalCreated: false,
              sendApprovalCreated: false,
              SEND_AUTHORIZED: false,
            }
          }
          const review = await reviewIn(group)
          if (
            review.reviewHash !== input.expectedReviewHash ||
            review.count !== input.expectedCount
          )
            fail(
              'CONFLICT',
              'Exact recipients, messages, versions, source or status changed. Nothing was acknowledged.',
            )
          if (review.rows.some((r) => r.nativeRead !== 'READ'))
            fail('HELD', 'Unavailable records cannot be represented as a completed exact review.')
          for (const row of review.rows) {
            const live = await readNativeSalesSnapshot(row.venueId!, tx)
            const head = await tx.prospectOutreachDraft.findFirst({
              where: { venueId: row.venueId, preparationKey: { not: null } },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { id: true, contentHash: true },
            })
            if (
              live.snapshotHash !== row.currentSnapshotHash ||
              (head?.id ?? null) !== (row.draft?.id ?? null) ||
              (head?.contentHash ?? null) !== (row.draft?.contentHash ?? null)
            )
              fail(
                'CONFLICT',
                'A native source, recipient or draft changed during acknowledgement. Reopen the exact review.',
              )
          }
          await appendAggregateReceipt(tx, group, 'reviews', {
            id,
            inputHash: cohortHash(input),
            result: {
              schema: 'torchiko.outreach-cohort-read-ack/1',
              reviewHash: review.reviewHash,
              count: review.count,
              reviewedBy: actor.id,
              reviewedAt: now().toISOString(),
              rows: review.rows,
              SEND_AUTHORIZED: false,
            },
          })
          for (const member of group.members)
            await audit(tx, group, member, actor, 'exact-review-read', {
              receiptId: id,
              reviewHash: review.reviewHash,
              memberId: member.id,
              draft: review.rows.find((r) => r.memberId === member.id)?.draft ?? null,
              SEND_AUTHORIZED: false,
            })
          return {
            receiptId: id,
            replayed: false,
            reviewedCount: review.count,
            meaningApprovalCreated: false,
            sendApprovalCreated: false,
            SEND_AUTHORIZED: false,
          }
        }),
      )
    },
  }
}

export const outreachCohortService = createOutreachCohortService()
