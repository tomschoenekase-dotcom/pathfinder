import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { evidenceDraft, evidenceMeaningAction } from './crm-sales/evidence-acceptance-fixture'
import type {
  NativeSalesAction,
  SalesWorkflowView,
} from '../packages/api/src/prospect-sales-contract'

async function main() {
  const root = path.resolve(__dirname, '..')
  const artifacts = path.join(root, 'artifacts/crm-evidence-admission-20260921-r001')
  const index = process.argv.indexOf('--output')
  const output =
    index < 0
      ? path.join(artifacts, `inspect-${Date.now()}.json`)
      : path.resolve(process.argv[index + 1]!)
  assert.ok(output.startsWith(artifacts + path.sep))
  await mkdir(path.dirname(output), { recursive: true })
  await access(output).then(
    () => {
      throw new Error('Receipt already exists; use a new suffix before running acceptance')
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
  const { db } = await import('../packages/db/src/client')
  Object.assign(process.env, { NODE_ENV: 'development' })
  const { withTenantIsolationBypass } =
    await import('../packages/db/src/middleware/tenant-isolation')
  const {
    assertLocalSalesEnvironment,
    getNativeSalesWorkflow,
    invokeSalesComponents,
    applyNativeSalesAction,
  } = await import('../packages/api/src/prospect-sales-workflow')
  const { readNativeSalesSnapshot, salesHash: canonicalHash } =
    await import('../packages/db/src/helpers/prospect-sales-snapshot')
  // Preserve native Date fields in full-row comparison, just as salesJson does.
  const salesHash = (value: unknown) => canonicalHash(JSON.parse(JSON.stringify(value)))
  const { stageNativeSourceCapture } =
    await import('../packages/db/src/helpers/prospect-source-admission')
  const actor = {
    type: 'SYSTEM',
    role: 'PLATFORM_ADMIN',
    id: 'synthetic:crm-meaning:evidence-acceptance',
  } as const
  const checks: { label: string; passed: boolean }[] = []
  const extra: Record<string, unknown> = {}
  let passed = false,
    failure: string | null = null
  const check = (ok: unknown, label: string) => {
    checks.push({ label, passed: Boolean(ok) })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
    assert.ok(ok, label)
  }
  const rejects = async (fn: () => Promise<unknown>, match: RegExp, label: string) => {
    try {
      await fn()
    } catch (error) {
      check(match.test(String(error)), label)
      return
    }
    check(false, label)
  }
  const act = (action: NativeSalesAction) => applyNativeSalesAction(action, actor)
  try {
    assertLocalSalesEnvironment()
    await withTenantIsolationBypass(async () => {
      const matches = await db.prospectVenue.findMany({
        where: { name: 'Centralia Historical Society Museum' },
        take: 2,
      })
      assert.equal(matches.length, 1, 'Explicit existing nonpilot must resolve uniquely')
      const target = matches[0]!
      const native = await readNativeSalesSnapshot(target.id)
      let view = await getNativeSalesWorkflow(target.id)
      const component = await invokeSalesComponents({ action: 'evaluate', native })
      if (process.argv.includes('--stage-only') || process.argv.includes('--full')) {
        // Fixed retained technical-QA input, never a client path or network request.
        const capture = JSON.parse(
          await readFile(path.join(artifacts, 'capture-record.json'), 'utf8'),
        )
        const component = await invokeSalesComponents({ action: 'capture', native, capture })
        const saved = await stageNativeSourceCapture({
          venueId: target.id,
          expectedSnapshotHash: native.snapshotHash,
          capture,
          component,
          actor,
        })
        const current = await readNativeSalesSnapshot(target.id)
        const replayCheck = await invokeSalesComponents({
          action: 'capture',
          native: current,
          capture,
        })
        const replay = await stageNativeSourceCapture({
          venueId: target.id,
          expectedSnapshotHash: current.snapshotHash,
          capture,
          component: replayCheck,
          actor,
        })
        check(
          saved.id === replay.id,
          'Exact official capture replay reuses native source identity without date refresh',
        )
        view = await getNativeSalesWorkflow(target.id)
        check(
          view.evidenceAdmission?.captures.some((c) => c.id === saved.id),
          'Retained genuine bytes are inspectable through the native prospect UI contract',
        )
        check(
          view.contacts.every((c) => c.permission === 'UNKNOWN' && c.readiness === 'UNKNOWN'),
          'All imported candidate states remain UNKNOWN/UNKNOWN',
        )
        if (!view.evidenceAdmission?.selectionId)
          check(
            !view.gate.canPrepare,
            'Retaining a source does not auto-admit claims or recipients',
          )
        extra.captureId = saved.id
        const frozen = salesHash(
          await db.prospectSourceEvidence.findUniqueOrThrow({ where: { id: saved.id } }),
        )
        await rejects(
          () =>
            db.prospectSourceEvidence.update({
              where: { id: saved.id },
              data: { sourceLabel: 'Forbidden mutation probe' },
            }),
          /Append-only/,
          'Existing source owner refuses capture overwrite',
        )
        check(
          frozen ===
            salesHash(
              await db.prospectSourceEvidence.findUniqueOrThrow({ where: { id: saved.id } }),
            ),
          'Exact retained capture row unchanged by denied overwrite probe',
        )
      }
      if (process.argv.includes('--full')) {
        const captureId = String(extra.captureId)
        const selection = {
          claimIds: ['N-IDENTITY', 'N-DESCRIPTION'],
          routeClaimId: 'N-EMAIL',
          purpose: 'Discuss whether a small venue-controlled visitor guide would be useful.',
          hypothesis:
            'Propose exploring a small guide using material the venue chooses. This is a discussion, not a deployment, price, visit or promised result.',
        }
        const select = (
          current: SalesWorkflowView,
          routeClaimId: string | null = selection.routeClaimId,
        ) => ({
          action: 'admitEvidence' as const,
          input: {
            venueId: current.venueId,
            expectedSnapshotHash: current.snapshotHash,
            expectedSelectionId: current.evidenceAdmission!.selectionId,
            captureId,
            selection: { ...selection, routeClaimId },
          },
        })
        const request = select(view)
        view = await act(request)
        check(
          view.gate.canPrepare &&
            view.sourceState === 'NATIVE_SOURCE_CATALOG_WITH_EXACT_IMPORT_LINEAGE',
          'Real nonpilot evidence enters the original Gate without a pilot alias',
        )
        const afterSelection = await readNativeSalesSnapshot(target.id)
        await act(request)
        check(
          (await readNativeSalesSnapshot(target.id)).snapshotHash === afterSelection.snapshotHash,
          'Exact admission action retry is idempotent, including an already-applied stale snapshot',
        )
        await rejects(
          () => act({ ...request, input: { ...request.input, captureId: 'missing-capture' } }),
          /capture|INVALID|STALE/i,
          'Unowned or nonexistent capture ID is refused',
        )
        await rejects(
          () => applyNativeSalesAction({ action: 'send', input: {} } as never, actor),
          /Invalid|discriminator/i,
          'No sender action exists',
        )
        await rejects(
          () => applyNativeSalesAction(select(view), { ...actor, type: 'AGENT' } as never),
          /operator/,
          'Agent cannot acquire platform operator authority',
        )
        const prepare = (v: SalesWorkflowView) =>
          act({
            action: 'prepare',
            input: { venueId: v.venueId, expectedSnapshotHash: v.snapshotHash },
          })
        const save = (v: SalesWorkflowView, unsupported = false) =>
          act({
            action: 'save',
            input: {
              venueId: v.venueId,
              preparationId: v.preparation!.id,
              expectedSnapshotHash: v.snapshotHash,
              expectedDraftId: v.preparation!.expectedDraftId,
              ...evidenceDraft(v.name, unsupported),
            },
          })
        const readReview = (v: SalesWorkflowView) =>
          act({
            action: 'review',
            input: {
              venueId: v.venueId,
              draftId: v.draft!.id,
              contentHash: v.draft!.contentHash,
              expectedSnapshotHash: v.snapshotHash,
            },
          })
        view = await prepare(view)
        check(
          view.preparation?.approvedCount === 0 &&
            view.preparation.selectedCount === 0 &&
            Boolean(view.preparation.wltIdentity),
          'Same WLT runtime and genuinely empty Approved Language owner',
        )
        view = await save(view, true)
        view = await act(evidenceMeaningAction(view))
        check(
          view.claimReview?.status === 'BLOCKED',
          'Original Composer rejects invented exhibit, price and completed visit on nonpilot evidence',
        )
        view = await readReview(view)
        check(
          view.claimReview!.status === 'BLOCKED' && view.claimReview!.current!.findings.length > 0,
          'Read acknowledgment cannot clear unsupported claim holds',
        )
        const badId = view.draft!.id
        view = await save(view)
        check(
          view.draft!.id !== badId && view.claimReview?.status === 'REQUIRED',
          'Changed exact text appends a revision and requires independent meaning review',
        )
        view = await act(evidenceMeaningAction(view))
        check(
          view.claimReview?.status === 'ASSESSED_NO_SEND',
          `Existing Composer meaning path records source-bound assessment: ${JSON.stringify(view.claimReview?.current?.findings)}`,
        )
        view = await readReview(view)
        check(
          view.draft!.state === 'REVIEWED_NO_SEND',
          'Native nonpilot exact draft reaches reviewed-no-send',
        )
        check(
          view.claimReview!.current!.claimEvidence.some((c) =>
            c.sources.some((s) => s.claim_id === 'N-IDENTITY' && s.source_id.startsWith(captureId)),
          ),
          'Claim evidence points to the native captured bytes rather than fabricated pilot data',
        )
        const reviewedDraft = view.draft!,
          reviewedId = view.claimReview!.current!.id
        const rowHash = salesHash(
          await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: reviewedDraft.id } }),
        )
        const reviewHash = salesHash(
          await db.prospectActivity.findUniqueOrThrow({ where: { id: reviewedId } }),
        )
        view = await act(select(view, 'N-FORM'))
        check(
          view.routing?.kind === 'contact_form' && view.claimReview?.stale,
          'Changed form route invalidates prior exact draft/meaning review without guessing an email',
        )
        check(
          rowHash ===
            salesHash(
              await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: reviewedDraft.id } }),
            ) &&
            reviewHash ===
              salesHash(await db.prospectActivity.findUniqueOrThrow({ where: { id: reviewedId } })),
          'Previous reviewed draft and receipt remain full-row identical after source/route change',
        )
        view = await prepare(view)
        view = await save(view)
        const form = await db.prospectOutreachDraft.findUniqueOrThrow({
          where: { id: view.draft!.id },
        })
        check(
          form.toEmail === null && form.contactId === null,
          'Actual native form draft has no email recipient or candidate contact',
        )
        view = await act(select(view, null))
        check(
          !view.gate.canPrepare && view.routing?.value === null,
          'Explicitly unresolved route remains held',
        )
        await rejects(
          () => prepare(view),
          /eligible|preparation|evidence|hold/i,
          'Missing recipient cannot prepare a draft',
        )
        view = await act(select(view))
        const head = view.evidenceAdmission!.selectionId
        const concurrent = ['A', 'B'].map((suffix) => ({
          ...select(view),
          input: {
            ...select(view).input,
            selection: {
              ...selection,
              purpose: `Bounded concurrency acceptance ${suffix}: discuss a visitor guide.`,
            },
          },
        }))
        const results = await Promise.allSettled(concurrent.map(act))
        check(
          results.filter((r) => r.status === 'fulfilled').length === 1 &&
            results.filter((r) => r.status === 'rejected').length === 1,
          'Two concurrent ID-only admissions with one expected head yield one append and one conflict',
        )
        view = await getNativeSalesWorkflow(target.id)
        check(
          view.evidenceAdmission!.selectionId !== head,
          'Concurrent winner is the current native evidence revision',
        )
        view = await act(select(view))
        view = await prepare(view)
        view = await save(view)
        view = await act(evidenceMeaningAction(view))
        view = await readReview(view)
        check(
          view.draft!.state === 'REVIEWED_NO_SEND' && view.SEND_AUTHORIZED === false,
          'Final technical-QA state is source-bound reviewed-no-send, not approval',
        )
        extra.final = view
      }
      const actual = await readNativeSalesSnapshot(target.id)
      const original = JSON.parse(
        await readFile(path.join(artifacts, 'before-native.json'), 'utf8'),
      )
      const identityHash = salesHash({
        venue: actual.venue,
        organization: actual.organization,
        contacts: actual.contacts,
        importRecords: actual.importRecords,
      })
      check(
        identityHash === original.originalIdentityHash,
        'Exact original organization/venue/contact/import IDs, fields and fingerprints preserved',
      )
      check(
        salesHash(
          actual.sources.filter((s) =>
            original.native.sources.some((old: { id: string }) => old.id === s.id),
          ),
        ) === salesHash(original.native.sources),
        'Every original source-evidence row for the selected native prospect remains identical',
      )
      const counts = {
        campaigns: await db.prospectOutreachCampaign.count(),
        batches: await db.prospectSendBatch.count(),
        sendItems: await db.prospectSendItem.count(),
        outbox: await db.prospectSendOutbox.count(),
        enabledProviders: await db.correspondenceProviderAccount.count({
          where: { deliveryEnabled: true },
        }),
        approvedDrafts: await db.prospectOutreachDraft.count({
          where: { preparationKey: { not: null }, approvedAt: { not: null } },
        }),
        realMessages: await db.prospectEmailMessage.count({
          where: { NOT: { sourceReference: { startsWith: 'synthetic:crm-sales:' } } },
        }),
      }
      check(
        Object.values(counts).every((c) => c === 0),
        'No campaigns, delivery items, outbox, enabled providers, approved drafts or real messages',
      )
      extra.counts = counts
      const receipt = {
        schema: 'torchiko.native-evidence-inspection/1',
        observedAt: new Date().toISOString(),
        target: { organizationId: target.organizationId, venueId: target.id, name: target.name },
        native: actual,
        view,
        component,
        originalIdentityHash: identityHash,
        technicalQaSelectionOnly: true,
        SEND_AUTHORIZED: false,
      }
      Object.assign(extra, receipt)
      passed = true
      console.log(
        JSON.stringify({
          output,
          target: receipt.target,
          gate: view.gate,
          sourceUrls: native.sources.map((s) => s.sourceUrl),
          importedRows: native.importRecords
            .filter((r) => r.recordKind === 'PROSPECT')
            .map((r) => r.rawPayload),
          originalIdentityHash: receipt.originalIdentityHash,
          SEND_AUTHORIZED: false,
        }),
      )
    })
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(failure)
  } finally {
    await writeFile(
      output,
      JSON.stringify(
        {
          ...extra,
          checks,
          passed,
          failure,
          actor,
          mode: process.argv.includes('--full')
            ? 'FULL_LOCAL_NO_SEND'
            : process.argv.includes('--stage-only')
              ? 'STAGE_CAPTURE_ONLY'
              : 'READ_ONLY_INSPECTION',
          SEND_AUTHORIZED: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    )
    console.log(JSON.stringify({ output, passed, checks: checks.length }))
    await db.$disconnect()
  }
  if (!passed) process.exitCode = 1
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
