import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/** Provider-dark preparation contract. This module has no credential or network API. */
export const SOL_EVALUATION_PROFILE = Object.freeze({
  schema: 'torchiko-sol-paired-evaluation-v1',
  modelKey: 'guest-chat-sol',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'low',
  requestedServiceTier: 'default',
  maxAttempts: 1,
  sdkMaxRetries: 0,
  stream: false,
  plannerMaxOutputTokens: 1024,
  answerMaxOutputTokens: 2048,
  maxBillableInputTokens: 200000,
  maxInputUtf8Bytes: 180000,
  pricingVersion: 'openai-standard-public-2026-10-22',
  pricingSource: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
  inputUsdPerMillion: 2,
  cacheWriteUsdPerMillion: 2.5,
  outputUsdPerMillion: 10,
  maxCases: 6,
  maxCalls: 18,
  requestedCapE8Usd: '1000000000',
  compileReuse: false,
  directAnswer: false,
  cacheLifetimeOverride: null,
  productionStructuredPathEnabled: false,
})
export const FUTURE_SOL_EVALUATION_PROFILE = Object.freeze({
  ...SOL_EVALUATION_PROFILE,
  schema: 'torchiko-sol-future-unexecutable-v1',
  maxCases: 24,
  maxCalls: 72,
  requestedCapE8Usd: '4000000000',
  executable: false,
})
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const exact = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Object required')
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    'Unexpected or missing generation fields',
  )
}
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

export function validateGenerationCases(cases) {
  assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 24)
  const ids = new Set()
  for (const row of cases) {
    exact(row, ['caseId', 'fixtureId', 'fixtureSha256', 'question', 'clock', 'timeZone'])
    assert.ok(
      typeof row.caseId === 'string' &&
        /^[a-z0-9:_-]{1,120}$/u.test(row.caseId) &&
        !ids.has(row.caseId),
    )
    ids.add(row.caseId)
    assert.ok(typeof row.fixtureId === 'string' && /^[a-z0-9_-]{1,120}$/u.test(row.fixtureId))
    assert.ok(digest(row.fixtureSha256))
    assert.ok(
      typeof row.question === 'string' && row.question.trim() && row.question.length <= 16000,
    )
    assert.ok(
      typeof row.clock === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/u.test(row.clock) &&
        Number.isFinite(Date.parse(row.clock)),
    )
    assert.ok(typeof row.timeZone === 'string')
    new Intl.DateTimeFormat('en-US', { timeZone: row.timeZone }).format(new Date(row.clock))
  }
  return cases
}

/** Three distinct physical calls per pair. Baseline never consumes the planner response. */
export function prepareSolEvaluation(cases) {
  validateGenerationCases(cases)
  const calls = cases.flatMap((row, i) => {
    const arms = i % 2 ? ['BASELINE', 'STRUCTURED'] : ['STRUCTURED', 'BASELINE']
    return arms.flatMap((arm) =>
      (arm === 'STRUCTURED' ? ['PLANNER', 'ANSWER'] : ['ANSWER']).map((stage) => {
        const maxOutputTokens = stage === 'PLANNER' ? 1024 : 2048
        // Dearest registered input partition (cache write), full registered 200k bound.
        const reserveE8Usd = (50000000n + BigInt(maxOutputTokens) * 1000n).toString()
        return {
          id: `${row.caseId}:${arm.toLowerCase()}:${stage.toLowerCase()}`,
          caseId: row.caseId,
          arm,
          stage,
          fixtureSha256: row.fixtureSha256,
          questionSha256: sha256(row.question),
          maxOutputTokens,
          reserveE8Usd,
        }
      }),
    )
  })
  const total = calls.reduce((sum, row) => sum + BigInt(row.reserveE8Usd), 0n)
  assert.ok(total <= BigInt(FUTURE_SOL_EVALUATION_PROFILE.requestedCapE8Usd))
  return {
    schema: 'torchiko-sol-offline-plan-v1',
    status: 'PROPOSED_REQUIRES_USER_BUDGET',
    profile: cases.length <= 6 ? SOL_EVALUATION_PROFILE : FUTURE_SOL_EVALUATION_PROFILE,
    generationCases: structuredClone(cases),
    calls,
    generationCasesSha256: sha256(JSON.stringify(cases)),
    maximumReservedE8Usd: total.toString(),
    requestedCapE8Usd: cases.length <= 6 ? '1000000000' : '4000000000',
    providerCalls: 0,
    stopRules: [
      'FIRST_TRANSPORT_OR_PROVIDER_FAILURE',
      'FIRST_INCOMPLETE_OR_INVALID_USAGE',
      'FIRST_SOURCE_ROUTE_OR_REQUEST_DRIFT',
      'FIRST_REQUIRED_FACT_OR_SCOPE_FAILURE',
      'NO_RETRY_NO_REOPEN_STOPPED_JOURNAL',
      'RESERVE_BEFORE_EVERY_DISPATCH',
      'NO_UNAPPROVED_EXTRA_CALLS_OR_MODEL_GRADER',
      'EXPIRE_AFTER_120_MINUTES',
    ],
  }
}

export function sealSolEvaluation({ repository, head, plan, gateReceipt, sourceFiles, output }) {
  assert.ok(isAbsolute(repository) && isAbsolute(output) && !existsSync(output))
  assert.ok(/^[a-f0-9]{40}$/u.test(head))
  const git = (...args) =>
    execFileSync('git', ['--no-optional-locks', '-C', repository, ...args], {
      encoding: 'utf8',
    }).trim()
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('status', '--porcelain'), '', 'Clean exact-head candidate required')
  assert.deepEqual(prepareSolEvaluation(plan.generationCases), plan)
  exact(gateReceipt, ['file', 'sha256'])
  assert.ok(isAbsolute(gateReceipt.file) && digest(gateReceipt.sha256))
  assert.equal(sha256(readFileSync(gateReceipt.file)), gateReceipt.sha256)
  const proof = JSON.parse(readFileSync(gateReceipt.file, 'utf8'))
  const gateDir = dirname(gateReceipt.file)
  assert.equal(
    existsSync(join(gateDir, 'STOPPED.json')),
    false,
    'Failed or interrupted gates cannot seal',
  )
  const before = JSON.parse(readFileSync(join(gateDir, 'BEFORE-SOURCE.json'), 'utf8'))
  const commands = JSON.parse(readFileSync(join(gateDir, 'COMMANDS.json'), 'utf8')).commands
  assert.equal(before.head, head)
  assert.equal(before.gitStatusPorcelain, '')
  assert.equal(proof.sourceUnchanged, true)
  assert.equal(proof.sourceSha256, before.sha256)
  const expectedCommands = JSON.parse(
    readFileSync(new URL('./guest-query-evaluation-gate-inventory.json', import.meta.url), 'utf8'),
  )
  assert.equal(
    sha256(JSON.stringify(expectedCommands)),
    '399d7c8ff0fb630971b718bcfbdbd1d457f63db98513bc98f4feb94df87c7512',
  )
  assert.deepEqual(commands, expectedCommands, 'Reviewed fifteen-gate inventory and argv required')
  assert.equal(commands.length, 15)
  assert.equal(new Set(commands.map((row) => row.id)).size, 15)
  assert.deepEqual(
    proof.gates,
    commands.map((row) => row.id),
  )
  const gateFiles = []
  for (const command of commands) {
    const name = command.id.replaceAll(':', '-')
    const resultPath = join(gateDir, `${name}-RESULT.json`)
    const afterPath = join(gateDir, `${name}-AFTER-SOURCE.json`)
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    const after = JSON.parse(readFileSync(afterPath, 'utf8'))
    assert.equal(result.id, command.id)
    assert.equal(result.exit, 0)
    assert.equal(result.sourceUnchanged, true)
    assert.equal(result.beforeSha256, before.sha256)
    assert.equal(result.afterSha256, before.sha256)
    assert.deepEqual(result.requestedCommand, command.argv)
    assert.deepEqual(after, before)
    assert.ok(!result.failures?.length)
    assert.ok(
      !result.counts || (result.counts.success === true && result.counts.numFailedTests === 0),
    )
    gateFiles.push(
      { file: resultPath, sha256: sha256(readFileSync(resultPath)) },
      { file: afterPath, sha256: sha256(readFileSync(afterPath)) },
    )
  }
  assert.ok(Array.isArray(before.files) && before.files.length > 0)
  assert.equal(sha256(JSON.stringify(before.files)), before.sha256)
  for (const row of before.files) {
    assert.ok(!isAbsolute(row.file) && !row.file.split(/[\\/]/u).includes('..'))
    assert.equal(sha256(readFileSync(resolve(repository, row.file))), row.sha256)
  }
  assert.ok(Array.isArray(sourceFiles) && sourceFiles.length > 0)
  const files = sourceFiles.map((file) => {
    assert.ok(typeof file === 'string' && !isAbsolute(file) && !file.split(/[\\/]/u).includes('..'))
    assert.ok(
      !/(?:^|[\\/])(?:\.env[^\\/]*|credentials?|secrets?|gold|expected-facts)(?:[.\\/]|$)/iu.test(
        file,
      ),
    )
    const absolute = resolve(repository, file)
    return { file, sha256: sha256(readFileSync(absolute)) }
  })
  const seal = {
    schema: 'torchiko-sol-driver-seal-v1',
    createdAt: new Date().toISOString(),
    repository,
    head,
    planSha256: sha256(JSON.stringify(plan)),
    gateReceipt,
    gateFiles,
    files,
    executionAuthority: 'NONE_USER_BUDGET_REQUIRED',
    providerCalls: 0,
  }
  writeFileSync(output, JSON.stringify(seal, null, 2) + '\n', { flag: 'wx' })
  return seal
}

/** Validates exact captured SDK bytes before any later approved transport may use them. */
export function validateSolSdkRequest(call, request, expectedBinding) {
  const allowed = new Set([
    'model',
    'instructions',
    'input',
    'prompt_cache_options',
    'max_output_tokens',
    'reasoning',
    'store',
    'stream',
    'service_tier',
  ])
  assert.ok(
    Object.keys(request).every((key) => allowed.has(key)),
    'Unexpected SDK request field',
  )
  assert.equal(request.model, 'gpt-6.1-sol')
  assert.deepEqual(request.reasoning, { effort: 'low' })
  assert.equal(request.max_output_tokens, call.maxOutputTokens)
  assert.equal(request.store, false)
  assert.ok(request.stream === undefined || request.stream === false)
  // The isolated evaluation SDK boundary explicitly pins standard service.
  assert.equal(request.service_tier, 'default')
  if (request.prompt_cache_options !== undefined)
    assert.deepEqual(request.prompt_cache_options, { mode: 'explicit' })
  assert.equal(request.temperature, undefined)
  assert.equal(request.tools, undefined)
  assert.equal(request.prompt_cache_retention, undefined)
  assert.ok(Array.isArray(request.input) && request.input.length > 0)
  const userMessages = request.input.filter((row) => row.role === 'user')
  assert.equal(userMessages.length, 1)
  assert.equal(typeof userMessages[0].content, 'string')
  assert.equal(sha256(userMessages[0].content), call.questionSha256)
  const binding = {
    sdkRequestSha256: sha256(JSON.stringify(request)),
    sdkRequestUtf8Bytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
    wireBoundary: 'SDK_PARAMS_JSON_NOT_OBSERVED_HTTP',
  }
  if (expectedBinding) assert.deepEqual(binding, expectedBinding, 'Captured request bytes drift')
  assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') <= 180000)
  return binding
}

/** Append-only offline rehearsal; intentionally cannot dispatch or manufacture authorization. */
export function createOfflineSolJournal(plan, output) {
  assert.ok(isAbsolute(output) && !existsSync(output))
  assert.deepEqual(prepareSolEvaluation(plan.generationCases), plan)
  const state = {
    schema: 'torchiko-sol-offline-journal-v1',
    providerCalls: 0,
    planSha256: sha256(JSON.stringify(plan)),
    index: 0,
    reservedE8Usd: '0',
    stopped: false,
  }
  const append = (entry) => writeFileSync(output, JSON.stringify(entry) + '\n', { flag: 'a' })
  writeFileSync(output, JSON.stringify({ ...state, event: 'OFFLINE_OPEN' }) + '\n', { flag: 'wx' })
  return {
    state,
    reserve(callId, request) {
      assert.equal(state.stopped, false, 'Stopped journals cannot reopen')
      const call = plan.calls[state.index]
      assert.ok(call && call.id === callId, 'Exact call sequence required')
      try {
        const binding = validateSolSdkRequest(call, request)
        const total = BigInt(state.reservedE8Usd) + BigInt(call.reserveE8Usd)
        assert.ok(total <= BigInt(plan.maximumReservedE8Usd))
        state.reservedE8Usd = total.toString()
        state.index++
        append({ event: 'OFFLINE_RESERVE', callId, reserveE8Usd: call.reserveE8Usd, ...binding })
        return binding
      } catch (error) {
        state.stopped = true
        append({ event: 'OFFLINE_STOP', callId, reason: error.message })
        throw error
      }
    },
    stop(reason) {
      assert.equal(state.stopped, false)
      state.stopped = true
      append({ event: 'OFFLINE_STOP', reason })
    },
  }
}
