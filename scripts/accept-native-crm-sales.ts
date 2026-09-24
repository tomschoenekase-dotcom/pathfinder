import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/** Runs only through the retained-container script. Never imports/runs a sender. */
async function main() {
  const root = path.resolve(__dirname, '..')
  const output = path.join(
    root,
    'artifacts/crm-sales-20260921-r001',
    `native-acceptance-${Date.now()}.json`,
  )
  await mkdir(path.dirname(output), { recursive: true })
  const checks: { label: string; passed: boolean; detail?: string }[] = []
  const check = (condition: unknown, label: string) => {
    checks.push({ label, passed: Boolean(condition) })
    assert.ok(condition, label)
  }
  const rejects = async (fn: () => Promise<unknown>, pattern: RegExp, label: string) => {
    try {
      await fn()
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      check(pattern.test(text), `${label}: ${text.slice(-220)}`)
      return
    }
    check(false, `${label}: unexpectedly succeeded`)
  }
  // Construct the existing Prisma client with non-query logging; the local API
  // environment is enabled only after that client is loaded from the guarded URL.
  const { db } = await import('../packages/db/src/client')
  Object.assign(process.env, { NODE_ENV: 'development' })
  const { withTenantIsolationBypass } =
    await import('../packages/db/src/middleware/tenant-isolation')
  const { readNativeSalesSnapshot, salesHash, salesJson } =
    await import('../packages/db/src/helpers/prospect-sales-snapshot')
  const { persistNativeSalesPreparation } =
    await import('../packages/db/src/helpers/prospect-sales-actions')
  const { admitSyntheticSalesThread } =
    await import('../packages/db/src/helpers/prospect-sales-correspondence')
  const { recordProspectSuppressionAction } =
    await import('../packages/db/src/helpers/prospect-contactability-actions')
  const { reviewProspectOutreachDraftAction } =
    await import('../packages/db/src/helpers/prospect-outreach-actions')
  const {
    assertLocalSalesEnvironment,
    getNativeSalesWorkflow,
    applyNativeSalesAction,
    invokeSalesComponents,
  } = await import('../packages/api/src/prospect-sales-workflow')
  const { adminProspectCrmSalesRouter } =
    await import('../packages/api/src/routers/admin/prospect-crm-sales')
  const actor = {
    type: 'HUMAN',
    role: 'PLATFORM_ADMIN',
    id: 'synthetic:crm-sales:acceptance-operator',
  } as const
  const catalog = JSON.parse(
    (
      await readFile(
        path.join(root, 'artifacts/crm-sales-20260921-r001/component-catalog.json'),
        'utf8',
      )
    ).replace(/^\uFEFF/u, ''),
  ) as {
    records: { pilotId: string; workbookHash: string; sheet: string; row: number }[]
  }
  const examples: Record<string, { organizationId: string; venueId: string; name: string }> = {}
  let passed = false
  let counts: unknown = null
  let failure: string | null = null
  try {
    assertLocalSalesEnvironment()
    await withTenantIsolationBypass(async () => {
      for (const record of catalog.records) {
        const source = await db.prospectImportSourceRecord.findFirst({
          where: {
            recordKind: 'PROSPECT',
            sourceWorkbookHash: record.workbookHash,
            AND: [
              { rawPayload: { path: ['_source', 'sheetName'], equals: record.sheet } },
              { rawPayload: { path: ['_source', 'originalRowNumber'], equals: record.row } },
            ],
          },
        })
        assert.ok(source?.canonicalVenueId && source.canonicalOrganizationId)
        const native = await readNativeSalesSnapshot(source.canonicalVenueId)
        const view = await getNativeSalesWorkflow(source.canonicalVenueId)
        examples[record.pilotId] = {
          organizationId: source.canonicalOrganizationId,
          venueId: source.canonicalVenueId,
          name: native.venue.name,
        }
        check(
          view.sourceState === 'EXACT_NATIVE_SOURCE_CROSSWALK',
          `${record.pilotId}: native source crosswalk`,
        )
        check(
          view.contacts.every(
            (contact) => contact.readiness === 'UNKNOWN' && contact.permission === 'UNKNOWN',
          ),
          `${record.pilotId}: imported contact candidates remain UNKNOWN`,
        )
        check(
          view.SEND_AUTHORIZED === false && view.senderAvailable === false,
          `${record.pilotId}: no sender or authorization`,
        )
      }
      if (process.argv.includes('--smoke')) {
        passed = true
        return
      }
      const target = examples.P03!
      for (const authority of [
        { userId: null, isPlatformAdmin: false },
        { userId: 'tenant-only-test', isPlatformAdmin: false },
      ]) {
        const caller = adminProspectCrmSalesRouter.createCaller({
          db,
          headers: new Headers(),
          session: { ...authority, activeTenantId: null, role: null },
        })
        await rejects(
          () => caller.getProspectSalesWorkflow({ venueId: target.venueId }),
          /UNAUTHORIZED|FORBIDDEN|Authentication|admin|authorized|logged|Insufficient role/i,
          'Native admin authority denied',
        )
      }
      let view = await getNativeSalesWorkflow(target.venueId)
      const contactBefore = salesHash(
        salesJson(
          await db.prospectContact.findMany({
            where: { organizationId: target.organizationId },
            orderBy: { id: 'asc' },
          }),
        ),
      )
      check(view.gate.decision === 'ENOUGH_EVIDENCE', 'Enough-evidence path')
      view = await applyNativeSalesAction(
        {
          action: 'prepare',
          input: { venueId: target.venueId, expectedSnapshotHash: view.snapshotHash },
        },
        actor,
      )
      check(
        view.preparation &&
          !view.preparation.stale &&
          view.preparation.approvedCount === 0 &&
          view.preparation.selectedCount === 0,
        'Native preparation with zero approved language',
      )
      check(view.preparation!.wltIdentity !== 'null', 'Actual WLT packet bound')
      const native = await readNativeSalesSnapshot(target.venueId)
      const component = await invokeSalesComponents({ action: 'prepare', native })
      const id1 = await persistNativeSalesPreparation({
        venueId: target.venueId,
        expectedSnapshotHash: native.snapshotHash,
        component,
        actor,
      })
      const id2 = await persistNativeSalesPreparation({
        venueId: target.venueId,
        expectedSnapshotHash: native.snapshotHash,
        component,
        actor,
      })
      check(id1.id === id2.id, 'Exact preparation replay is idempotent')
      view = await getNativeSalesWorkflow(target.venueId)
      const subject = 'An idea for a small visitor guide'
      const body =
        'Hi,\n\nWould it be useful to explore a small question-based guide for one room or a few objects at the History Center? It could use material you choose and stay focused on that part of a visit.\n\nI would be interested in hearing what might be helpful, rather than assuming a particular format is right. Would a brief conversation about that idea make sense?\n\nThanks,\nTom'
      const save = (current: typeof view, text: string, title = subject) =>
        applyNativeSalesAction(
          {
            action: 'save',
            input: {
              venueId: target.venueId,
              preparationId: current.preparation!.id,
              expectedSnapshotHash: current.snapshotHash,
              expectedDraftId: current.preparation!.expectedDraftId,
              subject: title,
              body: text,
            },
          },
          actor,
        )
      view = await save(view, body)
      const first = view.draft!
      check(first && first.state === 'DRAFT_REVIEW', 'Native no-send draft readback')
      const identity = first.id
      view = await save(view, body)
      check(view.draft!.id === identity, 'Exact same draft is idempotent')
      view = await applyNativeSalesAction(
        {
          action: 'review',
          input: {
            venueId: target.venueId,
            draftId: first.id,
            contentHash: first.contentHash,
            expectedSnapshotHash: view.snapshotHash,
          },
        },
        actor,
      )
      check(view.draft!.state === 'REVIEWED_NO_SEND', 'Exact native review state')
      const frozenBefore = salesHash(
        salesJson(await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: first.id } })),
      )
      view = await save(view, body.replace('a brief conversation', 'a short conversation'))
      check(
        view.draft!.id !== first.id &&
          view.draft!.version === first.version + 1 &&
          view.draft!.previousDraftId === first.id,
        'Changed body appends a revision',
      )
      const second = view.draft!
      view = await save(view, second.body, 'A small guide idea for discussion')
      check(
        view.draft!.version === second.version + 1 && view.draft!.previousDraftId === second.id,
        'Changed subject appends a revision',
      )
      check(
        frozenBefore ===
          salesHash(
            salesJson(
              await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: first.id } }),
            ),
          ),
        'Reviewed content and source bindings remain byte-identical',
      )
      await rejects(
        () =>
          applyNativeSalesAction(
            {
              action: 'review',
              input: {
                venueId: target.venueId,
                draftId: first.id,
                contentHash: first.contentHash,
                expectedSnapshotHash: view.snapshotHash,
              },
            },
            actor,
          ),
        /STALE_REVIEW/,
        'Older revision cannot be reviewed as current',
      )
      await rejects(
        () =>
          db.prospectOutreachDraft.update({
            where: { id: first.id },
            data: { textBody: 'changed reviewed body' },
          }),
        /NO_SEND_REVISION_IMMUTABLE/,
        'Database prevents immutable draft overwrite',
      )
      await rejects(
        () =>
          db.prospectOutreachDraft.update({
            where: { id: first.id },
            data: { status: 'APPROVED', approvedBy: 'not-authorized', approvedAt: new Date() },
          }),
        /NO_SEND_REVISION_IMMUTABLE/,
        'Database prevents approval status promotion',
      )
      await rejects(
        () => reviewProspectOutreachDraftAction({ draftId: first.id, approve: true, actor }),
        /NO-SEND preparation/,
        'Existing campaign approval owner refuses the draft',
      )
      await rejects(
        () =>
          db.$executeRaw`INSERT INTO prospect_send_items (id, draft_id) VALUES ('SYN-forbidden-frozen-recipient', ${first.id})`,
        /NO_SEND_NOT_A_RECIPIENT/,
        'Database refuses frozen-recipient creation before constraints or queueing',
      )
      await rejects(
        () => save(view, 'From: someone\nTo: venue\nAn email-chain transcript'),
        /THREAD_OR_TRANSCRIPT_DUMP/,
        'No transcript dump can be saved',
      )
      await rejects(
        () => applyNativeSalesAction({ action: 'send', input: {} } as never, actor),
        /Invalid|discriminator|option/i,
        'No sender action exists',
      )
      await rejects(
        () =>
          applyNativeSalesAction(
            {
              action: 'prepare',
              input: { venueId: target.venueId, expectedSnapshotHash: view.snapshotHash },
            },
            { ...actor, type: 'AGENT' } as never,
          ),
        /operator/,
        'Agent cannot claim native human review authority',
      )
      check(
        contactBefore ===
          salesHash(
            salesJson(
              await db.prospectContact.findMany({
                where: { organizationId: target.organizationId },
                orderBy: { id: 'asc' },
              }),
            ),
          ),
        'All contact fields unchanged through preparation/revisions/review',
      )

      const form = examples.P06!
      let formView = await getNativeSalesWorkflow(form.venueId)
      formView = await applyNativeSalesAction(
        {
          action: 'prepare',
          input: { venueId: form.venueId, expectedSnapshotHash: formView.snapshotHash },
        },
        actor,
      )
      check(formView.routing?.kind === 'contact_form', 'Native form routing is preserved')
      formView = await applyNativeSalesAction(
        {
          action: 'save',
          input: {
            venueId: form.venueId,
            preparationId: formView.preparation!.id,
            expectedSnapshotHash: formView.snapshotHash,
            expectedDraftId: formView.preparation!.expectedDraftId,
            subject: 'A visitor-guide idea to discuss',
            body: 'Hello,\n\nWould it be useful to explore a small visitor guide using a few stories or objects you choose? The idea would be to keep it focused and learn what might fit your setting, rather than assume a particular format.\n\nWould you be open to discussing what a useful starting point could look like?\n\nThanks,\nTom',
          },
        },
        actor,
      )
      const formDraft = await db.prospectOutreachDraft.findUniqueOrThrow({
        where: { id: formView.draft!.id },
      })
      check(
        formDraft.toEmail === null &&
          formDraft.contactId === null &&
          formDraft.campaignId === null &&
          formDraft.memberId === null,
        'Form revision has no fake recipient or campaign',
      )

      const reply = examples.P02!
      let replyView = await getNativeSalesWorkflow(reply.venueId)
      const payload = {
        venueId: reply.venueId,
        expectedSnapshotHash: replyView.snapshotHash,
        synthetic: true as const,
        SEND_AUTHORIZED: false as const,
        threadId: 'SYN-crm-sales-20260921-thread',
        providerThreadId: 'SYN-crm-sales-20260921-provider-thread',
        accountId: 'SYN-crm-sales-20260921-account',
        accountExternalId: 'SYN-crm-sales-20260921-external',
        ownerAddress: 'crm-owner@example.invalid',
        recipientAddress: replyView.routing!.value!,
        contactId: replyView.routing!.nativeContactId,
        subject: 'A small visitor guide',
        actorId: 'synthetic:crm-sales:acceptance',
        messages: [
          {
            id: 'SYN-crm-sales-20260921-out',
            providerMessageId: 'SYN-crm-sales-20260921-provider-out',
            direction: 'OUTBOUND' as const,
            body: 'Would a small visitor-guide discussion be useful?',
            occurredAt: '2026-09-21T03:00:00.000Z',
            references: [] as string[],
          },
        ],
      }
      if (!replyView.correspondence) {
        await admitSyntheticSalesThread(payload)
        replyView = await getNativeSalesWorkflow(reply.venueId)
        check(
          replyView.correspondenceState === 'AWAITING_RESPONSE',
          'Synthetic historical outbound projects awaiting response',
        )
      }
      const full = {
        ...payload,
        expectedSnapshotHash: replyView.snapshotHash,
        messages: [
          ...payload.messages,
          {
            id: 'SYN-crm-sales-20260921-in',
            providerMessageId: 'SYN-crm-sales-20260921-provider-in',
            direction: 'INBOUND' as const,
            body: 'Could we start with just one room?',
            occurredAt: '2026-09-21T04:00:00.000Z',
            references: [payload.messages[0]!.id],
          },
        ],
      }
      const beforeThread = replyView.snapshotHash
      await admitSyntheticSalesThread(full)
      replyView = await getNativeSalesWorkflow(reply.venueId)
      check(
        replyView.correspondence?.latestInbound?.id === 'SYN-crm-sales-20260921-in' &&
          replyView.correspondence.synthetic,
        'Native snapshot → actual reducer → latest synthetic inbound',
      )
      check(
        replyView.correspondence?.relationship === 'asked_question',
        'Actual correspondence state is asked_question',
      )
      if (replyView.snapshotHash !== beforeThread)
        await rejects(
          () =>
            applyNativeSalesAction(
              {
                action: 'prepare',
                input: {
                  venueId: reply.venueId,
                  expectedSnapshotHash: beforeThread,
                  answerText: 'We could discuss one room.',
                },
              },
              actor,
            ),
          /STALE_NATIVE_SNAPSHOT/,
          'New inbound invalidates prior thread preparation',
        )
      const rereadBefore = salesHash(
        salesJson(
          await db.prospectEmailThread.findUnique({
            where: { id: full.threadId },
            include: { messages: true, providerMappings: true },
          }),
        ),
      )
      const replay = await admitSyntheticSalesThread({
        ...full,
        expectedSnapshotHash: replyView.snapshotHash,
      })
      check(replay.replayed && replay.createdMessages === 0, 'Provider re-read is idempotent')
      check(
        rereadBefore ===
          salesHash(
            salesJson(
              await db.prospectEmailThread.findUnique({
                where: { id: full.threadId },
                include: { messages: true, providerMappings: true },
              }),
            ),
          ),
        'Re-read preserves message and thread timestamps',
      )
      await rejects(
        () =>
          admitSyntheticSalesThread({
            ...full,
            expectedSnapshotHash: replyView.snapshotHash,
            messages: full.messages.map((message) =>
              message.direction === 'INBOUND'
                ? { ...message, body: 'Changed bytes under an existing provider identity' }
                : message,
            ),
          }),
        /PROVIDER_MESSAGE_IDENTITY_CONFLICT/,
        'Provider/message identity conflict rejected',
      )
      await rejects(
        () =>
          admitSyntheticSalesThread({ ...payload, expectedSnapshotHash: replyView.snapshotHash }),
        /STALE_THREAD_SNAPSHOT/,
        'Truncated stale thread cannot remove inbound',
      )
      await rejects(
        () =>
          admitSyntheticSalesThread({
            ...full,
            expectedSnapshotHash: replyView.snapshotHash,
            providerThreadId: 'SYN-other-provider-thread',
          }),
        /THREAD_IDENTITY_CONFLICT/,
        'Provider thread identity conflict rejected',
      )
      await rejects(
        () =>
          applyNativeSalesAction(
            {
              action: 'prepare',
              input: { venueId: reply.venueId, expectedSnapshotHash: replyView.snapshotHash },
            },
            actor,
          ),
        /HUMAN_RESPONSE_DIRECTION_REQUIRED/,
        'Reply preparation asks for the missing human answer instead of researching',
      )
      replyView = await applyNativeSalesAction(
        {
          action: 'prepare',
          input: {
            venueId: reply.venueId,
            expectedSnapshotHash: replyView.snapshotHash,
            answerText:
              'We could discuss starting with just one room, using the material the venue chooses. Ask which room might be a useful place to explore first; do not promise delivery, pricing or a launch date.',
          },
        },
        actor,
      )
      const replyBody =
        'Hi,\n\nWe could discuss starting with one room and keeping the scope focused on the material you would choose for it. That might be a useful way to work through the idea before considering anything larger.\n\nWhich room do you think would be worth exploring first, and what would you most like a visitor to understand there?\n\nThanks,\nTom'
      replyView = await applyNativeSalesAction(
        {
          action: 'save',
          input: {
            venueId: reply.venueId,
            preparationId: replyView.preparation!.id,
            expectedSnapshotHash: replyView.snapshotHash,
            expectedDraftId: replyView.preparation!.expectedDraftId,
            subject: 'Re: A small visitor guide',
            body: replyBody,
          },
        },
        actor,
      )
      check(
        replyView.correspondenceState === 'RESPONSE_REVIEW_NEEDED' &&
          replyView.draft?.body === replyBody,
        'Composer reply preparation → native proposed-response revision → review readback',
      )
      const response = replyView.draft!
      replyView = await applyNativeSalesAction(
        {
          action: 'save',
          input: {
            venueId: reply.venueId,
            preparationId: replyView.preparation!.id,
            expectedSnapshotHash: replyView.snapshotHash,
            expectedDraftId: replyView.preparation!.expectedDraftId,
            subject: response.subject,
            body: replyBody.replace('keeping the scope focused', 'keeping the discussion focused'),
          },
        },
        actor,
      )
      check(
        replyView.draft!.previousDraftId === response.id &&
          replyView.draft!.version === response.version + 1,
        'Response revisions are immutable and linked',
      )
      check(
        (await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: response.id } }))
          .textBody === replyBody,
        'Earlier response body remains unchanged',
      )
      check(
        (await db.prospectInboundReplyReview.count({
          where: { organizationId: reply.organizationId },
        })) === 0,
        'Reducer projection does not fabricate human inbound classification review',
      )

      const heldId = salesHash('synthetic:crm-sales:held-prospect-20260921').slice(0, 24)
      const heldOrgId = `porg_${heldId}`,
        heldVenueId = `pvenue_${heldId}`,
        heldContactId = `SYN-contact-${heldId}`
      if (!(await db.prospectOrganization.findUnique({ where: { id: heldOrgId } }))) {
        await db.$transaction(async (tx) => {
          await tx.prospectOrganization.create({
            data: {
              id: heldOrgId,
              canonicalName: 'SYNTHETIC CRM Sales Hold',
              normalizedName: 'synthetic crm sales hold',
              source: 'SYNTHETIC_LOCAL_ACCEPTANCE_ONLY',
              notes: 'Not a real prospect. No external website or mailbox.',
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          })
          await tx.prospectVenue.create({
            data: {
              id: heldVenueId,
              organizationId: heldOrgId,
              name: 'SYNTHETIC CRM Sales Hold',
              normalizedName: 'synthetic crm sales hold',
              city: 'Synthetic',
              region: 'Test',
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          })
          await tx.prospectContact.create({
            data: {
              id: heldContactId,
              organizationId: heldOrgId,
              venueId: heldVenueId,
              email: 'held@example.invalid',
              normalizedEmail: 'held@example.invalid',
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          })
        })
      }
      const heldContact = await db.prospectContact.findUniqueOrThrow({
        where: { id: heldContactId },
      })
      if (!heldContact.doNotContact)
        await recordProspectSuppressionAction({
          contactId: heldContactId,
          eventType: 'SUPPRESSED',
          source: 'SYSTEM',
          reasonCode: 'SYNTHETIC_ACCEPTANCE_HOLD',
          reason: 'Synthetic native suppression fixture — not a real contact decision',
          provider: 'FAKE',
          evidence: { synthetic: true, SEND_AUTHORIZED: false },
          actor: { type: 'SYSTEM', role: 'SYSTEM', id: actor.id },
        })
      const held = await getNativeSalesWorkflow(heldVenueId)
      check(
        held.suppression.blocked && held.gate.decision === 'HUMAN_INPUT_REQUIRED',
        'Native suppression projects human input and held state',
      )
      await rejects(
        () =>
          applyNativeSalesAction(
            {
              action: 'prepare',
              input: { venueId: heldVenueId, expectedSnapshotHash: held.snapshotHash },
            },
            actor,
          ),
        /suppression/i,
        'Native suppression blocks preparation before Composer',
      )
      examples.HOLD = {
        organizationId: heldOrgId,
        venueId: heldVenueId,
        name: 'SYNTHETIC CRM Sales Hold',
      }
      const generic = await db.prospectVenue.findFirstOrThrow({
        where: { id: { notIn: Object.values(examples).map((example) => example.venueId) } },
        orderBy: { id: 'asc' },
      })
      const research = await getNativeSalesWorkflow(generic.id)
      check(
        research.gate.decision === 'RESEARCH_REQUIRED' &&
          research.gate.questions.length > 0 &&
          research.gate.questions.length <= 4,
        'Unknown native source produces exact bounded research questions',
      )
      examples.RESEARCH = {
        organizationId: generic.organizationId,
        venueId: generic.id,
        name: generic.name,
      }
      const zeroCounts = {
        campaigns: await db.prospectOutreachCampaign.count(),
        batches: await db.prospectSendBatch.count(),
        frozenRecipients: await db.prospectSendItem.count(),
        outbox: await db.prospectSendOutbox.count(),
        followups: await db.prospectFollowup.count(),
        enabledProviderAccounts: await db.correspondenceProviderAccount.count({
          where: { deliveryEnabled: true },
        }),
        realMessages: await db.prospectEmailMessage.count({
          where: { NOT: { sourceReference: { startsWith: 'synthetic:crm-sales:' } } },
        }),
        approvedDrafts: await db.prospectOutreachDraft.count({
          where: {
            preparationKey: { not: null },
            OR: [
              { approvedAt: { not: null } },
              { approvedBy: { not: null } },
              { status: { not: 'NEEDS_REVIEW' } },
            ],
          },
        }),
      }
      check(
        Object.values(zeroCounts).every((value) => value === 0),
        'No campaign, frozen recipient, batch, outbox, followup, enabled provider, real message or approved draft',
      )
      counts = {
        ...zeroCounts,
        syntheticMessages: await db.prospectEmailMessage.count({
          where: { sourceReference: { startsWith: 'synthetic:crm-sales:' } },
        }),
        preparations: await db.prospectSourceEvidence.count({
          where: { sourceType: 'CRM_SALES_PREPARATION_V1' },
        }),
        noSendDraftRevisions: await db.prospectOutreachDraft.count({
          where: { preparationKey: { not: null } },
        }),
      }
      check(
        (counts as { syntheticMessages: number }).syntheticMessages === 2,
        'Exactly two synthetic historical messages; no real correspondence imported',
      )
      passed = true
    })
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(failure)
  } finally {
    await writeFile(
      output,
      JSON.stringify(
        {
          schema: 'torchiko.native-no-send-acceptance/1',
          passed,
          checkedAt: new Date().toISOString(),
          mode: process.argv.includes('--smoke') ? 'READ_ONLY_SMOKE' : 'FULL_LOCAL_NO_SEND',
          database: 'pathfinder_disposable_crm_research_20260919',
          container: 'torchiko-crm-research-db-20260919',
          actor: { ...actor, attribution: 'Synthetic test operator, not Tom approval' },
          checks,
          examples,
          counts,
          failure,
          SEND_AUTHORIZED: false,
          realMessagesSent: 0,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    )
    console.log(
      JSON.stringify({ output, passed, checks: checks.length, examples, counts }, null, 2),
    )
    await db.$disconnect()
  }
  if (!passed) process.exitCode = 1
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
