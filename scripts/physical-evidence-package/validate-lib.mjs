import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export const REQUIRED_SCOPES = ['VIS-01', 'VIS-03', 'A11Y-01', 'PHY-01']
export const REQUIRED_CHECKS = [
  'NEW_CHAT_RESET',
  'SOFT_KEYBOARD_SAFE_AREA',
  'SCREEN_READER',
  'TEXT_ZOOM_REFLOW',
  'SWITCH_OR_EXTERNAL_CONTROL',
  'PRINTED_QR_SCAN',
  'GLARE_FOCUS',
  'COLD_LOAD',
  'ATTRIBUTION_MARKER',
]

const SAFE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256 = /^[a-f0-9]{64}$/
const FULL_SHA = /^[a-f0-9]{40}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const PLATFORMS = ['IOS', 'ANDROID']
const NETWORK_PROFILES = ['REAL_WEAK_OR_VARIABLE', 'CONTROLLED_WEAK_NETWORK']
const MEDIA_KINDS = new Map([
  ['image/png', { prefix: Buffer.from('89504e470d0a1a0a', 'hex') }],
  ['image/jpeg', { prefix: Buffer.from('ffd8ff', 'hex') }],
  ['image/webp', { prefix: Buffer.from('52494646', 'hex'), webp: true }],
  ['video/mp4', { mp4: true }],
])

function fail(message) {
  throw new Error(`Physical evidence package rejected: ${message}`)
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

function exactUniqueStrings(value, label, allowed) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    fail(`${label} must be a string array`)
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicates`)
  if (value.some((entry) => !allowed.includes(entry)))
    fail(`${label} contains an unsupported value`)
  if (allowed.some((entry) => !value.includes(entry)))
    fail(`${label} must include ${allowed.join(', ')}`)
  return value
}

function assertNoCustomerIdentifiers(value, trail = 'package') {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/gu, '')
    if (
      /^(tenantId|venueId|customerId|clientId|userId|accountId|organizationId|email)$/i.test(
        normalizedKey,
      )
    )
      fail(`${trail}.${key} is forbidden; retain no customer or account identifiers`)
    assertNoCustomerIdentifiers(child, `${trail}.${key}`)
  }
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

function validateSessions(sessions, evidenceKeys) {
  if (!Array.isArray(sessions) || sessions.length !== 2)
    fail('sessions must contain exactly one iOS and one Android physical-device session')
  const platforms = new Set()
  const keys = new Set()
  const observedTimes = []
  const observedByKey = new Map()
  for (const [index, session] of sessions.entries()) {
    object(session, `sessions[${index}]`)
    const key = safeKey(session.stableKey, `sessions[${index}].stableKey`)
    if (keys.has(key)) fail(`duplicate session stableKey ${key}`)
    keys.add(key)
    if (!PLATFORMS.includes(session.platform) || platforms.has(session.platform))
      fail('sessions must contain one unique IOS and one unique ANDROID platform')
    platforms.add(session.platform)
    if (session.physicalDevice !== true) fail(`session ${key} must declare physicalDevice: true`)
    const observedAt = isoInstant(session.observedAt, `sessions[${index}].observedAt`)
    observedTimes.push(Date.parse(observedAt))
    observedByKey.set(key, Date.parse(observedAt))
    nonEmpty(session.operatorReference, `sessions[${index}].operatorReference`, 500)
    const device = object(session.device, `sessions[${index}].device`)
    nonEmpty(device.manufacturer, `sessions[${index}].device.manufacturer`, 100)
    nonEmpty(device.model, `sessions[${index}].device.model`, 100)
    const expectedOs = session.platform === 'IOS' ? 'iOS' : 'Android'
    if (device.osName !== expectedOs) fail(`session ${key} device.osName must be ${expectedOs}`)
    nonEmpty(device.osVersion, `sessions[${index}].device.osVersion`, 80)
    const browser = object(session.browser, `sessions[${index}].browser`)
    nonEmpty(browser.name, `sessions[${index}].browser.name`, 80)
    nonEmpty(browser.version, `sessions[${index}].browser.version`, 80)
    const network = object(session.network, `sessions[${index}].network`)
    if (!NETWORK_PROFILES.includes(network.profile))
      fail(`session ${key} network.profile is unsupported`)
    nonEmpty(network.method, `sessions[${index}].network.method`, 500)
    nonEmpty(network.evidenceReference, `sessions[${index}].network.evidenceReference`, 500)
    if (!Array.isArray(session.checks)) fail(`session ${key} checks must be an array`)
    const checkIds = new Set()
    for (const [checkIndex, check] of session.checks.entries()) {
      object(check, `sessions[${index}].checks[${checkIndex}]`)
      if (!REQUIRED_CHECKS.includes(check.id) || checkIds.has(check.id))
        fail(`session ${key} has an unsupported or duplicate check id`)
      checkIds.add(check.id)
      if (check.outcome !== 'PASS') fail(`session ${key} check ${check.id} must be PASS`)
      nonEmpty(check.notes, `session ${key} check ${check.id}.notes`, 2000)
      if (!Array.isArray(check.evidenceKeys) || check.evidenceKeys.length < 1)
        fail(`session ${key} check ${check.id} needs evidenceKeys`)
      if (
        new Set(check.evidenceKeys).size !== check.evidenceKeys.length ||
        check.evidenceKeys.some((evidenceKey) => !evidenceKeys.get(key)?.has(evidenceKey))
      )
        fail(`session ${key} check ${check.id} references invalid or duplicate evidence`)
    }
    if (REQUIRED_CHECKS.some((check) => !checkIds.has(check)))
      fail(`session ${key} must pass every required physical check`)
  }
  if (PLATFORMS.some((platform) => !platforms.has(platform)))
    fail('sessions must contain IOS and ANDROID')
  return { keys, observedTimes, observedByKey }
}

async function validateEvidence(evidence, packageDirectory) {
  if (!Array.isArray(evidence) || evidence.length < 2)
    fail('evidence needs at least two local image or MP4 artifacts')
  const root = await realpath(packageDirectory)
  const keys = new Set()
  const hashes = new Set()
  const bySession = new Map()
  const capturedTimes = []
  const validated = []
  for (const [index, artifact] of evidence.entries()) {
    object(artifact, `evidence[${index}]`)
    const key = safeKey(artifact.stableKey, `evidence[${index}].stableKey`)
    if (keys.has(key)) fail(`duplicate evidence stableKey ${key}`)
    keys.add(key)
    const sessionKey = safeKey(artifact.sessionStableKey, `evidence[${index}].sessionStableKey`)
    if (!bySession.has(sessionKey)) bySession.set(sessionKey, new Set())
    bySession.get(sessionKey).add(key)
    const relativePath = nonEmpty(artifact.localPath, `evidence[${index}].localPath`, 500)
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..'))
      fail(`evidence[${index}].localPath must remain inside the package directory`)
    const candidate = path.resolve(root, relativePath)
    const stat = await lstat(candidate).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink())
      fail(`evidence[${index}] must reference a regular non-symlink file`)
    const resolved = await realpath(candidate)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
      fail(`evidence[${index}] resolves outside the package directory`)
    if (
      !Number.isInteger(artifact.byteSize) ||
      artifact.byteSize <= 0 ||
      artifact.byteSize > 25 * 1024 * 1024 ||
      stat.size !== artifact.byteSize
    )
      fail(`evidence[${index}].byteSize is invalid or does not match the local file`)
    const kind = MEDIA_KINDS.get(artifact.mimeType)
    if (!kind) fail(`evidence[${index}].mimeType is unsupported`)
    const bytes = await readFile(resolved)
    const signatureMatches = kind.webp
      ? bytes.subarray(0, 4).equals(kind.prefix) &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      : kind.mp4
        ? bytes.subarray(4, 8).toString('ascii') === 'ftyp'
        : bytes.subarray(0, kind.prefix.length).equals(kind.prefix)
    if (!signatureMatches)
      fail(`evidence[${index}] file signature does not match ${artifact.mimeType}`)
    if (!SHA256.test(artifact.sha256)) fail(`evidence[${index}].sha256 must be lowercase SHA-256`)
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== artifact.sha256 || hashes.has(actualHash))
      fail(`evidence[${index}] has hash drift or duplicate content`)
    hashes.add(actualHash)
    const capturedAt = isoInstant(artifact.capturedAt, `evidence[${index}].capturedAt`)
    capturedTimes.push(Date.parse(capturedAt))
    nonEmpty(artifact.description, `evidence[${index}].description`, 1000)
    validated.push({
      stableKey: key,
      sessionStableKey: sessionKey,
      sha256: actualHash,
      byteSize: stat.size,
      mimeType: artifact.mimeType,
      capturedAt,
    })
  }
  return { bySession, capturedTimes, validated }
}

export async function validatePhysicalEvidencePackage(input, options = {}) {
  const value = object(input, 'package')
  assertNoCustomerIdentifiers(value)
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (value.physical !== true || value.syntheticVenue !== true || value.customerData !== false)
    fail('physical and syntheticVenue must be true and customerData must be false')
  const packageId = safeKey(value.packageId, 'packageId')
  if (value.targetEnvironment !== 'railway-staging')
    fail('targetEnvironment must be railway-staging')
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
  exactUniqueStrings(value.scopes, 'scopes', REQUIRED_SCOPES)
  const review = object(value.review, 'review')
  if (review.status !== 'COMPLETE') fail('review.status must be COMPLETE')
  nonEmpty(review.reviewerReference, 'review.reviewerReference', 500)
  const reviewedAt = Date.parse(isoInstant(review.reviewedAt, 'review.reviewedAt'))
  const artifacts = await validateEvidence(
    value.evidence,
    options.packageDirectory ?? process.cwd(),
  )
  const sessions = validateSessions(value.sessions, artifacts.bySession)
  if ([...artifacts.bySession].some(([key]) => !sessions.keys.has(key)))
    fail('every evidence artifact must belong to a declared session')
  if (sessions.keys.size !== artifacts.bySession.size)
    fail('every session needs at least one retained evidence artifact')
  if (
    artifacts.validated.some(
      (artifact) =>
        Math.abs(
          Date.parse(artifact.capturedAt) - sessions.observedByKey.get(artifact.sessionStableKey),
        ) >
        6 * 60 * 60 * 1000,
    )
  )
    fail('every evidence capture must be within six hours of its declared physical session')
  if ([...sessions.observedTimes, ...artifacts.capturedTimes].some((time) => time > reviewedAt))
    fail('review.reviewedAt must be at or after every observation and capture')
  return {
    schemaVersion: 1,
    packageId,
    physical: true,
    syntheticVenue: true,
    customerData: false,
    targetEnvironment: 'railway-staging',
    release: { revision: release.revision, origin: origin.origin },
    scopes: [...REQUIRED_SCOPES],
    platforms: [...PLATFORMS],
    checks: [...REQUIRED_CHECKS],
    evidence: artifacts.validated,
    packageSha256: createHash('sha256').update(stableStringify(value)).digest('hex'),
  }
}
