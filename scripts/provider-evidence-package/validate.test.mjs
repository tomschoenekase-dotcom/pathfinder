import assert from 'node:assert/strict'
import test from 'node:test'

import { validateProviderEvidencePackage } from './validate-lib.mjs'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const START = '2026-09-01T01:00:00Z'
const END = '2026-09-01T01:05:00Z'

function makeCase(caseKey, runKey, extra = {}) {
  return {
    caseKey,
    runKey,
    outcome: 'PASS',
    responseSha256: HASH_C,
    responseBytes: 200,
    inputTokens: 50,
    outputTokens: 80,
    latencyMs: 800,
    ttftMs: 200,
    observedUsd: 0.001,
    humanReviewReference: `private-review-${caseKey}`,
    grounded: true,
    safeFallback: false,
    ...extra,
  }
}

function makeRun(runKey, observedUsd, corpusSha256 = HASH_B, provider = 'OPENAI') {
  return {
    runKey,
    provider,
    model: provider === 'OPENAI' ? 'reviewed-openai-model' : 'reviewed-anthropic-model',
    promptVersionSha256: HASH_A,
    corpusSha256,
    startedAt: START,
    completedAt: END,
    reservedUsd: observedUsd,
    observedUsd,
    providerCalls: true,
    customerData: false,
    evidenceReference: `private-run-${runKey}`,
  }
}

function validPackage() {
  const languages = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'ja', 'ko', 'pt', 'zh']
  const multilingualCases = languages.flatMap((language) =>
    [1, 2].map((number) =>
      makeCase(`${language}-case-${number}`, 'multilingual-run', { language }),
    ),
  )
  const goldenCases = Array.from({ length: 100 }, (_, index) =>
    makeCase(`golden-case-${String(index + 1).padStart(3, '0')}`, 'golden-run'),
  )
  return {
    schemaVersion: 1,
    packageId: 'provider-review-package',
    syntheticVenue: true,
    customerData: false,
    targetEnvironment: 'railway-staging',
    release: {
      revision: '1'.repeat(40),
      origin: 'https://staging.example.test',
    },
    scopes: ['VIS-02', 'VIS-04', 'VIS-05', 'PERF-01', 'BLD-05', 'AI-01'],
    authorization: {
      status: 'APPROVED',
      stagingOnly: true,
      approverReference: 'private-founder-approval',
      authenticatedAdminSession: true,
      isolatedStagingCredential: true,
      sessionEvidenceReference: 'private-admin-session-proof',
      credentialEvidenceReference: 'private-isolated-credential-proof',
      approvedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-09-01T03:00:00Z',
      maxUsd: 1,
      allowedProviders: ['OPENAI'],
      productionAccess: false,
      customerContact: false,
      routingChange: false,
    },
    runs: [
      makeRun('response-depth-run', 0.003),
      makeRun('multilingual-run', 0.02),
      makeRun('voice-run', 0.02),
      makeRun('performance-run', 0.01),
      makeRun('golden-run', 0.1),
      makeRun('model-diversity-run', 0.02),
    ],
    evidence: {
      responseDepth: {
        samples: ['BRIEF', 'BALANCED', 'DETAILED'].map((depth) =>
          makeCase(`${depth.toLowerCase()}-sample`, 'response-depth-run', {
            depth,
            sameQuestionReference: 'frozen-depth-question',
          }),
        ),
      },
      multilingual: {
        runKey: 'multilingual-run',
        cases: multilingualCases,
      },
      voice: {
        runKey: 'voice-run',
        founderApprovedSyntheticEntitlement: true,
        liveProviderSession: true,
        permissionGranted: true,
        textFallbackVerified: true,
        entitlementEvidenceReference: 'private-entitlement-review',
        transcriptSha256: HASH_C,
        durationSeconds: 30,
        observedUsd: 0.02,
      },
      performance: {
        runKey: 'performance-run',
        founderApprovedSpend: true,
        streaming: true,
        ttftMs: 250,
        totalLatencyMs: 900,
        observedUsd: 0.01,
        authoritativeResponseSha256: HASH_C,
        measurementEvidenceReference: 'private-provider-ttft-report',
      },
      goldenCorpus: {
        runKey: 'golden-run',
        cases: goldenCases,
        humanReviewComplete: true,
        reviewConclusionReference: 'private-golden-review',
      },
      modelDiversity: {
        observations: [
          {
            runKey: 'model-diversity-run',
            caseCount: 20,
            corpusSha256: HASH_B,
            routingChangeAuthorized: false,
            reviewReference: 'private-openai-comparison-review',
          },
        ],
      },
    },
    review: {
      status: 'COMPLETE',
      reviewerReference: 'private-final-review',
      reviewedAt: '2026-09-01T02:00:00Z',
      launchCertified: false,
      routingChangeApproved: false,
    },
  }
}

test('accepts one bounded reviewed staging provider package and returns a secret-free receipt', () => {
  const receipt = validateProviderEvidencePackage(validPackage())
  assert.equal(receipt.runCount, 6)
  assert.deepEqual(receipt.providersObserved, ['OPENAI'])
  assert.equal(receipt.observedUsd, 0.173)
  assert.equal(receipt.launchCertified, false)
  assert.equal(receipt.routingChangeApproved, false)
  assert.equal(JSON.stringify(receipt).includes('private-'), false)
})

test('receipt digest is stable across package property order', () => {
  const value = validPackage()
  const reversed = Object.fromEntries(Object.entries(value).reverse())
  assert.equal(
    validateProviderEvidencePackage(value).packageSha256,
    validateProviderEvidencePackage(reversed).packageSha256,
  )
})

test('rejects pending authorization, unsafe authority, and customer identifiers', () => {
  const pending = validPackage()
  pending.authorization.status = 'PENDING'
  assert.throws(() => validateProviderEvidencePackage(pending), /authorization must be APPROVED/)
  const production = validPackage()
  production.authorization.productionAccess = true
  assert.throws(() => validateProviderEvidencePackage(production), /must deny production/)
  const session = validPackage()
  session.authorization.authenticatedAdminSession = false
  assert.throws(() => validateProviderEvidencePackage(session), /authenticated admin session/)
  const customer = validPackage()
  customer.tenant_id = 'forbidden'
  assert.throws(() => validateProviderEvidencePackage(customer), /retain no customer identifiers/)
})

test('rejects missing scopes and unsafe or ambiguous release origins', () => {
  const missing = validPackage()
  missing.scopes.pop()
  assert.throws(() => validateProviderEvidencePackage(missing), /must include exactly/)
  const origin = validPackage()
  origin.release.origin = 'https://user:pass@staging.example.test/path'
  assert.throws(() => validateProviderEvidencePackage(origin), /credential-free HTTPS origin/)
})

test('rejects budget overrun and evidence cost above retained run cost', () => {
  const aggregate = validPackage()
  aggregate.authorization.maxUsd = 0.1
  assert.throws(() => validateProviderEvidencePackage(aggregate), /exceeds authorization.maxUsd/)
  const run = validPackage()
  run.runs.find((entry) => entry.runKey === 'golden-run').observedUsd = 0.09
  assert.throws(() => validateProviderEvidencePackage(run), /evidence cost exceeds run/)
})

test('rejects incomplete response-depth and multilingual coverage', () => {
  const depths = validPackage()
  depths.evidence.responseDepth.samples[2].depth = 'BRIEF'
  assert.throws(() => validateProviderEvidencePackage(depths), /one BRIEF, BALANCED, and DETAILED/)
  const languages = validPackage()
  languages.evidence.multilingual.cases[0].language = 'en'
  assert.throws(() => validateProviderEvidencePackage(languages), /exactly two cases/)
})

test('rejects missing live voice, fallback, and provider performance proof', () => {
  const voice = validPackage()
  voice.evidence.voice.liveProviderSession = false
  assert.throws(() => validateProviderEvidencePackage(voice), /live provider session/)
  const performance = validPackage()
  performance.evidence.performance.streaming = false
  assert.throws(() => validateProviderEvidencePackage(performance), /streaming proof/)
})

test('rejects incomplete Golden Venue corpus and incomplete human review', () => {
  const corpus = validPackage()
  corpus.evidence.goldenCorpus.cases.pop()
  assert.throws(() => validateProviderEvidencePackage(corpus), /exactly 100 cases/)
  const review = validPackage()
  review.evidence.goldenCorpus.humanReviewComplete = false
  assert.throws(() => validateProviderEvidencePackage(review), /human review must be complete/)
})

test('requires OpenAI same-corpus evidence and denies routing promotion', () => {
  const missing = validPackage()
  missing.runs.find((entry) => entry.runKey === 'model-diversity-run').provider = 'ANTHROPIC'
  missing.authorization.allowedProviders.push('ANTHROPIC')
  assert.throws(
    () => validateProviderEvidencePackage(missing),
    /requires the exact OpenAI observation/,
  )
  const promotion = validPackage()
  promotion.evidence.modelDiversity.observations[0].routingChangeAuthorized = true
  assert.throws(
    () => validateProviderEvidencePackage(promotion),
    /must not authorize a routing change/,
  )
})

test('rejects review before run completion or outside authorization', () => {
  const early = validPackage()
  early.review.reviewedAt = '2026-09-01T01:01:00Z'
  assert.throws(() => validateProviderEvidencePackage(early), /must follow every run/)
  const late = validPackage()
  late.review.reviewedAt = '2026-09-01T04:00:00Z'
  assert.throws(() => validateProviderEvidencePackage(late), /inside authorization/)
  const run = validPackage()
  run.runs[0].startedAt = '2026-08-31T23:59:00Z'
  assert.throws(() => validateProviderEvidencePackage(run), /inside the authorization window/)
})
