/** Isolated existing-thread reply task and model-result import; no approval or send. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.env.TORCHIKO_CONNECTED_QA_DIR ?? '')
const output = path.resolve(process.argv[2] ?? '')
const run = process.argv[3] ?? 'r001'
assert.match(run, /^r\d{3}$/u)
assert.ok(process.env.TORCHIKO_CONNECTED_QA_DIR && output.startsWith(root + path.sep))
const venueId = 'SYN-CRM-FIRSTSEND-VENUE-r007'
const actor = {
  type: 'SYSTEM' as const,
  role: 'PLATFORM_ADMIN' as const,
  id: 'synthetic:crm-meaning:connected-reply-r007',
}
const receipt: Record<string, unknown> = {
  schema: 'torchiko.connected-reply-roundtrip/1',
  venueId,
  synthetic: true,
  SEND_AUTHORIZED: false,
  passed: false,
}

async function main() {
  process.env.NODE_ENV = 'development'
  const { assertLocalSalesEnvironment, getNativeSalesWorkflow, applyNativeSalesAction } =
    await import('../packages/api/src/prospect-sales-workflow')
  const { db } = await import('../packages/db/src/index')
  assertLocalSalesEnvironment()
  let step = 'read'
  try {
    let view = await getNativeSalesWorkflow(venueId)
    assert.ok(['REPLY_RECEIVED', 'RESPONSE_REVIEW_NEEDED'].includes(view.correspondenceState))
    assert.ok(view.correspondence?.synthetic && view.correspondence.latestInbound)
    receipt.threadId = view.correspondence.threadId
    receipt.latestInboundId = view.correspondence.latestInbound.id
    step = 'prepare'
    const answerText =
      'We could discuss starting with one room. I do not have a setup-time estimate; ask what material the venue would choose.'
    view = (await applyNativeSalesAction(
      {
        action: 'prepare',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          answerText,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.writerTask && view.preparation && !view.preparation.stale)
    const task = view.writerTask
    assert.equal(task.binding.venueId, venueId)
    await writeFile(
      path.join(root, `resumed-reply-task-r007-${run}.json`),
      JSON.stringify(task, null, 2),
      { flag: 'wx' },
    )
    const questionIds = task.writerContext.relationship.questions.map(
      (question) => question.question_id,
    )
    assert.deepEqual(questionIds, ['Q-1', 'Q-2'])
    const subject = 'Re: SYNTHETIC storage and queue check'
    const body =
      'Hello,\n\nWe could discuss starting with one room. I do not have a setup-time estimate; what material would you choose?\n\nThanks,\nTom'
    const identity = 'GPT-5.6 Sol — synthetic reply integration proof'
    const annotations = []
    const assessments = []
    for (const [section, value] of [
      ['subject', subject],
      ['body', body],
    ] as const) {
      let start = 0
      for (const quote of value.split('\n\n')) {
        const end = start + Array.from(quote).length
        const nonfactual = quote === 'Hello,' || quote === 'Thanks,\nTom'
        const annotation_id = `${section}-${start}-${end}`
        const reason = nonfactual
          ? 'Ordinary greeting or closing.'
          : 'This follows the task-supplied answer direction for the exact synthetic inbound point; no setup-time claim is made.'
        annotations.push({
          annotation_id,
          section,
          start,
          end,
          quote,
          category: nonfactual ? ('NONFACTUAL' as const) : ('TASK CONSTRAINT' as const),
          claim_ids: nonfactual ? [] : ['H-RESPONSE'],
          reason,
          answers: section === 'body' && !nonfactual ? questionIds : [],
        })
        assessments.push({
          annotation_id,
          verdict: nonfactual ? ('nonfactual' as const) : ('supported' as const),
          reason,
        })
        start = end + 2
      }
    }
    const result = {
      schema: 'torchiko.native-writer-result/1' as const,
      taskId: task.taskId,
      binding: task.binding,
      generatedBy: { kind: 'model' as const, identity },
      subject,
      body,
      annotations,
      languageUses: [],
      assessment: {
        reviewer: { kind: 'model' as const, identity },
        assessments,
        answers: [
          {
            question_id: 'Q-1',
            verdict: 'answers' as const,
            quote: 'We could discuss starting with one room.',
            reason: 'The proposed response directly addresses the one-room starting scope.',
          },
          {
            question_id: 'Q-2',
            verdict: 'answers' as const,
            quote: 'I do not have a setup-time estimate',
            reason:
              'The response explicitly says the setup time is unknown instead of inventing an estimate.',
          },
        ],
        unsupportedClaims: [],
      },
    }
    await writeFile(
      path.join(root, `resumed-reply-result-r007-${run}.json`),
      JSON.stringify(result, null, 2),
      { flag: 'wx' },
    )
    step = 'import'
    view = (await applyNativeSalesAction(
      {
        action: 'importWriterResult',
        input: {
          venueId,
          expectedSnapshotHash: view.snapshotHash,
          result,
        },
      },
      actor,
    )) as typeof view
    assert.ok(view.draft && view.draft.body === body && view.claimReview?.current)
    receipt.taskId = task.taskId
    receipt.preparationId = task.binding.preparationId
    receipt.draftId = view.draft.id
    receipt.meaningReviewId = view.claimReview.current.id
    receipt.reviewStatus = view.claimReview.status
    assert.equal(receipt.reviewStatus, 'ASSESSED_NO_SEND')
    receipt.currentViewAvailable = true
    receipt.passed = true
  } catch (error) {
    receipt.failedStep = step
    receipt.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' })
    await db.$disconnect()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
