import assert from 'node:assert/strict'
import { db } from '../../packages/db/src/client'
import {
  salesHash,
  readNativeSalesSnapshot,
  decodeSalesComponent,
} from '../../packages/db/src/helpers/prospect-sales-snapshot'
import { importNativeWriterResult } from '../../packages/db/src/helpers/prospect-sales-writer'
import { reviewProspectOutreachDraftAction } from '../../packages/db/src/helpers/prospect-outreach-actions'
import {
  applyNativeSalesAction,
  getNativeSalesWorkflow,
  invokeSalesComponents,
} from '../../packages/api/src/prospect-sales-workflow'
import { nativeWriterResult } from '../../packages/api/src/prospect-writer-contract'
import type {
  NativeWriterTask,
  NativeWriterResult,
} from '../../packages/api/src/prospect-writer-contract'
import type { SalesActor } from '../../packages/db/src/helpers/prospect-sales-actions'

/** Explicitly manufactured adversarial fixtures, NOT the foreground AI happy-path
 * demonstration. Uses a different isolated prospect so exported UI tasks stay exact. */
export async function firstSendFaultChecks(
  actor: SalesActor,
  check: (ok: unknown, label: string) => void,
) {
  const org = 'SYN-CRM-FIRSTSEND-ORG-r002',
    venue = 'SYN-CRM-FIRSTSEND-VENUE-r002',
    contact = 'SYN-CRM-FIRSTSEND-CONTACT-r002',
    source = 'SYN-CRM-FIRSTSEND-SOURCE-r002'
  const originalSource = await db.prospectSourceEvidence.findUnique({
    where: { id: 'SYN-CRM-FIRSTSEND-SOURCE-r001' },
  })
  assert.ok(originalSource)
  if (!(await db.prospectOrganization.findUnique({ where: { id: org } }))) {
    await db.$transaction(
      async (tx) => {
        await tx.prospectOrganization.create({
          data: {
            id: org,
            canonicalName: 'SYNTHETIC First Send Fault Boundaries',
            normalizedName: 'synthetic first send fault boundaries',
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        })
        await tx.prospectVenue.create({
          data: {
            id: venue,
            organizationId: org,
            name: 'Fixture Museum',
            normalizedName: 'fixture museum',
            city: 'Synthetic City',
            region: 'SYN',
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        })
        await tx.prospectContact.create({
          data: {
            id: contact,
            organizationId: org,
            venueId: venue,
            email: 'fixture@example.invalid',
            normalizedEmail: 'fixture@example.invalid',
            emailReadiness: 'VALID',
            permissionState: 'UNKNOWN',
            source: 'SYNTHETIC initial test readiness, not human promotion or actual consent',
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        })
        await tx.prospectSourceEvidence.create({
          data: {
            id: source,
            organizationId: org,
            venueId: venue,
            sourceType: originalSource.sourceType,
            sourceLabel: 'Existing synthetic source fixture for isolated fault tests',
            capturedValue: originalSource.capturedValue!,
            createdBy: actor.id,
          },
        })
      },
      { isolationLevel: 'Serializable' },
    )
  }
  const counts = async () => ({
    drafts: await db.prospectOutreachDraft.count({ where: { venueId: venue } }),
    activities: await db.prospectActivity.count({ where: { venueId: venue } }),
  })
  let view = await getNativeSalesWorkflow(venue)
  view = await applyNativeSalesAction(
    { action: 'prepare', input: { venueId: venue, expectedSnapshotHash: view.snapshotHash } },
    actor,
  )
  assert.ok(view.writerTask)
  check(
    view.preparation?.selectedCount === 0 && view.writerTask.writerContext.synthetic === true,
    'Fault fixture uses the declared original synthetic library with zero selected patterns; its fictional approval is not a live Tom approval',
  )
  const body =
    'Hi,\n\nWould it be useful to discuss a small guide for a few objects, using material you choose? The scope could stay with those objects rather than assuming that a larger guide is needed.\n\nWould a short conversation about that idea make sense?\n\nThanks,\nTom'
  function candidate(task: NativeWriterTask, variant = body, assessed = true): NativeWriterResult {
    const subject = 'Could a small guide be useful?'
    let number = 0
    const annotations = (['subject', 'body'] as const).flatMap((section) => {
      let at = 0
      return (section === 'subject' ? subject : variant).split('\n\n').map((quote) => {
        const start = at
        const end = at + Array.from(quote).length
        at = end + 2
        const courtesy = ['Hi,', 'Hi, 🌿', 'Thanks,\nTom'].includes(quote)
        const bad = quote.includes('Moon Gem')
        return {
          annotation_id: `a-${++number}`,
          section,
          start,
          end,
          quote,
          category: courtesy
            ? ('NONFACTUAL' as const)
            : bad
              ? ('SOURCE FACT' as const)
              : ('SALES HYPOTHESIS' as const),
          claim_ids: courtesy
            ? []
            : bad
              ? ['F-VENUE']
              : quote.startsWith('Would a short')
                ? ['H-ASK']
                : ['H-SCOPE'],
          reason: courtesy
            ? 'SYNTHETIC ordinary greeting or closing only.'
            : bad
              ? 'SYNTHETIC adversarial claim falsely mapped to venue identity; original validator must hold it.'
              : 'SYNTHETIC proposal only, not an agreement or established need.',
          answers: [],
        }
      })
    })
    return nativeWriterResult.parse({
      schema: 'torchiko.native-writer-result/1',
      taskId: task.taskId,
      binding: task.binding,
      generatedBy: {
        kind: 'model',
        identity: 'SYNTHETIC fault-test model attribution — not foreground demonstration',
      },
      subject,
      body: variant,
      annotations,
      languageUses: [],
      assessment: assessed
        ? {
            reviewer: { kind: 'model', identity: 'SYNTHETIC manufactured assessment fixture' },
            assessments: annotations.map((a) => ({
              annotation_id: a.annotation_id,
              verdict:
                a.category === 'NONFACTUAL'
                  ? 'nonfactual'
                  : a.category === 'SOURCE FACT'
                    ? 'supported'
                    : 'hypothetical',
              reason: a.reason,
            })),
            answers: [],
            unsupportedClaims: [],
          }
        : null,
    })
  }
  const act = (result: NativeWriterResult) =>
    applyNativeSalesAction(
      {
        action: 'importWriterResult',
        input: { venueId: venue, expectedSnapshotHash: result.binding.nativeSnapshotHash, result },
      },
      actor,
    )
  async function rejects(run: () => Promise<unknown>, label: string) {
    const before = await counts()
    await assert.rejects(run)
    check(
      salesHash(await counts()) === salesHash(before),
      label + ': no partial draft or review writes',
    )
  }
  const original = candidate(view.writerTask)
  const native = await readNativeSalesSnapshot(venue)
  const component = await invokeSalesComponents({
    action: 'check',
    native,
    draft: { subject: original.subject, body: original.body },
  })
  await rejects(
    () =>
      importNativeWriterResult({
        result: original,
        component,
        actor,
        assess: async () => {
          throw new Error('SYNTHETIC_ASSESSMENT_PROCESS_FAILURE')
        },
      }),
    'Actual transaction rolls back draft and provenance when assessment fails',
  )
  for (const key of [
    'preparationHash',
    'componentCodeHash',
    'routeHash',
    'threadHash',
    'libraryHash',
    'wltHash',
    'fileSetHash',
  ] as const) {
    const bad = structuredClone(original)
    bad.binding[key] = 'f'.repeat(64)
    bad.taskId = 'writer-task_' + salesHash(bad.binding)
    await rejects(
      () => act(bad),
      `Forged/stale exported ${key} is rejected against current native state`,
    )
  }
  const wrongRecipient = structuredClone(original)
  wrongRecipient.binding.recipient = 'changed@example.invalid'
  wrongRecipient.taskId = 'writer-task_' + salesHash(wrongRecipient.binding)
  await rejects(
    () => act(wrongRecipient),
    'Changed exact recipient cannot retain prior task authority',
  )
  const wrongPrep = structuredClone(original)
  wrongPrep.binding.preparationId = 'nonexistent-preparation'
  wrongPrep.taskId = 'writer-task_' + salesHash(wrongPrep.binding)
  await rejects(() => act(wrongPrep), 'Missing or wrong preparation is not silently regenerated')
  const changedRuntime = structuredClone(component)
  changedRuntime.componentCodeHashes = {
    ...(component.componentCodeHashes as Record<string, string>),
    simulatedReadOnlyLibraryHead: 'changed',
  }
  await rejects(
    () =>
      importNativeWriterResult({
        result: original,
        component: changedRuntime,
        actor,
        assess: async () => {
          throw new Error('Must not reach assessment')
        },
      }),
    'A changed current runtime/library identity holds import without modifying the real library',
  )
  await rejects(
    () =>
      applyNativeSalesAction(
        {
          action: 'importWriterResult',
          input: { venueId: venue, expectedSnapshotHash: view.snapshotHash, result: original },
        },
        { ...actor, type: 'AGENT' } as never,
      ),
    'Wrong actor cannot acquire operator approval or write authority',
  )
  const forged = {
    ...original,
    assessment: { ...original.assessment!, reviewer: { kind: 'human', identity: 'Tom' } },
  }
  check(
    !nativeWriterResult.safeParse(forged).success,
    'A client cannot forge authenticated human assessment',
  )
  check(
    !nativeWriterResult.safeParse({ ...original, approved: true }).success,
    'A result cannot carry approval flags',
  )
  const overlap = structuredClone(original)
  overlap.annotations.push({ ...overlap.annotations[0]!, annotation_id: 'overlap' })
  check(
    !nativeWriterResult.safeParse(overlap).success,
    'Overlapping claim spans are rejected before import',
  )
  const staleText = structuredClone(original)
  staleText.body += ' Changed text'
  check(
    !nativeWriterResult.safeParse(staleText).success,
    'Changed text cannot borrow an old exact annotation set',
  )
  const second = candidate(view.writerTask, body.replace('larger guide', 'larger visitor guide'))
  const concurrent = await Promise.allSettled([act(original), act(second)])
  check(
    concurrent.filter((x) => x.status === 'fulfilled').length === 1 &&
      concurrent.filter((x) => x.status === 'rejected').length === 1,
    'Two concurrent model imports from one exact task head yield one atomic winner and one conflict',
  )
  const winner = concurrent[0]!.status === 'fulfilled' ? original : second
  const afterFirst = await counts()
  view = await act(winner)
  check(
    salesHash(await counts()) === salesHash(afterFirst),
    'Exact winner replay does not append a second draft, assessment or attribution receipt',
  )
  check(
    view.draft?.writerAttribution?.generatedBy === winner.generatedBy.identity &&
      !view.claimReview?.readReviewRecorded,
    'Model generation attribution is retained separately; importing never records a read acknowledgment',
  )
  assert.ok(view.writerTask)
  view = await act(candidate(view.writerTask, body.replace('Hi,', 'Hi, 🌿'), false))
  check(
    view.draft?.body.startsWith('Hi, 🌿') && view.claimReview?.status === 'REQUIRED',
    'Unicode-containing revised text is stored exactly and cannot inherit prior assessment',
  )
  assert.ok(view.writerTask)
  const chain = candidate(view.writerTask, body + '\n\nOn Monday Tom wrote:\n> old pitch', false)
  await rejects(
    () => act(chain),
    'Quoted old chain is refused by the actual original component bridge',
  )
  const unsupported = candidate(
    view.writerTask,
    body.replace(
      'Would a short conversation about that idea make sense?',
      'Your Moon Gem Gallery exhibit costs $25, and I visited it yesterday.',
    ),
  )
  view = await act(unsupported)
  check(
    view.claimReview?.status === 'BLOCKED' && view.claimReview.current!.findings.length > 0,
    'Unsupported exhibit, price and visit survive import only as a BLOCKED assessment, never approval',
  )
  const exactDraft = await db.prospectOutreachDraft.findUnique({ where: { id: view.draft!.id } })
  assert.ok(exactDraft)
  await assert.rejects(() =>
    reviewProspectOutreachDraftAction({ draftId: exactDraft.id, approve: true, actor }),
  )
  check(
    salesHash(await db.prospectOutreachDraft.findUnique({ where: { id: exactDraft.id } })) ===
      salesHash(exactDraft),
    'Existing approval owner refuses to approve the NO-SEND source in place',
  )
  await assert.rejects(() =>
    db.prospectOutreachDraft.update({
      where: { id: exactDraft.id },
      data: { subject: 'SYNTHETIC forbidden overwrite' },
    }),
  )
  check(
    salesHash(await db.prospectOutreachDraft.findUnique({ where: { id: exactDraft.id } })) ===
      salesHash(exactDraft),
    'Original SQL protects the immutable native source revision against overwrite',
  )
  const oldTask = view.writerTask!
  assert.ok(oldTask)
  await db.prospectSourceEvidence.create({
    data: {
      organizationId: org,
      venueId: venue,
      sourceType: 'SYNTHETIC_WRITER_STALENESS_PROBE',
      sourceLabel: 'Explicit synthetic evidence append to test staleness; no website claim',
      capturedValue: {
        synthetic: true,
        reason: 'Current source changes invalidate exported tasks',
        liveSend: false,
      },
      createdBy: actor.id,
    },
  })
  await rejects(
    () => act(candidate(oldTask)),
    'Actual later source evidence makes the old exported task stale',
  )
  const final = await getNativeSalesWorkflow(venue)
  check(
    final.writerTask === null && final.claimReview?.stale,
    'Current UI projection visibly holds the stale old writer task and assessment',
  )
  return {
    venueId: venue,
    counts: await counts(),
    concurrent: concurrent.map((x) => ({
      status: x.status,
      error: x.status === 'rejected' ? String(x.reason) : null,
    })),
    final: {
      source: final.snapshotHash,
      draftId: final.draft?.id,
      meaning: final.claimReview?.status,
      writerHold: final.writerHold,
    },
    synthetic: true,
  }
}
