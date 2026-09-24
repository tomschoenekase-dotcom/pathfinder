import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { meaningAction, meaningAnnotations, meaningTextFixture } from './crm-sales/meaning-fixtures'
import type {
  NativeSalesAction,
  SalesWorkflowView,
} from '../packages/api/src/prospect-sales-contract'

/** Retained local native acceptance. No schema changes, importer, sender or provider connection. */
async function main() {
  const root = path.resolve(__dirname, '..'),
    artifactRoot = path.join(root, 'artifacts/crm-meaning-review-20260921-r001')
  const outputArg = process.argv.indexOf('--output')
  const output =
    outputArg >= 0
      ? path.resolve(process.cwd(), process.argv[outputArg + 1]!)
      : path.join(artifactRoot, `native-${Date.now()}.json`)
  assert.ok(
    output.startsWith(artifactRoot + path.sep),
    'Only a new receipt inside this lane is allowed',
  )
  await mkdir(artifactRoot, { recursive: true })
  const receipt: Record<string, unknown> = {
    schema: 'torchiko.native-meaning-acceptance/1',
    startedAt: new Date().toISOString(),
    mode: process.argv.includes('--advance-synthetic-dialogue')
      ? 'ADVANCE_EXPLICIT_SYNTHETIC_DIALOGUE_NOT_DELIVERY'
      : process.argv.includes('--append-inbound')
        ? 'APPEND_SYNTHETIC_INBOUND'
        : 'FULL_LOCAL_NO_SEND',
    container: 'torchiko-crm-research-db-20260919',
    database: 'pathfinder_disposable_crm_research_20260919',
    SEND_AUTHORIZED: false,
    noProviderContacted: true,
  }
  const checks: { label: string; passed: boolean }[] = []
  const snapshots: unknown[] = []
  const check = (condition: unknown, label: string) => {
    checks.push({ label, passed: Boolean(condition) })
    console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`)
    assert.ok(condition, label)
  }
  const rejects = async (action: () => Promise<unknown>, expected: RegExp, label: string) => {
    try {
      await action()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      check(expected.test(message), `${label}: ${message.slice(-240)}`)
      return
    }
    check(false, `${label}: unexpectedly accepted`)
  }
  const { db } = await import('../packages/db/src/client')
  Object.assign(process.env, { NODE_ENV: 'development' })
  const { withTenantIsolationBypass } =
    await import('../packages/db/src/middleware/tenant-isolation')
  const { readNativeSalesSnapshot, decodeSalesComponent, salesHash, salesJson } =
    await import('../packages/db/src/helpers/prospect-sales-snapshot')
  const { nativeMeaningBinding, recordNativeMeaningReview } =
    await import('../packages/db/src/helpers/prospect-sales-meaning')
  const { admitSyntheticSalesThread } =
    await import('../packages/db/src/helpers/prospect-sales-correspondence')
  const {
    getNativeSalesWorkflow,
    applyNativeSalesAction,
    assertLocalSalesEnvironment,
    invokeSalesComponents,
  } = await import('../packages/api/src/prospect-sales-workflow')
  const actor = {
    type: 'SYSTEM',
    role: 'PLATFORM_ADMIN',
    id: 'synthetic:crm-meaning:acceptance',
  } as const
  receipt.actor = {
    ...actor,
    attribution: 'Explicitly synthetic acceptance; not an authenticated human action',
  }
  const catalog = JSON.parse(
    (
      await readFile(
        path.join(root, 'artifacts/crm-sales-20260921-r001/component-catalog.json'),
        'utf8',
      )
    ).replace(/^\uFEFF/u, ''),
  )
  const examples: Record<string, { venueId: string; organizationId: string; name: string }> = {}
  const answerText =
    'We could discuss starting with just one room, using the material the venue chooses. Ask which room might be a useful place to explore first; do not promise delivery, pricing or a launch date.'
  receipt.answerText = answerText
  const act = (action: NativeSalesAction) => applyNativeSalesAction(action, actor)
  const recordSnapshot = (label: string, view: SalesWorkflowView) =>
    snapshots.push({
      label,
      venueId: view.venueId,
      snapshotHash: view.snapshotHash,
      draft: view.draft,
      claimReview: view.claimReview,
      routing: view.routing,
      preparation: view.preparation,
      correspondence: view.correspondence,
      SEND_AUTHORIZED: view.SEND_AUTHORIZED,
    })
  const prepare = (view: SalesWorkflowView, answer?: string) =>
    act({
      action: 'prepare',
      input: {
        venueId: view.venueId,
        expectedSnapshotHash: view.snapshotHash,
        ...(answer ? { answerText: answer } : {}),
      },
    })
  const save = (view: SalesWorkflowView, text: { subject: string; body: string }) =>
    act({
      action: 'save',
      input: {
        venueId: view.venueId,
        preparationId: view.preparation!.id,
        expectedSnapshotHash: view.snapshotHash,
        expectedDraftId: view.preparation!.expectedDraftId,
        ...text,
      },
    })
  const readReview = (view: SalesWorkflowView) =>
    act({
      action: 'review',
      input: {
        venueId: view.venueId,
        draftId: view.draft!.id,
        contentHash: view.draft!.contentHash,
        expectedSnapshotHash: view.snapshotHash,
      },
    })

  async function appendInbound(dialogue = false) {
    const target = examples.P02!,
      before = await getNativeSalesWorkflow(target.venueId)
    const native = await readNativeSalesSnapshot(target.venueId)
    const thread = native.threads.find((entry) => entry.id === 'SYN-crm-sales-20260921-thread')!
    assert.ok(thread, 'Only the already-retained synthetic thread may receive acceptance evidence')
    const mapping = thread.providerMappings[0]!,
      account = mapping.providerAccount
    assert.equal(account.provider, 'FAKE')
    assert.equal(account.deliveryEnabled, false)
    const stamp = String(Date.now())
    const id = `SYN-crm-meaning-in-${stamp}`
    const outboundId = `SYN-crm-meaning-fixture-out-${stamp}`
    const latest = thread.messages.at(-1)!
    const answeredIds = new Set(
      thread.messages
        .filter((message) => message.direction === 'OUTBOUND')
        .flatMap((message) => message.references),
    )
    const unansweredIds = thread.messages
      .filter((message) => message.direction === 'INBOUND' && !answeredIds.has(message.id))
      .map((message) => message.id)
    assert.ok(
      !dialogue || unansweredIds.length <= 10,
      'Retain the existing bounded explicit-reference contract',
    )
    const fixture = {
      venueId: target.venueId,
      expectedSnapshotHash: native.snapshotHash,
      synthetic: true as const,
      SEND_AUTHORIZED: false as const,
      threadId: thread.id,
      providerThreadId: mapping.providerThreadId,
      accountId: account.id,
      accountExternalId: account.externalAccountId,
      ownerAddress: account.mailboxAddress!,
      recipientAddress: before.routing!.value!,
      contactId: thread.contactId,
      subject: thread.subject,
      messages: [
        ...thread.messages.map((message) => ({
          id: message.id,
          providerMessageId: message.providerMessageId!,
          direction: message.direction,
          body: message.textBody!,
          occurredAt: message.occurredAt!,
          references: message.references,
        })),
        ...(dialogue
          ? [
              {
                id: outboundId,
                providerMessageId: outboundId + '-provider',
                direction: 'OUTBOUND' as const,
                body: 'This is a synthetic fixture response for local testing, not a real message or action by Tom. We could discuss a limited guide using material chosen for one room.',
                occurredAt: new Date(Date.now() - 2000).toISOString(),
                references: unansweredIds,
              },
            ]
          : []),
        {
          id,
          providerMessageId: id + '-provider',
          direction: 'INBOUND' as const,
          body: dialogue
            ? 'Could we start with just one room?'
            : latest.textBody?.includes('rock collection')
              ? 'Could we start with one room but use the fossil collection instead?'
              : 'Could we use one room and focus on the rock collection?',
          occurredAt: new Date(Date.now() - 1000).toISOString(),
          references: [dialogue ? outboundId : latest.id],
        },
      ],
      actorId: 'synthetic:crm-sales:meaning-acceptance',
    }
    const reviewId = before.claimReview?.current?.id
    const reviewBefore = reviewId
      ? salesHash(
          salesJson(await db.prospectActivity.findUniqueOrThrow({ where: { id: reviewId } })),
        )
      : null
    const originalMessages = await db.prospectEmailMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { id: 'asc' },
    })
    const result = await admitSyntheticSalesThread(fixture)
    const after = await getNativeSalesWorkflow(target.venueId)
    check(
      result.createdMessages === (dialogue ? 2 : 1) && result.SEND_AUTHORIZED === false,
      dialogue
        ? 'Explicit synthetic outbound/inbound fixture turn appended; no real send or human action occurred'
        : 'One explicitly synthetic inbound appended without a provider or sender',
    )
    check(
      after.snapshotHash !== before.snapshotHash,
      'Changed inbound evidence changes the exact native snapshot',
    )
    check(
      after.draft?.state === 'STALE' && after.claimReview?.status === 'STALE',
      'Old draft and meaning assessment become stale after changed inbound',
    )
    check(
      !after.claimReview?.history.some((entry) => entry.applicable),
      'No prior meaning receipt remains applicable after changed inbound',
    )
    check(
      salesHash(salesJson(originalMessages)) ===
        salesHash(
          salesJson(
            await db.prospectEmailMessage.findMany({
              where: { id: { in: originalMessages.map((message) => message.id) } },
              orderBy: { id: 'asc' },
            }),
          ),
        ),
      'Previously retained synthetic inbound/outbound rows remain byte-identical',
    )
    if (reviewId)
      check(
        reviewBefore ===
          salesHash(
            salesJson(await db.prospectActivity.findUniqueOrThrow({ where: { id: reviewId } })),
          ),
        'Prior source-bound assessment receipt remains unchanged after inbound append',
      )
    if (before.claimReview?.bindingHash && !before.claimReview.stale)
      await rejects(
        () => act(meaningAction(before)),
        /STALE_NATIVE_SNAPSHOT/,
        'Old inbound-bound review action rejected',
      )
    const replay = await admitSyntheticSalesThread({
      ...fixture,
      expectedSnapshotHash: after.snapshotHash,
    })
    check(
      replay.createdMessages === 0 && replay.replayed,
      'Exact synthetic inbound replay is idempotent',
    )
    recordSnapshot('Before synthetic inbound append', before)
    recordSnapshot('After synthetic inbound append', after)
    receipt.appendedInboundId = id
    if (dialogue) {
      receipt.syntheticFixtureOutboundId = outboundId
      receipt.syntheticOutboundIsNotDelivery = true
      check(
        after.gate.canPrepare && !after.blocker,
        'Original unchanged correspondence reducer admits the new ordinary synthetic reply point',
      )
    }
  }

  try {
    assertLocalSalesEnvironment()
    await withTenantIsolationBypass(async () => {
      for (const entry of catalog.records.filter((record: { pilotId: string }) =>
        ['P03', 'P02', 'P06'].includes(record.pilotId),
      )) {
        const source = await db.prospectImportSourceRecord.findFirst({
          where: {
            recordKind: 'PROSPECT',
            sourceWorkbookHash: entry.workbookHash,
            AND: [
              { rawPayload: { path: ['_source', 'sheetName'], equals: entry.sheet } },
              { rawPayload: { path: ['_source', 'originalRowNumber'], equals: entry.row } },
            ],
          },
        })
        assert.ok(source?.canonicalVenueId && source.canonicalOrganizationId)
        const view = await getNativeSalesWorkflow(source.canonicalVenueId)
        check(
          view.sourceState === 'EXACT_NATIVE_SOURCE_CROSSWALK',
          `${entry.pilotId}: current native/source crosswalk`,
        )
        examples[entry.pilotId] = {
          venueId: source.canonicalVenueId,
          organizationId: source.canonicalOrganizationId,
          name: view.name,
        }
      }
      if (
        process.argv.includes('--append-inbound') ||
        process.argv.includes('--advance-synthetic-dialogue')
      ) {
        await appendInbound(process.argv.includes('--advance-synthetic-dialogue'))
        return
      }
      const target = examples.P03!
      let view = await prepare(await getNativeSalesWorkflow(target.venueId))
      const beforeSnapshot = view.snapshotHash
      const beforeContacts = salesHash(
        salesJson(
          await db.prospectContact.findMany({
            where: { organizationId: target.organizationId },
            orderBy: { id: 'asc' },
          }),
        ),
      )
      check(
        view.preparation?.approvedCount === 0 && view.preparation.selectedCount === 0,
        'Actual Approved Language catalog has zero approved/selected entries',
      )
      view = await save(view, meaningTextFixture(view.name, 'unsupported'))
      check(
        Boolean(view.claimReview?.bindingHash) && view.claimReview?.status === 'REQUIRED',
        'Native exact revision exposes its current source-bound meaning identity',
      )
      const unsupportedAction = meaningAction(view)
      view = await act(unsupportedAction)
      recordSnapshot('Unsupported exhibit-price-visit claims', view)
      check(
        view.claimReview?.status === 'BLOCKED',
        'Actual Composer rejects unsupported exhibit, price and completed-visit assertions',
      )
      const codes = view.claimReview!.current!.findings.map((entry) => entry.code)
      check(
        [
          'UNSUPPORTED_PERSONALIZATION_DETAIL',
          'UNSUPPORTED_NUMERIC_CLAIM',
          'INVENTED_PRICING',
          'UNVERIFIED_VISIT',
        ].every((code) => codes.includes(code)),
        'All required unsupported-claim cases have retained findings',
      )
      const blockedReview = view.claimReview!.current!,
        blockedDraft = view.draft!
      view = await readReview(view)
      check(
        view.draft!.state === 'REVIEWED_NO_SEND' && view.claimReview!.status === 'BLOCKED',
        'Read-review never clears unresolved claim/meaning holds',
      )
      check(
        view.claimReview!.current!.recordedBy.type === 'SYSTEM' &&
          view.claimReview!.current!.recordedBy.synthetic,
        'Native recorder is explicitly SYSTEM synthetic, not a fabricated human',
      )
      const sourceName = view.claimReview!.sources.find(
        (claim) => claim.claim_id === 'F-VENUE',
      )!.text
      const goodText = meaningTextFixture(sourceName)
      receipt.goodText = goodText
      view = await save(view, goodText)
      check(
        view.draft!.id !== blockedDraft.id &&
          view.claimReview!.status === 'REQUIRED' &&
          !view.claimReview!.history.some((entry) => entry.applicable),
        'Changed reviewed text creates a new revision with no inherited meaning review',
      )
      check(
        view.claimReview!.history.some((entry) => entry.id === blockedReview.id),
        'Earlier failed meaning receipt remains visible history',
      )
      const beforeGoodMeaning = view
      const goodAction = meaningAction(view)
      view = await act(goodAction)
      recordSnapshot('Supported fact and explicit hypotheses assessed', view)
      check(
        view.claimReview!.status === 'ASSESSED_NO_SEND',
        `Original Composer accepts the explicit bounded assessment: ${JSON.stringify(view.claimReview!.current!.findings)}`,
      )
      check(
        view.draft!.state === 'DRAFT_REVIEW' && !view.claimReview!.readReviewRecorded,
        'Meaning assessment does not fabricate a read acknowledgment',
      )
      const reviewedId = view.claimReview!.current!.id
      const replay = await act(goodAction)
      check(
        replay.claimReview!.current!.id === reviewedId,
        'Identical meaning-action retry reuses the same immutable receipt',
      )
      const sourceClaim = view.claimReview!.current!.claimEvidence.find(
        (item) => item.annotation.category === 'SOURCE FACT',
      )!
      check(
        sourceClaim.sources[0]!.claim_id === 'F-VENUE' &&
          Boolean(sourceClaim.sources[0]!.evidence_sha256),
        'Factual claim exposes its exact source pointer and evidence hash',
      )
      await rejects(
        () =>
          act({
            ...goodAction,
            input: { ...goodAction.input, reviewer: { kind: 'human', identity: 'Tom' } },
          }),
        /cannot assert.*human/i,
        'Synthetic actor cannot claim an authenticated human review',
      )
      await rejects(
        () => applyNativeSalesAction(goodAction, { ...actor, type: 'AGENT' } as never),
        /operator/,
        'Agent authority cannot enter the native operator write path',
      )
      await rejects(
        () => act({ action: 'send', input: {} } as never),
        /Invalid|discriminator|action/i,
        'No send action exists',
      )
      await rejects(
        () =>
          act({
            ...meaningAction(view),
            input: { ...meaningAction(view).input, expectedBindingHash: '0'.repeat(64) },
          }),
        /STALE_MEANING_BINDING/,
        'Forged binding hash is refused',
      )
      const obsolete = meaningAction(
        beforeGoodMeaning,
        'Different submitted findings from an old open review',
      )
      await rejects(
        () => act(obsolete),
        /CONCURRENT_MEANING_REVIEW/,
        'Stale open-form review cannot overwrite newer findings',
      )

      const raceBase = view
      const racers = [
        meaningAction(raceBase, 'Synthetic concurrency assessment A'),
        meaningAction(raceBase, 'Synthetic concurrency assessment B'),
      ]
      const raced = await Promise.allSettled(racers.map(act))
      check(
        raced.filter((entry) => entry.status === 'fulfilled').length === 1 &&
          raced.filter((entry) => entry.status === 'rejected').length === 1,
        'Two concurrent native assessments with one expected head yield one append and one conflict',
      )
      receipt.concurrency = raced.map((entry) =>
        entry.status === 'fulfilled'
          ? { status: entry.status, reviewId: entry.value.claimReview?.current?.id }
          : { status: entry.status, reason: String(entry.reason).slice(-800) },
      )
      view = await getNativeSalesWorkflow(target.venueId)
      view = await readReview(view)
      check(
        view.draft!.state === 'REVIEWED_NO_SEND' && view.claimReview!.status === 'ASSESSED_NO_SEND',
        'Exact draft reaches reviewed-no-send with separate attributed meaning assessment',
      )
      const review = await db.prospectActivity.findUniqueOrThrow({
        where: { id: view.claimReview!.current!.id },
      })
      const frozen = salesHash(salesJson(review))
      for (const operation of ['update', 'delete'] as const)
        await rejects(
          () =>
            db.$transaction(async (tx) => {
              if (operation === 'update')
                await tx.prospectActivity.update({
                  where: { id: review.id },
                  data: { summary: 'Forbidden overwrite probe' },
                })
              else await tx.prospectActivity.delete({ where: { id: review.id } })
              throw new Error('IMMUTABILITY_PROBE_UNEXPECTEDLY_ACCEPTED_ROLLED_BACK')
            }),
          /Append-only.*does not allow/,
          `Existing append-only middleware refuses meaning receipt ${operation}`,
        )
      // Isolate the database trigger using a parameterized rollback-only probe of
      // THIS run's synthetic receipt. Even a protection regression cannot commit.
      for (const operation of ['update', 'delete'] as const)
        await rejects(
          () =>
            db.$transaction(async (tx) => {
              if (operation === 'update')
                await tx.$executeRaw`UPDATE prospect_activities SET summary = summary WHERE id = ${review.id}`
              else await tx.$executeRaw`DELETE FROM prospect_activities WHERE id = ${review.id}`
              throw new Error('IMMUTABILITY_PROBE_UNEXPECTEDLY_ACCEPTED_ROLLED_BACK')
            }),
          /NO_SEND_REVIEW_IMMUTABLE/,
          `Database trigger rejects rollback-only synthetic meaning ${operation} probe`,
        )
      check(
        frozen ===
          salesHash(
            salesJson(await db.prospectActivity.findUniqueOrThrow({ where: { id: review.id } })),
          ),
        'Immutable meaning receipt exact full-row hash unchanged after update/delete probes',
      )
      await rejects(
        () =>
          db.$transaction(async (tx) => {
            await tx.prospectOutreachDraft.update({
              where: { id: view.draft!.id },
              data: { textBody: 'Forbidden changed bytes' },
            })
            throw new Error('IMMUTABILITY_PROBE_UNEXPECTEDLY_ACCEPTED_ROLLED_BACK')
          }),
        /NO_SEND_REVISION_IMMUTABLE/,
        'Native draft exact bytes remain database-protected',
      )
      const draftRow = await db.prospectOutreachDraft.findUniqueOrThrow({
        where: { id: view.draft!.id },
      })
      const prepRow = await db.prospectSourceEvidence.findUniqueOrThrow({
        where: { id: view.draft!.preparationId },
      })
      const stored = decodeSalesComponent(prepRow.capturedValue),
        native = await readNativeSalesSnapshot(target.venueId)
      const action = meaningAction(view)
      const submission = {
        bindingHash: action.input.expectedBindingHash,
        draftId: draftRow.id,
        preparationId: prepRow.id,
        contentHash: draftRow.contentHash,
        annotations: action.input.annotations,
        languageUses: action.input.languageUses,
        reviewer: action.input.reviewer,
        assessments: action.input.assessments,
        answers: action.input.answers,
        unsupportedClaims: action.input.unsupportedClaims,
      }
      const checked = await invokeSalesComponents({
        action: 'meaning',
        native,
        draft: goodText,
        review: submission,
      })
      for (const field of ['runtime', 'library', 'WLT']) {
        const changed = {
          ...checked,
          componentCodeHashes: {
            ...(checked.componentCodeHashes as object),
            [`synthetic-${field}-revision`]: 'changed',
          },
        }
        await rejects(
          () =>
            recordNativeMeaningReview({ ...action.input, submission, component: changed, actor }),
          /STALE_MEANING_REVIEW/,
          `Changed ${field} component revision invalidates native review without editing an upstream dependency`,
        )
      }
      const bound = nativeMeaningBinding(draftRow, stored)
      receipt.exactBinding = bound
      check(
        beforeSnapshot === view.snapshotHash &&
          beforeContacts ===
            salesHash(
              salesJson(
                await db.prospectContact.findMany({
                  where: { organizationId: target.organizationId },
                  orderBy: { id: 'asc' },
                }),
              ),
            ),
        'Original P03 source/contact fingerprint unchanged across drafts, findings and review',
      )
      recordSnapshot('Reviewed no-send with separate review scopes', view)
      receipt.goodAnnotations = meaningAnnotations(view)

      let form = await prepare(await getNativeSalesWorkflow(examples.P06!.venueId))
      form = await save(form, {
        subject: 'Could a guide discussion be useful?',
        body: 'Hi,\n\nWould it be useful to discuss a small guide based on material you choose? We could explore one room first and consider whether that might fit alongside a visit, without assuming an existing need or a particular format.\n\nWould a short conversation be helpful?\n\nThanks,\nTom',
      })
      check(
        form.routing!.kind === 'contact_form' &&
          form.claimReview!.boundIdentity.recipientValue === form.routing!.value,
        'Exact form-route URL is exposed and bound separately from an email recipient',
      )
      const formRow = await db.prospectOutreachDraft.findUniqueOrThrow({
        where: { id: form.draft!.id },
      })
      const formPrep = await db.prospectSourceEvidence.findUniqueOrThrow({
        where: { id: form.draft!.preparationId },
      })
      const formBinding = nativeMeaningBinding(
        formRow,
        decodeSalesComponent(formPrep.capturedValue),
      )
      check(
        formBinding.binding.recipient === null && Boolean(formBinding.binding.route.url),
        'No fabricated email address for the form route',
      )

      let reply = await prepare(await getNativeSalesWorkflow(examples.P02!.venueId), answerText)
      const replyText = meaningTextFixture(reply.name, 'reply')
      reply = await save(reply, replyText)
      check(
        reply.claimReview!.questions.length > 0 &&
          Boolean(reply.claimReview!.boundIdentity.threadId) &&
          Boolean(reply.claimReview!.boundIdentity.inboundId),
        'Reply review exposes exact current native thread and inbound identity',
      )
      reply = await act(meaningAction(reply))
      recordSnapshot('Source-bound reply claim assessment', reply)
      check(
        reply.claimReview!.status === 'ASSESSED_NO_SEND',
        `Reply addresses actual inbound direction: ${JSON.stringify(reply.claimReview!.current!.findings)}`,
      )
      reply = await readReview(reply)
      check(
        !reply.draft!.body.includes(reply.correspondence!.latestInbound!.body) &&
          !reply.draft!.body.includes('From:'),
        'Normal reply body does not dump the inbound or email chain',
      )
      await rejects(
        () =>
          save(reply, {
            subject: 'Re: Guide',
            body: 'From: venue\n' + reply.correspondence!.latestInbound!.body,
          }),
        /THREAD_OR_TRANSCRIPT_DUMP|REPLY_MUST_NOT_COPY_THE_CHAIN/,
        'Transcript dump is refused before a native draft write',
      )
      receipt.replyText = replyText
      receipt.replyAnnotations = meaningAnnotations(reply)
      await appendInbound()
    })
    await withTenantIsolationBypass(async () => {
      const zeroCounts = {
        campaigns: await db.prospectOutreachCampaign.count(),
        batches: await db.prospectSendBatch.count(),
        sendItems: await db.prospectSendItem.count(),
        outbox: await db.prospectSendOutbox.count(),
        followups: await db.prospectFollowup.count(),
        humanInboundReview: await db.prospectInboundReplyReview.count(),
        deliveryEnabled: await db.correspondenceProviderAccount.count({
          where: { deliveryEnabled: true },
        }),
        approvedNativeDrafts: await db.prospectOutreachDraft.count({
          where: {
            preparationKey: { not: null },
            OR: [
              { approvedAt: { not: null } },
              { approvedBy: { not: null } },
              { status: { not: 'NEEDS_REVIEW' } },
            ],
          },
        }),
        realMessages: await db.prospectEmailMessage.count({
          where: { NOT: { sourceReference: { startsWith: 'synthetic:crm-sales:' } } },
        }),
      }
      check(
        Object.values(zeroCounts).every((value) => value === 0),
        'No campaign, outbox, send state, human inbound review, enabled provider or real correspondence exists',
      )
      receipt.zeroCounts = zeroCounts
    })
    receipt.passed = true
  } catch (error) {
    receipt.passed = false
    receipt.failure = error instanceof Error ? error.stack : String(error)
    console.error(receipt.failure)
    process.exitCode = 1
  } finally {
    Object.assign(receipt, { checks, snapshots, examples, completedAt: new Date().toISOString() })
    await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    await db.$disconnect()
    console.log(
      JSON.stringify({ output, passed: receipt.passed, checks: checks.length, mode: receipt.mode }),
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
