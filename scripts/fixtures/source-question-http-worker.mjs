import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Disposable HTTP client only. No product imports, database access or durable local state.
let raw = ''
for await (const chunk of process.stdin) {
  raw += chunk
  assert(raw.length <= 16000, 'Fixture input exceeded bound')
}
const input = JSON.parse(raw)
const sourceQuestion = input.sourceQuestion ?? {
  excerptPrefix: 'The east and south greenhouses',
  question: 'Are the east and south greenhouse references two distinct buildings?',
  fieldPath: 'entities.greenhouse',
  rationale: 'The retained answer distinguishes the two greenhouse buildings.',
}
for (const key of ['excerptPrefix', 'question', 'fieldPath', 'rationale']) {
  assert.equal(typeof sourceQuestion[key], 'string')
  assert(sourceQuestion[key].length > 0 && sourceQuestion[key].length <= 1000)
}

const clarificationReason = sourceQuestion.reason ?? 'CONTRADICTION'
assert(
  ['CONTRADICTION', 'DATE_SENSITIVE', 'LOW_CONFIDENCE', 'MISSING_CONTEXT'].includes(
    clarificationReason,
  ),
)
const url = new URL(input.url)
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.protocol, 'http:')
assert.equal(process.env.DATABASE_URL, undefined)
async function call(method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(15000),
  })
  assert.equal(response.status, 200, `Bridge rejected ${method}`)
  const body = await response.json()
  assert.equal(body.ok, true)
  return body.result
}
const { task } = await call('claimTask', {
  sessionId: input.sessionId,
  venueId: input.venueId,
  workerKey: input.workerKey,
})
assert(task, 'No task claimed')
const assignment = task.scope.sourceAssignment
assert.equal(assignment.kind, 'FILE_EXTRACTION')
const executionClaim = {
  agentRunId: task.id,
  bridgeSessionId: input.sessionId,
  workerId: input.workerId,
  executionLeaseToken: task.leaseToken,
}
const operational = (toolName, args) =>
  call('callOperationalTool', { venueId: input.venueId, toolName, executionClaim, arguments: args })
const first = await operational('pathfinder.read', {
  resource: 'assigned-source',
  agentRunId: task.id,
  pageSize: 4000,
})
assert(first.structuredContent.data.nextSourceCursor)
const second = await operational('pathfinder.read', {
  resource: 'assigned-source',
  agentRunId: task.id,
  pageSize: 4000,
  sourceCursor: first.structuredContent.data.nextSourceCursor,
})
assert(second.structuredContent.data.page.text.includes('137'))
let questionId
let answer
let resolutionId
if (input.mode === 'ask') {
  const excerpt = second.structuredContent.data.page.text
    .split('\n')
    .find((line) => line.startsWith(sourceQuestion.excerptPrefix))
  assert(excerpt && excerpt.length <= 1000)
  const result = await operational('pathfinder.ask_operator', {
    agentIdentityId: input.identityId,
    agentRunId: task.id,
    question: sourceQuestion.question,
    sourceClarification: {
      runId: assignment.intakeRunId,
      receiptId: assignment.receiptId,
      expectedExtractedTextHash: assignment.extractedTextHash,
      fieldPath: sourceQuestion.fieldPath,
      reason: clarificationReason,
      blockerScope: 'FOUNDATIONAL',
      evidenceExcerpt: excerpt,
    },
  })
  questionId = result.structuredContent.data.questionId
} else {
  assert.equal(input.mode, 'resume')
  const marker = '\n\nBounded persisted execution context:\n'
  const index = task.prompt.lastIndexOf(marker)
  assert(index >= 0)
  const context = JSON.parse(task.prompt.slice(index + marker.length))
  assert.equal(context.sourceAssignment.receiptId, assignment.receiptId)
  assert.equal(context.currentResolvedQuestions.length, 1)
  questionId = context.currentResolvedQuestions[0].questionId
  answer = context.currentResolvedQuestions[0].answer
  const read = await operational('pathfinder.read', {
    resource: 'question-source',
    agentRunId: task.id,
    questionId,
    pageSize: 4000,
  })
  assert.equal(read.structuredContent.data.extractedTextHash, assignment.extractedTextHash)
  const resolution = await operational('pathfinder.resolve_source_clarification', {
    agentIdentityId: input.identityId,
    agentRunId: task.id,
    requestId: randomUUID(),
    runId: assignment.intakeRunId,
    receiptId: assignment.receiptId,
    expectedExtractedTextHash: assignment.extractedTextHash,
    questionId,
    expectedAnsweredAt: context.currentResolvedQuestions[0].answeredAt,
    kind: 'REPLACE_EXCERPT',
    amendedExcerpt: answer,
    rationale: sourceQuestion.rationale,
  })
  assert.equal(resolution.structuredContent.data.terminalReviewRequired, true)
  assert.equal(resolution.structuredContent.data.canonicalVenueChanged, false)
  resolutionId = resolution.structuredContent.data.resolutionId
}
// Only bounded synthetic proof facts leave this process; never the bearer or lease token.
process.stdout.write(
  JSON.stringify({
    pid: process.pid,
    runId: task.id,
    attemptNumber: task.attemptNumber,
    questionId,
    answer,
    sourceHash: assignment.extractedTextHash,
    capacityRead: true,
    resolutionId,
  }),
)
