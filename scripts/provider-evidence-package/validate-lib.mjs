import { createHash } from 'node:crypto'

export const REQUIRED_SCOPES = ['VIS-02', 'VIS-04', 'VIS-05', 'PERF-01', 'BLD-05', 'AI-01']
export const RESPONSE_DEPTHS = ['BRIEF', 'BALANCED', 'DETAILED']
export const LAUNCH_LANGUAGES = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'ja', 'ko', 'pt', 'zh']
export const GOLDEN_CORPUS_FAMILIES = [
  'practical-utilities',
  'hours',
  'admissions-rules',
  'exhibit-questions',
  'deeper-interpretation',
  'recommendations',
  'what-should-i-do-next',
  'location-navigation',
  'accessibility',
  'closed-unavailable-place',
  'temporal-update',
  'contradictory-source',
  'missing-answer',
  'vague-query',
  'typo',
  'multilingual',
  'multi-turn-context',
  'adversarial-prompt-injection',
  'staff-private-separation',
]

const SAFE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256 = /^[a-f0-9]{64}$/
const FULL_SHA = /^[a-f0-9]{40}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const PROVIDERS = ['OPENAI', 'ANTHROPIC']
const OUTCOMES = ['PASS', 'FAIL', 'OPERATIONAL_FAILURE']
const SENSITIVE_VALUE_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}\b/u,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  /\bwhsec_[A-Za-z0-9]{16,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bsb_secret_[A-Za-z0-9_-]{20,}\b/u,
  /\bre_[A-Za-z0-9]{20,}\b/u,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/iu,
  /\b(?:postgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+|redis(?:s)?:\/\/(?:[^\s/:@]+)?:[^\s/@]+@[^\s/]+)/iu,
]

function fail(message) {
  throw new Error(`Provider evidence package rejected: ${message}`)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value
}

function nonEmpty(value, label, max = 2000) {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > max
  )
    fail(`${label} must be a non-empty trimmed string of at most ${max} characters`)
  return value
}

function safeKey(value, label) {
  if (!SAFE_KEY.test(nonEmpty(value, label, 100)))
    fail(`${label} must be a lowercase kebab-case key`)
  return value
}

function sha(value, label) {
  if (!SHA256.test(nonEmpty(value, label, 64))) fail(`${label} must be lowercase SHA-256`)
  return value
}

function isoInstant(value, label) {
  if (!ISO_INSTANT.test(nonEmpty(value, label, 40)) || Number.isNaN(Date.parse(value)))
    fail(`${label} must be an ISO UTC instant`)
  const normalized = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/u, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace(/Z$/u, '.000Z')
  if (new Date(value).toISOString() !== normalized)
    fail(`${label} must be a real ISO UTC calendar instant`)
  return value
}

function boundedNumber(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    fail(`${label} must be between ${minimum} and ${maximum}`)
  return value
}

function exactUniqueStrings(value, label, allowed) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    fail(`${label} must be a string array`)
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicates`)
  if (value.length !== allowed.length || allowed.some((entry) => !value.includes(entry)))
    fail(`${label} must include exactly ${allowed.join(', ')}`)
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function assertNoSensitiveMaterial(value, trail = 'package') {
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      fail(`${trail} contains forbidden credential material`)
    }
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/gu, '')
    if (
      /^(tenantId|venueId|customerId|clientId|userId|accountId|organizationId|email|apiKey|secret|token|credential|authorizationHeader)$/i.test(
        normalizedKey,
      )
    )
      fail(`${trail}.${key} is forbidden; retain no customer identifiers or credential material`)
    assertNoSensitiveMaterial(child, `${trail}.${key}`)
  }
}

function validateProviderRun(run, label) {
  object(run, label)
  const runKey = safeKey(run.runKey, `${label}.runKey`)
  if (!PROVIDERS.includes(run.provider)) fail(`${label}.provider is unsupported`)
  nonEmpty(run.model, `${label}.model`, 160)
  sha(run.promptVersionSha256, `${label}.promptVersionSha256`)
  sha(run.corpusSha256, `${label}.corpusSha256`)
  const startedAt = Date.parse(isoInstant(run.startedAt, `${label}.startedAt`))
  const completedAt = Date.parse(isoInstant(run.completedAt, `${label}.completedAt`))
  if (completedAt < startedAt) fail(`${label}.completedAt must be at or after startedAt`)
  const reservedUsd = boundedNumber(run.reservedUsd, `${label}.reservedUsd`, 0, 25)
  const observedUsd = boundedNumber(run.observedUsd, `${label}.observedUsd`, 0, 25)
  if (observedUsd > reservedUsd) fail(`${label}.observedUsd must not exceed reservedUsd`)
  if (run.providerCalls !== true) fail(`${label}.providerCalls must be true`)
  if (run.customerData !== false) fail(`${label}.customerData must be false`)
  nonEmpty(run.evidenceReference, `${label}.evidenceReference`, 500)
  return { runKey, startedAt, completedAt, reservedUsd, observedUsd }
}

function validateCase(entry, label, expectedRunKey) {
  object(entry, label)
  const caseKey = safeKey(entry.caseKey, `${label}.caseKey`)
  if (entry.runKey !== expectedRunKey) fail(`${label}.runKey must match its declared run`)
  if (!OUTCOMES.includes(entry.outcome)) fail(`${label}.outcome is unsupported`)
  sha(entry.responseSha256, `${label}.responseSha256`)
  boundedNumber(entry.responseBytes, `${label}.responseBytes`, 1, 1_000_000)
  boundedNumber(entry.inputTokens, `${label}.inputTokens`, 0, 1_000_000)
  boundedNumber(entry.outputTokens, `${label}.outputTokens`, 0, 1_000_000)
  boundedNumber(entry.latencyMs, `${label}.latencyMs`, 1, 600_000)
  boundedNumber(entry.ttftMs, `${label}.ttftMs`, 1, entry.latencyMs)
  boundedNumber(entry.observedUsd, `${label}.observedUsd`, 0, 25)
  nonEmpty(entry.humanReviewReference, `${label}.humanReviewReference`, 500)
  if (typeof entry.grounded !== 'boolean' || typeof entry.safeFallback !== 'boolean')
    fail(`${label} must declare grounded and safeFallback booleans`)
  return { caseKey, observedUsd: entry.observedUsd }
}

function validateCases(cases, label, runKey, minimumCount, maximumCount = minimumCount) {
  if (!Array.isArray(cases) || cases.length < minimumCount || cases.length > maximumCount) {
    const countMessage =
      minimumCount === maximumCount
        ? `exactly ${minimumCount}`
        : `between ${minimumCount} and ${maximumCount}`
    fail(`${label} must contain ${countMessage} cases`)
  }
  const keys = new Set()
  let observedUsd = 0
  for (const [index, entry] of cases.entries()) {
    const result = validateCase(entry, `${label}[${index}]`, runKey)
    if (keys.has(result.caseKey)) fail(`${label} has duplicate caseKey ${result.caseKey}`)
    keys.add(result.caseKey)
    observedUsd += result.observedUsd
  }
  return { keys, observedUsd }
}

function validateResponseDepth(value, runs) {
  const section = object(value, 'evidence.responseDepth')
  if (!Array.isArray(section.samples) || section.samples.length !== 3)
    fail('evidence.responseDepth.samples must contain exactly three depth samples')
  const depths = new Set()
  for (const [index, sample] of section.samples.entries()) {
    object(sample, `evidence.responseDepth.samples[${index}]`)
    if (!RESPONSE_DEPTHS.includes(sample.depth) || depths.has(sample.depth))
      fail('response-depth samples must contain one BRIEF, BALANCED, and DETAILED result')
    depths.add(sample.depth)
    const run = runs.get(sample.runKey)
    if (!run) fail(`response-depth sample ${sample.depth} references an unknown run`)
    const result = validateCase(sample, `evidence.responseDepth.samples[${index}]`, sample.runKey)
    nonEmpty(
      sample.sameQuestionReference,
      `evidence.responseDepth.samples[${index}].sameQuestionReference`,
      500,
    )
    if (sample.outcome !== 'PASS') fail(`response-depth sample ${sample.depth} must be PASS`)
    run.caseCost += result.observedUsd
  }
  if (RESPONSE_DEPTHS.some((depth) => !depths.has(depth)))
    fail('response-depth coverage is incomplete')
}

function validateMultilingual(value, runs) {
  const section = object(value, 'evidence.multilingual')
  const run = runs.get(section.runKey)
  if (!run) fail('evidence.multilingual.runKey references an unknown run')
  const result = validateCases(section.cases, 'evidence.multilingual.cases', section.runKey, 20)
  const languages = new Map(LAUNCH_LANGUAGES.map((language) => [language, 0]))
  for (const entry of section.cases) {
    if (!languages.has(entry.language)) fail('multilingual case language is unsupported')
    languages.set(entry.language, languages.get(entry.language) + 1)
  }
  if ([...languages.values()].some((count) => count !== 2))
    fail('multilingual cases must contain exactly two cases for each launch language')
  run.caseCost += result.observedUsd
}

function validateVoice(value, runs) {
  const section = object(value, 'evidence.voice')
  const run = runs.get(section.runKey)
  if (!run) fail('evidence.voice.runKey references an unknown run')
  if (section.founderApprovedSyntheticEntitlement !== true || section.liveProviderSession !== true)
    fail('voice must retain founder-approved synthetic entitlement and a live provider session')
  if (section.permissionGranted !== true || section.textFallbackVerified !== true)
    fail('voice must retain permission and text-fallback proof')
  nonEmpty(section.entitlementEvidenceReference, 'evidence.voice.entitlementEvidenceReference', 500)
  sha(section.transcriptSha256, 'evidence.voice.transcriptSha256')
  boundedNumber(section.durationSeconds, 'evidence.voice.durationSeconds', 1, 900)
  const cost = boundedNumber(section.observedUsd, 'evidence.voice.observedUsd', 0, 25)
  run.caseCost += cost
}

function validatePerformance(value, runs) {
  const section = object(value, 'evidence.performance')
  const run = runs.get(section.runKey)
  if (!run) fail('evidence.performance.runKey references an unknown run')
  if (section.founderApprovedSpend !== true || section.streaming !== true)
    fail('performance must retain founder-approved spend and streaming proof')
  boundedNumber(section.ttftMs, 'evidence.performance.ttftMs', 1, 600_000)
  boundedNumber(
    section.totalLatencyMs,
    'evidence.performance.totalLatencyMs',
    section.ttftMs,
    600_000,
  )
  const cost = boundedNumber(section.observedUsd, 'evidence.performance.observedUsd', 0, 25)
  sha(section.authoritativeResponseSha256, 'evidence.performance.authoritativeResponseSha256')
  nonEmpty(
    section.measurementEvidenceReference,
    'evidence.performance.measurementEvidenceReference',
    500,
  )
  run.caseCost += cost
}

function validateGoldenCorpus(value, runs) {
  const section = object(value, 'evidence.goldenCorpus')
  const run = runs.get(section.runKey)
  if (!run) fail('evidence.goldenCorpus.runKey references an unknown run')
  const result = validateCases(
    section.cases,
    'evidence.goldenCorpus.cases',
    section.runKey,
    100,
    300,
  )
  const coveredFamilies = new Set()
  for (const [index, entry] of section.cases.entries()) {
    if (
      !Array.isArray(entry.families) ||
      entry.families.length < 1 ||
      entry.families.length > GOLDEN_CORPUS_FAMILIES.length ||
      entry.families.some((family) => !GOLDEN_CORPUS_FAMILIES.includes(family)) ||
      new Set(entry.families).size !== entry.families.length
    ) {
      fail(`evidence.goldenCorpus.cases[${index}].families must be unique reviewed families`)
    }
    entry.families.forEach((family) => coveredFamilies.add(family))
  }
  if (GOLDEN_CORPUS_FAMILIES.some((family) => !coveredFamilies.has(family))) {
    fail('golden corpus must cover every reviewed failure family')
  }
  if (section.humanReviewComplete !== true) fail('golden corpus human review must be complete')
  nonEmpty(
    section.reviewConclusionReference,
    'evidence.goldenCorpus.reviewConclusionReference',
    500,
  )
  run.caseCost += result.observedUsd
}

function validateModelDiversity(value, runs) {
  const section = object(value, 'evidence.modelDiversity')
  if (
    !Array.isArray(section.observations) ||
    section.observations.length < 1 ||
    section.observations.length > 2
  )
    fail('model diversity needs one OpenAI observation and at most one Anthropic observation')
  const providers = new Set()
  let corpusSha
  for (const [index, observation] of section.observations.entries()) {
    object(observation, `evidence.modelDiversity.observations[${index}]`)
    const run = runs.get(observation.runKey)
    if (!run || providers.has(run.provider))
      fail('model-diversity observations need unique known providers')
    providers.add(run.provider)
    if (observation.caseCount !== 20 || observation.corpusSha256 !== run.corpusSha256)
      fail('each model-diversity observation must bind the exact 20-case run corpus')
    corpusSha ??= observation.corpusSha256
    if (observation.corpusSha256 !== corpusSha)
      fail('model-diversity observations must use one corpus')
    if (observation.routingChangeAuthorized !== false)
      fail('model-diversity evidence must not authorize a routing change')
    nonEmpty(
      observation.reviewReference,
      `evidence.modelDiversity.observations[${index}].reviewReference`,
      500,
    )
  }
  if (!providers.has('OPENAI')) fail('model diversity requires the exact OpenAI observation first')
}

export function validateProviderEvidencePackage(input) {
  const value = object(input, 'package')
  assertNoSensitiveMaterial(value)
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (value.syntheticVenue !== true || value.customerData !== false)
    fail('syntheticVenue must be true and customerData must be false')
  const packageId = safeKey(value.packageId, 'packageId')
  if (value.targetEnvironment !== 'railway-staging')
    fail('targetEnvironment must be railway-staging')
  exactUniqueStrings(value.scopes, 'scopes', REQUIRED_SCOPES)

  const release = object(value.release, 'release')
  if (!FULL_SHA.test(release.revision)) fail('release.revision must be a lowercase full Git SHA')
  let origin
  try {
    origin = new URL(nonEmpty(release.origin, 'release.origin', 500))
  } catch {
    fail('release.origin must be a credential-free HTTPS origin')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    fail('release.origin must be a credential-free HTTPS origin')

  const authorization = object(value.authorization, 'authorization')
  if (authorization.status !== 'APPROVED' || authorization.stagingOnly !== true)
    fail('authorization must be APPROVED and stagingOnly')
  nonEmpty(authorization.approverReference, 'authorization.approverReference', 500)
  if (
    authorization.authenticatedAdminSession !== true ||
    authorization.isolatedStagingCredential !== true
  )
    fail('authorization must retain an authenticated admin session and isolated staging credential')
  nonEmpty(authorization.sessionEvidenceReference, 'authorization.sessionEvidenceReference', 500)
  nonEmpty(
    authorization.credentialEvidenceReference,
    'authorization.credentialEvidenceReference',
    500,
  )
  const approvedAt = Date.parse(isoInstant(authorization.approvedAt, 'authorization.approvedAt'))
  const expiresAt = Date.parse(isoInstant(authorization.expiresAt, 'authorization.expiresAt'))
  if (expiresAt <= approvedAt) fail('authorization.expiresAt must be after approvedAt')
  const maxUsd = boundedNumber(authorization.maxUsd, 'authorization.maxUsd', 0.01, 25)
  if (
    !Array.isArray(authorization.allowedProviders) ||
    authorization.allowedProviders.length < 1 ||
    new Set(authorization.allowedProviders).size !== authorization.allowedProviders.length ||
    authorization.allowedProviders.some((provider) => !PROVIDERS.includes(provider)) ||
    !authorization.allowedProviders.includes('OPENAI')
  )
    fail('authorization.allowedProviders must be a unique supported list containing OPENAI')
  if (
    authorization.productionAccess !== false ||
    authorization.customerContact !== false ||
    authorization.routingChange !== false
  )
    fail('authorization must deny production, customer contact, and routing changes')

  if (!Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > 8)
    fail('runs must contain between one and eight bounded provider runs')
  const runs = new Map()
  for (const [index, entry] of value.runs.entries()) {
    const result = validateProviderRun(entry, `runs[${index}]`)
    if (runs.has(result.runKey)) fail(`duplicate runKey ${result.runKey}`)
    if (!authorization.allowedProviders.includes(entry.provider))
      fail(`run ${result.runKey} uses a provider outside authorization`)
    if (result.startedAt < approvedAt || result.completedAt > expiresAt)
      fail(`run ${result.runKey} must remain inside the authorization window`)
    runs.set(result.runKey, {
      ...result,
      provider: entry.provider,
      corpusSha256: entry.corpusSha256,
      caseCost: 0,
    })
  }

  const evidence = object(value.evidence, 'evidence')
  validateResponseDepth(evidence.responseDepth, runs)
  validateMultilingual(evidence.multilingual, runs)
  validateVoice(evidence.voice, runs)
  validatePerformance(evidence.performance, runs)
  validateGoldenCorpus(evidence.goldenCorpus, runs)
  validateModelDiversity(evidence.modelDiversity, runs)

  let observedUsd = 0
  let reservedUsd = 0
  let latestCompletedAt = 0
  for (const [runKey, run] of runs) {
    if (run.caseCost > run.observedUsd + 1e-9)
      fail(`retained evidence cost exceeds run ${runKey} observedUsd`)
    observedUsd += run.observedUsd
    reservedUsd += run.reservedUsd
    latestCompletedAt = Math.max(latestCompletedAt, run.completedAt)
  }
  if (reservedUsd > maxUsd + 1e-9 || observedUsd > maxUsd + 1e-9)
    fail('aggregate reserved or observed spend exceeds authorization.maxUsd')

  const review = object(value.review, 'review')
  if (review.status !== 'COMPLETE') fail('review.status must be COMPLETE')
  nonEmpty(review.reviewerReference, 'review.reviewerReference', 500)
  const reviewedAt = Date.parse(isoInstant(review.reviewedAt, 'review.reviewedAt'))
  if (reviewedAt < latestCompletedAt || reviewedAt > expiresAt)
    fail('review.reviewedAt must follow every run and remain inside authorization')
  if (review.launchCertified !== false || review.routingChangeApproved !== false)
    fail('review must not certify launch or approve a routing change')

  return {
    schemaVersion: 1,
    packageId,
    syntheticVenue: true,
    customerData: false,
    targetEnvironment: 'railway-staging',
    release: { revision: release.revision, origin: origin.origin },
    scopes: [...REQUIRED_SCOPES],
    providersObserved: [...new Set([...runs.values()].map((run) => run.provider))].sort(),
    runCount: runs.size,
    reservedUsd: Number(reservedUsd.toFixed(8)),
    observedUsd: Number(observedUsd.toFixed(8)),
    launchCertified: false,
    routingChangeApproved: false,
    packageSha256: createHash('sha256').update(stableStringify(value)).digest('hex'),
  }
}
