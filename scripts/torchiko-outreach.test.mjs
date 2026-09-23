import test from 'node:test'
import assert from 'node:assert/strict'
import { compileNativeOutreachResult } from './lib/torchiko-outreach-result.mjs'
import { createOutreachWorkflow, researchForCurrentOutreach } from './lib/torchiko-outreach-workflow.mjs'

const task = () => ({ schema: 'torchiko.native-writer-task/1', taskId: `writer-task_${'a'.repeat(64)}`,
  binding: { venueId: 'SYN-V1', recipient: 'fixture@example.invalid' }, SEND_AUTHORIZED: false })
const part = (text, category = 'NONFACTUAL') => ({ text, category, claimIds: [], reason: 'Synthetic test with no factual claim.', answers: [] })
const text = () => ({ schema: 'torchiko.codex-outreach-text/1', subjectParts: [part('Hello 🦉')],
  bodyParts: [part('Hello there,\n\n'), part('A test 🌳.\n'), part('\n')] })
test('compiler preserves all original text and computes Unicode code-point spans', () => {
  const input = text(), original = structuredClone(input), native = task()
  const result = compileNativeOutreachResult(native, input, 'ACTUAL-SYNTHETIC-MODEL-IDENTITY')
  assert.deepEqual(input, original); assert.deepEqual(result.binding, native.binding)
  assert.equal(result.subject, 'Hello 🦉'); assert.equal(result.annotations[0].end, 7)
  assert.equal(result.body, input.bodyParts.map(p => p.text).join(''))
  for (const a of result.annotations) assert.equal(Array.from(result[a.section]).slice(a.start, a.end).join(''), a.quote)
  assert.equal(result.assessment, null); assert.deepEqual(result.languageUses, [])
})
test('compiler cannot forge approval, extra model fields or repaired line endings', () => {
  for (const mutate of [v => v.subjectParts[0].category = 'APPROVED REUSABLE LANGUAGE',
    v => v.approved = true, v => v.bodyParts[0].text += '\r\n', v => v.subjectParts[0].text += '\n',
    v => v.bodyParts[0].reason = 'OK', v => v.bodyParts[0].text = 'x'.repeat(12001)]) {
    const input = text(); mutate(input)
    assert.throws(() => compileNativeOutreachResult(task(), input, 'model'), { code: 'INVALID_MODEL_OUTPUT' })
  }
  assert.throws(() => compileNativeOutreachResult({ ...task(), SEND_AUTHORIZED: true }, text(), 'model'))
})
const view = () => ({ venueId: 'SYN-V1', snapshotHash: 'source-1', SEND_AUTHORIZED: false,
  gate: { canPrepare: true, questions: [], humanQuestions: [], notices: [] }, suppression: { blocked: false },
  sourceCount: 1, sourceState: 'SYNTHETIC', threadCandidates: [],
  preparation: { stale: false }, writerHold: null,
  writerTask: { ...task(), writingReference: { sha256: 'guide-1' } } })
test('name resolution rejects ambiguity and paginated search, never silently selects another venue', async () => {
  for (const response of [
    { items: [{ id: 'o', venues: [{ id: '1', name: 'Museum' }, { id: '2', name: 'Museum' }] }] },
    { items: [{ id: 'o', venues: [{ id: '1', name: 'Museum' }] }], nextCursor: 'next' },
  ]) {
    const workflow = createOutreachWorkflow({ client: { search: async () => response } })
    await assert.rejects(workflow.resolveVenue({ name: 'Museum' }), { code: 'AMBIGUOUS_VENUE' })
  }
})
test('current WLT/reference task is reused even with zero approved phrases', async () => {
  let writes = 0
  const workflow = createOutreachWorkflow({ client: { read: async () => ({ ...view(), preparation: { stale: false, approvedCount: 0 } }),
    prepare: async () => { writes++ } }, readGuide: async () => ({ sha256: 'guide-1' }) })
  assert.equal((await workflow.prepare({ venueId: 'SYN-V1' })).reused, true)
  assert.equal(writes, 0)
})
test('changed reference refreshes native preparation; stale source and suppression block instead of guessing', async () => {
  const calls = []
  const workflow = createOutreachWorkflow({ client: { read: async () => view(),
    prepare: async input => calls.push(input), task: async () => ({ writingReference: { sha256: 'guide-2' } }) },
    readGuide: async () => ({ sha256: 'guide-2' }) })
  assert.equal((await workflow.prepare({ venueId: 'SYN-V1' })).reused, false)
  assert.equal(calls.length, 1); assert.equal(calls[0].expectedSnapshotHash, 'source-1')
  for (const held of [{ ...view(), suppression: { blocked: true } }, { ...view(), gate: { canPrepare: false }, blocker: 'Missing body' }]) {
    await assert.rejects(createOutreachWorkflow({ client: { read: async () => held }, readGuide: async () => { throw Error('must not run') } })
      .prepare({ venueId: 'SYN-V1' }))
  }
})
test('unknown-response retry submits identical persisted result before any mutable read', async () => {
  const payloads = []; let first = true
  const workflow = createOutreachWorkflow({ client: {
    read: async () => { throw Error('A retry must not read first') }, prepare: async () => { throw Error('A retry must not prepare') },
    submit: async input => { payloads.push(JSON.stringify(input)); if (first) { first = false; throw Error('response not confirmed') }
      return { writerImportReceipt: { id: 'receipt', replayed: true } } },
  } })
  const result = compileNativeOutreachResult(task(), text(), 'model')
  await assert.rejects(workflow.importResult(result))
  const resumed = await workflow.importResult(JSON.parse(JSON.stringify(result)))
  assert.equal(resumed.writerImportReceipt.replayed, true); assert.equal(payloads[0], payloads[1])
})
test('expired and missing source bodies remain actionable history holds', () => {
  const decision = researchForCurrentOutreach({ ...view(), gate: { canPrepare: false, questions: [] },
    threadCandidates: [{ id: 'thread', sourceComplete: false, sourceIssues: ['Body expired'] }] })
  assert.equal(decision.action, 'RESOLVE_ONLY_CURRENT_BLOCKERS')
  assert.deepEqual(decision.historyIssues, [{ threadId: 'thread', reason: 'Body expired' }])
  assert.equal(decision.noAutomaticResearch, true)
})
