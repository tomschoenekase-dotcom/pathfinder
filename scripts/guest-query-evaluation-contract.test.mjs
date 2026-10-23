import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  SOL_EVALUATION_PROFILE,
  sha256,
  prepareSolEvaluation,
  validateGenerationCases,
  validateSolSdkRequest,
  createOfflineSolJournal,
  sealSolEvaluation,
} from './guest-query-evaluation-contract.mjs'

const row = (i) => ({
  caseId: `case-${i}`,
  fixtureId: 'fictional-small',
  fixtureSha256: 'a'.repeat(64),
  question: 'What does Moon Ride cost?',
  clock: '2026-10-24T16:30:00.000Z',
  timeZone: 'America/Chicago',
})
const sdk = (call) => ({
  model: 'gpt-6.1-sol',
  service_tier: 'default',
  input: [{ role: 'user', content: row(0).question }],
  max_output_tokens: call.maxOutputTokens,
  reasoning: { effort: 'low' },
  store: false,
})
const temporary = () => mkdtempSync(join(tmpdir(), 'torchiko-sol-offline-'))

test('six paired cases reserve exact $9.3072 for eighteen calls under $10 first window', () => {
  const plan = prepareSolEvaluation(Array.from({ length: 6 }, (_, i) => row(i)))
  assert.equal(plan.calls.length, 18)
  assert.equal(plan.maximumReservedE8Usd, '930720000')
  assert.equal(plan.providerCalls, 0)
  assert.equal(plan.profile.reasoningEffort, 'low')
  assert.equal(plan.calls.filter((call) => call.stage === 'PLANNER').length, 6)
  assert.equal(plan.calls.filter((call) => call.arm === 'BASELINE').length, 6)
  assert.deepEqual(
    plan.calls.slice(0, 3).map((call) => call.arm),
    ['STRUCTURED', 'STRUCTURED', 'BASELINE'],
  )
  assert.deepEqual(
    plan.calls.slice(3, 6).map((call) => call.arm),
    ['BASELINE', 'STRUCTURED', 'STRUCTURED'],
  )
})

test('full twenty-four paired cases retain separate exact $37.2288 offline proposal', () => {
  const plan = prepareSolEvaluation(Array.from({ length: 24 }, (_, i) => row(i)))
  assert.equal(plan.calls.length, 72)
  assert.equal(plan.maximumReservedE8Usd, '3722880000')
  assert.equal(SOL_EVALUATION_PROFILE.compileReuse, false)
  assert.equal(SOL_EVALUATION_PROFILE.productionStructuredPathEnabled, false)
})

test('generation cases reject Gold, duplicate identities, malformed clocks and expanded inputs', () => {
  for (const changed of [
    { ...row(0), expectedFacts: ['secret gold'] },
    { ...row(0), rubric: {} },
    { ...row(0), clock: 'today' },
    { ...row(0), fixtureSha256: 'unbound' },
    { ...row(0), timeZone: 'not-a-zone' },
  ])
    assert.throws(() => validateGenerationCases([changed]))
  assert.throws(() => validateGenerationCases([row(0), row(0)]))
})

test('SDK admission binds question, model, effort, caps, all keys and captured byte digest', () => {
  const call = prepareSolEvaluation([row(0)]).calls[0],
    request = sdk(call)
  const binding = validateSolSdkRequest(call, request)
  assert.deepEqual(validateSolSdkRequest(call, request, binding), binding)
  for (const changed of [
    { ...request, model: 'gpt-6-luna' },
    { ...request, reasoning: { effort: 'minimal' } },
    { ...request, service_tier: 'fast' },
    { ...request, service_tier: undefined },
    { ...request, prompt_cache_options: { mode: 'explicit', ttl: '12h' } },
    { ...request, max_output_tokens: 2048 },
    { ...request, metadata: { bypass: true } },
    { ...request, tools: [] },
    { ...request, input: [{ role: 'user', content: 'Different question' }] },
    { ...request, input: [...request.input, ...request.input] },
    { ...request, prompt_cache_retention: '12h' },
    { ...request, stream: true },
  ])
    assert.throws(() => validateSolSdkRequest(call, changed))
  assert.throws(() =>
    validateSolSdkRequest(call, { ...request, instructions: 'Changed prompt' }, binding),
  )
})

test('offline reservation is append-only and stopped journal cannot dispatch, retry or reopen', () => {
  const plan = prepareSolEvaluation([row(0)]),
    out = join(temporary(), 'journal.jsonl')
  const journal = createOfflineSolJournal(plan, out)
  journal.reserve(plan.calls[0].id, sdk(plan.calls[0]))
  assert.equal(journal.state.reservedE8Usd, '51024000')
  journal.stop('LOCAL_GOLD_REQUIRED_FACT_FAILED')
  assert.throws(() => journal.reserve(plan.calls[1].id, sdk(plan.calls[1])))
  assert.throws(() => createOfflineSolJournal(plan, out))
  assert.match(readFileSync(out, 'utf8'), /LOCAL_GOLD_REQUIRED_FACT_FAILED/u)
  assert.equal(journal.state.providerCalls, 0)
})

function gateFixture() {
  const repository = temporary(),
    gates = join(repository, 'gates')
  mkdirSync(gates)
  writeFileSync(join(repository, 'fixture.ts'), 'export const fixture = true\n')
  const git = (...args) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
  git('init')
  git('add', 'fixture.ts')
  git(
    '-c',
    'user.name=Offline Fixture',
    '-c',
    'user.email=fixture@fixture.invalid',
    'commit',
    '-m',
    'Fictional offline seal test',
  )
  // Gate artifacts remain outside the tested repository.
  const external = temporary()
  const head = git('rev-parse', 'HEAD'),
    files = [{ file: 'fixture.ts', sha256: sha256(readFileSync(join(repository, 'fixture.ts'))) }]
  const before = { head, gitStatusPorcelain: '', files, sha256: sha256(JSON.stringify(files)) }
  const commands = JSON.parse(
    readFileSync(new URL('./guest-query-evaluation-gate-inventory.json', import.meta.url), 'utf8'),
  )
  writeFileSync(join(external, 'BEFORE-SOURCE.json'), JSON.stringify(before))
  writeFileSync(join(external, 'COMMANDS.json'), JSON.stringify({ commands }))
  for (const command of commands) {
    writeFileSync(
      join(external, `${command.id.replaceAll(':', '-')}-AFTER-SOURCE.json`),
      JSON.stringify(before),
    )
    writeFileSync(
      join(external, `${command.id.replaceAll(':', '-')}-RESULT.json`),
      JSON.stringify({
        id: command.id,
        exit: 0,
        sourceUnchanged: true,
        beforeSha256: before.sha256,
        afterSha256: before.sha256,
        requestedCommand: command.argv,
      }),
    )
  }
  const proof = {
    gates: commands.map((row) => row.id),
    sourceSha256: before.sha256,
    sourceUnchanged: true,
  }
  const file = join(external, 'ALL-GATES-PASS.json')
  writeFileSync(file, JSON.stringify(proof))
  return {
    repository,
    head,
    plan: prepareSolEvaluation([row(0)]),
    gateReceipt: { file, sha256: sha256(readFileSync(file)) },
    sourceFiles: ['fixture.ts'],
    output: join(external, 'seal.json'),
    external,
  }
}

test('seal refuses arbitrary receipt, mismatched head, failed gate and source-byte drift', () => {
  const valid = gateFixture()
  const { external, ...input } = valid
  assert.equal(sealSolEvaluation(input).executionAuthority, 'NONE_USER_BUDGET_REQUIRED')
  for (const failure of ['ARBITRARY', 'HEAD', 'FAILED', 'DRIFT']) {
    const fixture = gateFixture(),
      { external: out, ...request } = fixture
    if (failure === 'ARBITRARY') {
      writeFileSync(request.gateReceipt.file, '{}')
      request.gateReceipt.sha256 = sha256('{}')
    }
    if (failure === 'HEAD') request.head = '0'.repeat(40)
    if (failure === 'FAILED') writeFileSync(join(out, 'STOPPED.json'), '{}')
    if (failure === 'DRIFT') writeFileSync(join(request.repository, 'fixture.ts'), 'changed\n')
    assert.throws(() => sealSolEvaluation(request))
  }
})
