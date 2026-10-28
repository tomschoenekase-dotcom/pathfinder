import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sha256,
  prepareSolEvaluation,
  validateSolSdkRequest,
} from './guest-query-evaluation-contract.mjs'
import { torchikoEvaluationEnvironment } from './with-torchiko-openai.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const pinned = (ref) => {
  assert.ok(isAbsolute(ref.file))
  const bytes = readFileSync(ref.file)
  assert.equal(sha256(bytes), ref.sha256)
  return JSON.parse(bytes)
}
const put = (file, value) => {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  return { file, sha256: sha256(readFileSync(file)) }
}
const git = (...args) =>
  execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8' }).trim()

export function safeSolFailure(error) {
  return {
    category:
      error?.name === 'AssertionError' ? 'LOCAL_CONTRACT_FAILED' : 'PROVIDER_OR_RUNTIME_FAILED',
    status:
      Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : null,
  }
}

export function claimSolWindow({ claimsRoot, authorizationRef, authorization, directory }) {
  assert.ok(
    isAbsolute(claimsRoot) && isAbsolute(directory) && isAbsolute(authorization.runDirectory),
  )
  assert.equal(resolve(directory).toLowerCase(), resolve(authorization.runDirectory).toLowerCase())
  assert.match(authorization.windowId, /^[a-f0-9-]{36}$/u)
  mkdirSync(claimsRoot, { recursive: true })
  const claimDirectory = join(claimsRoot, authorization.windowId)
  const claim = {
    windowId: authorization.windowId,
    authorizationSha256: authorizationRef.sha256,
    runDirectory: resolve(directory).toLowerCase(),
  }
  if (!existsSync(claimDirectory)) {
    mkdirSync(claimDirectory)
    put(join(claimDirectory, 'CLAIM.json'), claim)
  } else assert.deepEqual(read(join(claimDirectory, 'CLAIM.json')), claim, 'Window already claimed')
  assert.equal(existsSync(join(claimDirectory, 'STOPPED.json')), false, 'Approved window stopped')
  const lockFile = join(claimDirectory, 'execution.lock')
  const lock = openSync(lockFile, 'wx')
  return {
    claimDirectory,
    release() {
      closeSync(lock)
      unlinkSync(lockFile)
    },
  }
}

export function stopClaimedSolWindow({ claimsRoot, authorizationRef, directory, failure }) {
  // A failed source/gate check cannot make an already pinned approved window reusable.
  const authorization = pinned(authorizationRef)
  assert.match(authorization.windowId, /^[a-f0-9-]{36}$/u)
  assert.equal(resolve(directory).toLowerCase(), resolve(authorization.runDirectory).toLowerCase())
  const claimDirectory = join(claimsRoot, authorization.windowId)
  if (!existsSync(join(claimDirectory, 'CLAIM.json'))) return false
  const claim = read(join(claimDirectory, 'CLAIM.json'))
  assert.equal(claim.authorizationSha256, authorizationRef.sha256)
  assert.equal(claim.runDirectory, resolve(directory).toLowerCase())
  if (!existsSync(join(claimDirectory, 'STOPPED.json')))
    put(join(claimDirectory, 'STOPPED.json'), { status: 'PREFLIGHT_FIRST_FAILURE_STOP', failure })
  return true
}

export function reconcileSolJournal({ plan, state, events }) {
  assert.ok(Array.isArray(events) && events[0]?.event === 'OPEN')
  assert.deepEqual(events[0].planRef, state.planRef)
  assert.deepEqual(events[0].sealRef, state.sealRef)
  assert.deepEqual(events[0].authorizationRef, state.authorizationRef)
  assert.ok(!events.some((row) => row.event === 'STOP' || row.event === 'COMPLETE'))
  const reserves = events.filter((row) => row.event === 'DISPATCH_RESERVED')
  const starts = events.filter((row) => row.event === 'DISPATCH_STARTED')
  const complete = events.filter((row) => row.event === 'OBSERVED_COMPLETE')
  const pairs = events.filter((row) => row.event === 'AWAITING_LOCAL_GOLD_REVIEW')
  assert.equal(reserves.length, starts.length, 'Unresolved reservation must never redispatch')
  assert.equal(starts.length, complete.length, 'Uncertain provider outcome must never redispatch')
  assert.equal(state.completedCalls, complete.length)
  assert.equal(state.completedPairs, pairs.length)
  assert.equal(state.completedCalls, state.completedPairs * 3)
  let total = 0n
  for (let i = 0; i < reserves.length; i++) {
    const expected = plan.calls[i]
    assert.ok(expected)
    assert.equal(reserves[i].callId, expected.id)
    assert.equal(reserves[i].reserveE8Usd, expected.reserveE8Usd)
    assert.equal(starts[i].callId, expected.id)
    assert.equal(complete[i].callId, expected.id)
    total += BigInt(expected.reserveE8Usd)
  }
  assert.equal(state.reservedE8Usd, total.toString())
  assert.equal(state.waitingForGold?.resultSha256, pairs.at(-1)?.result.sha256)
  return true
}

export function validateSolResponse(response) {
  assert.equal(response.model, 'gpt-6.1-sol')
  assert.equal(response.status, 'completed')
  assert.ok(typeof response.id === 'string' && response.id.length > 0)
  assert.equal(response.service_tier, 'default')
  assert.ok(!response.error && !response.incomplete_details)
  assert.ok(response.output_text === undefined || typeof response.output_text === 'string')
  assert.ok(response.output === undefined || Array.isArray(response.output))
  for (const item of response.output ?? []) {
    assert.equal(typeof item.type, 'string')
    assert.ok(item.content === undefined || Array.isArray(item.content))
    for (const block of item.content ?? []) {
      assert.equal(typeof block.type, 'string')
      assert.ok(block.text === undefined || typeof block.text === 'string')
    }
  }
  const text =
    response.output_text?.trim() ||
    (response.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim()
  assert.ok(
    typeof text === 'string' && text.trim(),
    'Adapter-compatible nonempty response text required',
  )
  const usage = response.usage
  assert.ok(
    usage &&
      Number.isSafeInteger(usage.input_tokens) &&
      usage.input_tokens >= 0 &&
      usage.input_tokens <= 200000,
  )
  assert.ok(
    Number.isSafeInteger(usage.output_tokens) &&
      usage.output_tokens >= 0 &&
      usage.output_tokens <= 2048,
  )
  assert.equal(usage.total_tokens, usage.input_tokens + usage.output_tokens)
  for (const field of ['cached_tokens', 'cache_write_tokens'])
    assert.ok(
      Number.isSafeInteger(usage.input_tokens_details?.[field]) &&
        usage.input_tokens_details[field] >= 0,
    )
  assert.ok(
    usage.input_tokens_details.cached_tokens + usage.input_tokens_details.cache_write_tokens <=
      usage.input_tokens,
  )
  assert.ok(
    Number.isSafeInteger(usage.output_tokens_details?.reasoning_tokens) &&
      usage.output_tokens_details.reasoning_tokens >= 0 &&
      usage.output_tokens_details.reasoning_tokens <= usage.output_tokens,
  )
  assert.ok(!usage.input_tokens_details.cache_write_tokens_details?.ttl_12h_tokens)
  return usage
}

export function validateLocalGoldReview(grade, expected) {
  assert.equal(grade.schema, 'torchiko-sol-local-gold-review-v1')
  assert.equal(grade.caseId, expected.caseId)
  assert.equal(grade.resultSha256, expected.resultSha256)
  assert.equal(grade.pass, true, 'First semantic failure stops the entire window')
  assert.equal(grade.requiredFactsSatisfied, true)
  assert.equal(grade.requiredOmissionsSatisfied, true)
  assert.deepEqual(grade.unsupportedClaims, [])
}

/** Offline child never inherits provider keys or reads the isolated Gold file. */
export function captureSolStage({ config, pnpm, directory }) {
  assert.ok(isAbsolute(pnpm) && existsSync(pnpm) && isAbsolute(directory))
  const configFile = join(directory, 'stage-config.json')
  put(configFile, config)
  const keep = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PNPM_HOME',
  ])
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => keep.has(name.toUpperCase())),
  )
  Object.assign(env, {
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TORCHIKO_SOL_STAGE_CONFIG: configFile,
    TEMP: directory,
    TMP: directory,
    NODE_OPTIONS: '--max-old-space-size=8192',
    TURBO_TELEMETRY_DISABLED: '1',
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture',
    DIRECT_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture',
    CLERK_SECRET_KEY: 'sk_test_pathfinder_unit_tests',
    CLERK_PUBLISHABLE_KEY: 'pk_test_pathfinder_unit_tests',
  })
  const log = openSync(join(directory, 'stage.log'), 'wx')
  try {
    const result = spawnSync(
      process.execPath,
      [
        pnpm,
        '--filter',
        '@pathfinder/api',
        'exec',
        'vitest',
        'run',
        'src/routers/guest-structured-query-evaluation.local.test.ts',
        '--maxWorkers=1',
        '--minWorkers=1',
        '--testNamePattern',
        'runs one sealed provider-dark',
      ],
      { cwd: repo, env, stdio: ['ignore', log, log], timeout: 180000 },
    )
    assert.equal(
      result.status,
      0,
      'Offline router capture/replay failed; stop without provider retry',
    )
  } finally {
    closeSync(log)
  }
  const result = read(config.output)
  assert.equal(result.caseId, config.case.caseId)
  assert.equal(result.providerCalls, 0)
  if (config.phase !== 'FIXTURE') assert.equal(result.sourceSha256, config.case.fixtureSha256)
  return result
}

export function verifySolExecutionPreflight({ planRef, sealRef, authorizationRef }) {
  assert.ok(
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
    'Local Sol evaluation requires an explicit development/test child environment',
  )
  const plan = pinned(planRef),
    seal = pinned(sealRef),
    authorization = pinned(authorizationRef)
  assert.deepEqual(plan, prepareSolEvaluation(plan.generationCases))
  assert.equal(plan.generationCases.length, 6, 'Only the focused six-pair window is executable')
  assert.equal(plan.calls.length, 18)
  assert.equal(plan.requestedCapE8Usd, '1000000000')
  assert.equal(plan.maximumReservedE8Usd, '930720000')
  assert.equal(seal.schema, 'torchiko-sol-driver-seal-v1')
  assert.equal(seal.planSha256, sha256(JSON.stringify(plan)))
  assert.equal(resolve(seal.repository), repo)
  assert.equal(git('rev-parse', 'HEAD'), seal.head)
  assert.equal(git('status', '--porcelain'), '', 'Source changed after exact-head gates')
  for (const ref of [
    ...seal.files.map((row) => ({ file: join(repo, row.file), sha256: row.sha256 })),
    seal.gateReceipt,
    ...seal.gateFiles,
  ]) {
    assert.equal(sha256(readFileSync(ref.file)), ref.sha256)
  }
  const gateDir = dirname(seal.gateReceipt.file)
  assert.equal(existsSync(join(gateDir, 'STOPPED.json')), false)
  const before = read(join(gateDir, 'BEFORE-SOURCE.json')),
    all = pinned(seal.gateReceipt)
  assert.equal(before.head, seal.head)
  assert.equal(before.gitStatusPorcelain, '')
  assert.equal(all.sourceUnchanged, true)
  assert.equal(all.sourceSha256, before.sha256)
  assert.equal(all.gates.length, 15)
  assert.equal(new Set(all.gates).size, 15)
  assert.equal(authorization.schema, 'torchiko-sol-explicit-user-budget-v1')
  assert.equal(authorization.planSha256, planRef.sha256)
  assert.equal(authorization.sealSha256, sealRef.sha256)
  assert.equal(authorization.model, 'gpt-6.1-sol')
  assert.equal(authorization.capE8Usd, '1000000000')
  assert.equal(authorization.maxCalls, 18)
  assert.equal(authorization.explicitUserApproval, true)
  assert.ok(isAbsolute(authorization.runDirectory))
  assert.match(authorization.windowId, /^[a-f0-9-]{36}$/u)
  assert.ok(
    typeof authorization.userApprovalQuote === 'string' && authorization.userApprovalQuote.trim(),
  )
  const start = Date.parse(authorization.authorizedAt),
    end = Date.parse(authorization.expiresAt)
  assert.ok(
    Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 120 * 60000,
  )
  assert.ok(Date.now() >= start && Date.now() < end, 'Budget window is closed')
  return { plan, seal, authorization }
}

/** One pair per invocation; an external local Gold review is required before the next pair. */
export async function executeSolPair({
  planRef,
  sealRef,
  authorizationRef,
  directory,
  pnpm,
  gradeRef,
}) {
  assert.ok(isAbsolute(directory) && isAbsolute(pnpm))
  let preflight
  try {
    preflight = verifySolExecutionPreflight({ planRef, sealRef, authorizationRef })
  } catch (error) {
    try {
      stopClaimedSolWindow({
        claimsRoot: resolve(repo, '../qa/sol-evaluation-window-claims'),
        authorizationRef,
        directory,
        failure: safeSolFailure(error),
      })
    } catch {
      /* Never trust an unpinned authorization merely to find a window. */
    }
    if (existsSync(directory) && !existsSync(join(directory, 'STOPPED.json')))
      put(join(directory, 'STOPPED.json'), {
        status: 'PREFLIGHT_FIRST_FAILURE_STOP',
        failure: safeSolFailure(error),
      })
    throw error
  }
  const window = claimSolWindow({
    claimsRoot: resolve(repo, '../qa/sol-evaluation-window-claims'),
    authorizationRef,
    authorization: preflight.authorization,
    directory,
  })
  if (!existsSync(directory)) mkdirSync(directory)
  assert.equal(existsSync(join(directory, 'STOPPED.json')), false, 'Never reopen a stopped journal')
  const journalFile = join(window.claimDirectory, 'journal.jsonl')
  const append = (entry) => {
    const fd = openSync(journalFile, 'a')
    try {
      writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  try {
    let state
    const stateFile = join(window.claimDirectory, 'state.json')
    if (!existsSync(stateFile)) {
      assert.equal(existsSync(journalFile), false)
      state = {
        schema: 'torchiko-sol-paired-journal-state-v1',
        planRef,
        sealRef,
        authorizationRef,
        completedPairs: 0,
        completedCalls: 0,
        reservedE8Usd: '0',
        waitingForGold: null,
      }
      append({ event: 'OPEN', ...state })
    } else {
      state = read(stateFile)
      assert.deepEqual(state.planRef, planRef)
      assert.deepEqual(state.sealRef, sealRef)
      assert.deepEqual(state.authorizationRef, authorizationRef)
      const events = readFileSync(journalFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      reconcileSolJournal({ plan: preflight.plan, state, events })
      for (const event of events) {
        if (event.event === 'OBSERVED_COMPLETE') pinned(event.rawRef)
        if (event.event === 'AWAITING_LOCAL_GOLD_REVIEW') pinned(event.result)
      }
      assert.ok(
        state.waitingForGold && gradeRef,
        'Previous pair requires isolated local Gold grading',
      )
      const grade = pinned(gradeRef)
      validateLocalGoldReview(grade, state.waitingForGold)
      append({ event: 'LOCAL_GOLD_PASS', gradeRef })
    }
    if (state.completedPairs === 6) {
      const completed = put(join(directory, 'COMPLETE.json'), {
        status: 'SIX_PAIRS_LOCAL_GOLD_PASS',
        completedCalls: state.completedCalls,
        reservedE8Usd: state.reservedE8Usd,
        planRef,
        sealRef,
        authorizationRef,
      })
      append({ event: 'COMPLETE', completed })
      return { status: 'SIX_PAIRS_LOCAL_GOLD_PASS', completed }
    }
    assert.ok(state.completedPairs < 6, 'Approved cohort already complete')
    const row = preflight.plan.generationCases[state.completedPairs]
    const calls = preflight.plan.calls.filter((call) => call.caseId === row.caseId)
    const pairDir = join(directory, `pair-${state.completedPairs + 1}`)
    mkdirSync(pairDir)
    const replayByArm = { STRUCTURED: [], BASELINE: [] },
      outputs = []
    let underlyingSourceSha256 = null
    const require = createRequire(join(repo, 'packages/db/package.json'))
    const { require: requireTypescriptOwner } = require('tsx/cjs/api')
    const importedOwner = requireTypescriptOwner(
      join(repo, 'packages/ai/src/openai-text.ts'),
      import.meta.url,
    )
    const createOwnerTextResponse =
      importedOwner.createOpenAiTextResponse ?? importedOwner.default?.createOpenAiTextResponse
    assert.equal(typeof createOwnerTextResponse, 'function')
    // The scoped launcher selects credentials; only the approved provider owner initializes SDK clients.
    const childEnvironment = torchikoEvaluationEnvironment(process.env)
    assert.equal(process.env.OPENAI_API_KEY, childEnvironment.OPENAI_API_KEY)
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]
      verifySolExecutionPreflight({ planRef, sealRef, authorizationRef })
      const step = join(pairDir, `call-${i + 1}`)
      mkdirSync(step)
      const config = {
        schema: 'torchiko-sol-router-stage-v1',
        case: row,
        arm: call.arm,
        phase: 'CAPTURE',
        fixtureModules: Number(row.fixtureId.split('-').at(-1)),
        replays: replayByArm[call.arm],
        output: join(step, 'capture.json'),
      }
      const capture = captureSolStage({ config, pnpm, directory: step })
      assert.equal(capture.transportProfile, 'EVALUATION_EXPLICIT_STANDARD_TIER_V1')
      assert.ok(
        !capture.queryTrace?.some(
          (row) => row.status === 'BASELINE' && row.reason === 'INVALID_PLAN_OR_EVIDENCE',
        ),
        'Invalid planner or whole-source failure stops before another provider call',
      )
      assert.match(capture.underlyingSourceSha256, /^[a-f0-9]{64}$/u)
      if (underlyingSourceSha256 === null) underlyingSourceSha256 = capture.underlyingSourceSha256
      else
        assert.equal(
          capture.underlyingSourceSha256,
          underlyingSourceSha256,
          'Paired underlying content differs',
        )
      const index = replayByArm[call.arm].length,
        request = capture.requests[index]
      assert.equal(capture.requests.length, index + 1)
      assert.ok(capture.gatewayCalls.every((row) => row.maxAttempts === 1))
      const binding = validateSolSdkRequest(call, request)
      assert.ok(
        Array.isArray(capture.adapterInputs) &&
          capture.adapterInputs.length === capture.requests.length,
      )
      const capturedAdapter = capture.adapterInputs[index]
      const { adapterInputsSha256, ...adapterInput } = capturedAdapter
      assert.equal(sha256(JSON.stringify(adapterInput)), adapterInputsSha256)
      assert.equal(adapterInput.maxOutputTokens, call.maxOutputTokens)
      assert.equal(adapterInput.timeoutMs, 20000)
      const total = BigInt(state.reservedE8Usd) + BigInt(call.reserveE8Usd)
      assert.ok(total <= BigInt(preflight.authorization.capE8Usd))
      state.reservedE8Usd = total.toString()
      append({
        event: 'DISPATCH_RESERVED',
        callId: call.id,
        reserveE8Usd: call.reserveE8Usd,
        ...binding,
      })
      // The existing provider adapter rebuilds exact captured bytes; no raw SDK escape exists here.
      let rawRef = null,
        sdkTransportMs = null
      await createOwnerTextResponse({
        ...adapterInput,
        localSolEvaluation: {
          profile: 'LOCAL_SOL_EVALUATION_V1',
          callId: `${preflight.authorization.windowId}:${call.id}`,
          expectedSdkRequestSha256: binding.sdkRequestSha256,
          expectedAdapterInputsSha256: adapterInputsSha256,
          admitReservedDispatch: async (ownerBinding) => {
            verifySolExecutionPreflight({ planRef, sealRef, authorizationRef })
            assert.equal(ownerBinding.callId, `${preflight.authorization.windowId}:${call.id}`)
            assert.equal(existsSync(join(window.claimDirectory, 'STOPPED.json')), false)
            assert.equal(ownerBinding.sdkRequestSha256, binding.sdkRequestSha256)
            assert.equal(ownerBinding.adapterInputsSha256, adapterInputsSha256)
            assert.equal(ownerBinding.reservedE8Usd, call.reserveE8Usd)
            const events = readFileSync(journalFile, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
            const reserved = events.filter((row) => row.event === 'DISPATCH_RESERVED').at(-1)
            assert.equal(reserved.callId, call.id)
            assert.equal(reserved.sdkRequestSha256, binding.sdkRequestSha256)
            assert.equal(reserved.reserveE8Usd, call.reserveE8Usd)
            assert.equal(
              events.filter((row) => row.event === 'DISPATCH_STARTED' && row.callId === call.id)
                .length,
              0,
            )
            append({ event: 'DISPATCH_STARTED', callId: call.id, adapterInputsSha256 })
            return {
              ...ownerBinding,
              reservationId: `${preflight.authorization.windowId}:${call.id}`,
              attemptNumber: 1,
              dispatchRecorded: true,
            }
          },
          observeRawResponse: async (observation) => {
            assert.equal(observation.callId, `${preflight.authorization.windowId}:${call.id}`)
            assert.equal(observation.sdkRequestSha256, binding.sdkRequestSha256)
            assert.equal(observation.adapterInputsSha256, adapterInputsSha256)
            rawRef = put(join(step, 'response.json'), {
              requestSha256: binding.sdkRequestSha256,
              adapterInputsSha256,
              response: observation.rawResponse,
            })
            sdkTransportMs = observation.sdkTransportMs
            assert.equal(
              sha256(JSON.stringify(observation.rawResponse)),
              observation.rawResponseSha256,
            )
            validateSolResponse(observation.rawResponse)
            assert.ok(observation.rawResponse.usage.output_tokens <= call.maxOutputTokens)
            return {
              callId: observation.callId,
              sdkRequestSha256: binding.sdkRequestSha256,
              rawResponseSha256: observation.rawResponseSha256,
              persisted: true,
            }
          },
        },
      })
      assert.ok(rawRef && sdkTransportMs !== null)
      const response = pinned(rawRef).response
      validateSolResponse(response)
      assert.ok(response.usage.output_tokens <= call.maxOutputTokens)
      const usage = response.usage,
        reads = BigInt(usage.input_tokens_details.cached_tokens),
        writes = BigInt(usage.input_tokens_details.cache_write_tokens)
      const observedCostE8Usd = (
        (BigInt(usage.input_tokens) - reads - writes) * 200n +
        writes * 250n +
        reads * 10n +
        BigInt(usage.output_tokens) * 1000n
      ).toString()
      append({
        event: 'OBSERVED_COMPLETE',
        callId: call.id,
        rawRef,
        usage,
        observedCostE8Usd,
        sdkTransportMs,
        latencyClass:
          'PHYSICAL_SDK_CALL_MONOTONIC_ELAPSED_INCLUDES_SDK_AND_TRANSPORT_NOT_PROVIDER_COMPUTE_ONLY',
      })
      replayByArm[call.arm].push(pinned(rawRef))
      state.completedCalls++
    }
    for (const arm of ['STRUCTURED', 'BASELINE']) {
      const step = join(pairDir, `${arm.toLowerCase()}-complete`)
      mkdirSync(step)
      const config = {
        schema: 'torchiko-sol-router-stage-v1',
        case: row,
        arm,
        phase: 'REPLAY',
        fixtureModules: Number(row.fixtureId.split('-').at(-1)),
        replays: replayByArm[arm],
        output: join(step, 'complete.json'),
      }
      const final = captureSolStage({ config, pnpm, directory: step })
      assert.equal(final.underlyingSourceSha256, underlyingSourceSha256)
      assert.equal(final.requests.length, replayByArm[arm].length)
      assert.ok(
        final.metadata?.answerEvidence,
        'Complete observed answer must replay through actual router evidence',
      )
      outputs.push({
        arm,
        routeClass:
          arm === 'BASELINE'
            ? 'FULL_GUIDE_BASELINE'
            : final.metadata.answerEvidence.sources.some(
                  (source) =>
                    source.kind === 'VENUE_PROFILE' && JSON.parse(source.snapshot).structuredQuery,
                )
              ? 'STRUCTURED'
              : 'FULL_GUIDE_FALLBACK',
        result: { file: config.output, sha256: sha256(readFileSync(config.output)) },
      })
    }
    const result = put(join(pairDir, 'PAIR-RESULT.json'), {
      caseId: row.caseId,
      underlyingSourceSha256,
      outputs,
      status: 'AWAITING_LOCAL_GOLD_REVIEW',
      measuredTransport: true,
      automaticSemanticGrade: false,
    })
    state.completedPairs++
    state.waitingForGold = { caseId: row.caseId, resultSha256: result.sha256 }
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
    append({ event: 'AWAITING_LOCAL_GOLD_REVIEW', result })
    return { status: 'AWAITING_LOCAL_GOLD_REVIEW', result, completedCalls: state.completedCalls }
  } catch (error) {
    if (!existsSync(join(directory, 'STOPPED.json')))
      put(join(directory, 'STOPPED.json'), {
        status: 'FIRST_FAILURE_STOP',
        failure: safeSolFailure(error),
      })
    if (!existsSync(join(window.claimDirectory, 'STOPPED.json')))
      put(join(window.claimDirectory, 'STOPPED.json'), {
        status: 'FIRST_FAILURE_STOP',
        failure: safeSolFailure(error),
      })
    append({ event: 'STOP', failure: safeSolFailure(error) })
    throw error
  } finally {
    window.release()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, configFile, configHash] = process.argv.slice(2)
  assert.equal(mode, '--execute-root-approved')
  const config = pinned({ file: resolve(configFile), sha256: configHash })
  executeSolPair(config)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify(safeSolFailure(error)))
      process.exitCode = 1
    })
}

/** Review sheet for browser-captured answers; this path never invokes the paid driver. */
export function renderVenueAnswerReview(result) {
  const cell = (value) =>
    String(value ?? '')
      .replaceAll('|', '\\|')
      .replace(/[\r\n]+/gu, ' ')
      .replaceAll('<', '&lt;')
  const lines = [
    '# Live guide answer review',
    '',
    `Status: ${result.status}. Automatic grades do not establish a venue gate without ledger review.`,
    '',
    '| Question | Grade | Answer | Expected fact | Review reason | Evidence |',
    '|---|---|---|---|---|---|',
  ]
  const rows = result.questions
    ? result.questions.map(
        (question) =>
          result.answers.find((row) => row.question.id === question.id) || {
            question,
            answer: 'Not run',
            screenshot: null,
            grade: {
              status: 'needs-human',
              reasons: [
                'No live answer captured; offline presence checks do not prove visitor testing',
              ],
            },
          },
      )
    : result.answers
  if (result.precheck)
    lines.splice(
      4,
      0,
      `Offline precheck: ${result.precheck.status}. Missing facts: ${cell(
        result.precheck.checks
          .flatMap((check) => check.missing)
          .map((item) => item.id + ': ' + item.fact)
          .join('; ') || 'none',
      )}`,
      '',
    )
  for (const row of rows)
    lines.push(
      `| ${cell(row.question.id + ': ' + row.question.question)} | ${row.grade.status} | ${cell(row.answer)} | ${cell(row.question.expect.map((expected) => expected.fact).join('; '))} | ${cell(row.grade.reasons.join('; '))} | ${row.screenshot ? `[Screenshot](${cell(row.screenshot.replaceAll('\\', '/'))})` : 'No screenshot'} |`,
    )
  return lines.join('\n') + '\n'
}
