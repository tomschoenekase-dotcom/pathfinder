import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export const REQUIRED_SCOPES = ['VIS-06', 'VIS-07', 'UPD-01', 'UPD-02']
export const CHANGE_CLASSES = [
  'addition',
  'correction',
  'supersession',
  'temporary',
  'conflict',
  'duplicate-no-op',
]

const SAFE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256 = /^[a-f0-9]{64}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const MEDIA_KINDS = new Map([
  ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
  ['image/jpeg', Buffer.from('ffd8ff', 'hex')],
  ['image/webp', Buffer.from('52494646', 'hex')],
])
const RIGHTS_BASES = new Set(['VENUE_OWNED', 'LICENSED', 'PERMISSION_GRANTED', 'PUBLIC_DOMAIN'])
const CONNECTION_KINDS = new Set([
  'WALKWAY',
  'DOOR',
  'STAIRS',
  'ELEVATOR',
  'ESCALATOR',
  'OUTDOOR_PATH',
  'SHUTTLE',
])
const REQUIRED_LIFECYCLE_ACTIONS = ['approve', 'apply', 'revert', 'schedule', 'deactivate']

function fail(message) {
  throw new Error(`Founder evidence package rejected: ${message}`)
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
  const unique = new Set(value)
  if (unique.size !== value.length) fail(`${label} must not contain duplicates`)
  if (value.some((entry) => !allowed.includes(entry)))
    fail(`${label} contains an unsupported value`)
  return value
}

function assertNoCustomerIdentifiers(value, trail = 'package') {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(tenantId|venueId|customerId|clientId|userId)$/i.test(key))
      fail(
        `${trail}.${key} is forbidden; use synthetic stable keys, not database/customer identifiers`,
      )
    assertNoCustomerIdentifiers(child, `${trail}.${key}`)
  }
}

function validateTopology(topology) {
  object(topology, 'topology')
  isoInstant(topology.reviewedAt, 'topology.reviewedAt')
  nonEmpty(topology.reviewerReference, 'topology.reviewerReference', 500)
  if (!Array.isArray(topology.floors) || topology.floors.length < 1)
    fail('topology.floors needs at least one floor')
  if (!Array.isArray(topology.locations) || topology.locations.length < 2)
    fail('topology.locations needs at least two locations')
  if (!Array.isArray(topology.connections) || topology.connections.length < 1)
    fail('topology.connections needs at least one reviewed connection')

  const floors = new Set()
  for (const [index, floor] of topology.floors.entries()) {
    object(floor, `topology.floors[${index}]`)
    const key = safeKey(floor.stableKey, `topology.floors[${index}].stableKey`)
    if (floors.has(key)) fail(`duplicate floor stableKey ${key}`)
    floors.add(key)
    nonEmpty(floor.name, `topology.floors[${index}].name`, 160)
  }

  const locations = new Set()
  for (const [index, location] of topology.locations.entries()) {
    object(location, `topology.locations[${index}]`)
    const key = safeKey(location.stableKey, `topology.locations[${index}].stableKey`)
    if (locations.has(key)) fail(`duplicate location stableKey ${key}`)
    locations.add(key)
    if (!floors.has(location.floorStableKey)) fail(`location ${key} references an unknown floor`)
    nonEmpty(location.kind, `topology.locations[${index}].kind`, 64)
    nonEmpty(location.displayName, `topology.locations[${index}].displayName`, 191)
  }

  const adjacency = new Map([...locations].map((key) => [key, new Set()]))
  const connectionKeys = new Set()
  for (const [index, connection] of topology.connections.entries()) {
    object(connection, `topology.connections[${index}]`)
    if (
      !locations.has(connection.from) ||
      !locations.has(connection.to) ||
      connection.from === connection.to
    )
      fail(`topology.connections[${index}] must join two different known locations`)
    if (!CONNECTION_KINDS.has(connection.kind))
      fail(`topology.connections[${index}].kind is unsupported`)
    if (typeof connection.bidirectional !== 'boolean' || typeof connection.accessible !== 'boolean')
      fail(`topology.connections[${index}] must declare bidirectional and accessible booleans`)
    nonEmpty(connection.directions, `topology.connections[${index}].directions`, 2000)
    isoInstant(connection.reviewedAt, `topology.connections[${index}].reviewedAt`)
    const key = `${connection.from}:${connection.to}:${connection.kind}`
    if (connectionKeys.has(key)) fail(`duplicate connection ${key}`)
    connectionKeys.add(key)
    adjacency.get(connection.from).add(connection.to)
    adjacency.get(connection.to).add(connection.from)
  }
  const visited = new Set()
  const queue = [[...locations][0]]
  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    queue.push(...adjacency.get(current))
  }
  if (visited.size !== locations.size) fail('topology must be one connected reviewed graph')
}

function validateHistory(history) {
  if (!Array.isArray(history)) fail('history must be an array')
  const classes = new Set()
  const keys = new Set()
  for (const [index, entry] of history.entries()) {
    object(entry, `history[${index}]`)
    const key = safeKey(entry.stableKey, `history[${index}].stableKey`)
    if (keys.has(key)) fail(`duplicate history stableKey ${key}`)
    keys.add(key)
    if (!CHANGE_CLASSES.includes(entry.changeClass))
      fail(`history[${index}].changeClass is unsupported`)
    classes.add(entry.changeClass)
    isoInstant(entry.effectiveAt, `history[${index}].effectiveAt`)
    nonEmpty(entry.sourceReference, `history[${index}].sourceReference`, 500)
    if (!Object.hasOwn(entry, 'before') || !Object.hasOwn(entry, 'after'))
      fail(`history[${index}] must explicitly retain before and after values`)
    const before = JSON.stringify(entry.before)
    const after = JSON.stringify(entry.after)
    if (entry.changeClass === 'addition' && entry.before !== null)
      fail(`addition ${key} must have before: null`)
    if (entry.changeClass === 'duplicate-no-op' && before !== after)
      fail(`duplicate-no-op ${key} must preserve an identical value`)
    if (
      !['addition', 'duplicate-no-op', 'conflict'].includes(entry.changeClass) &&
      before === after
    )
      fail(`${entry.changeClass} ${key} must change the retained value`)
    if (entry.changeClass === 'temporary') {
      isoInstant(entry.temporaryEndAt, `history[${index}].temporaryEndAt`)
      if (Date.parse(entry.temporaryEndAt) <= Date.parse(entry.effectiveAt))
        fail(`history[${index}].temporaryEndAt must be after effectiveAt`)
    }
  }
  if (CHANGE_CLASSES.some((changeClass) => !classes.has(changeClass)))
    fail(`history must cover all change classes: ${CHANGE_CLASSES.join(', ')}`)
}

async function validateMedia(media, packageDirectory) {
  if (!Array.isArray(media) || media.length < 1)
    fail('media needs at least one reviewed local image')
  const root = await realpath(packageDirectory)
  const keys = new Set()
  const hashes = new Set()
  const validated = []
  for (const [index, asset] of media.entries()) {
    object(asset, `media[${index}]`)
    const key = safeKey(asset.stableKey, `media[${index}].stableKey`)
    if (keys.has(key)) fail(`duplicate media stableKey ${key}`)
    keys.add(key)
    const relativePath = nonEmpty(asset.localPath, `media[${index}].localPath`, 500)
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..'))
      fail(`media[${index}].localPath must remain inside the package directory`)
    const candidate = path.resolve(root, relativePath)
    const stat = await lstat(candidate).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink())
      fail(`media[${index}] must reference a regular non-symlink file`)
    const resolved = await realpath(candidate)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
      fail(`media[${index}] resolves outside the package directory`)
    if (
      !Number.isInteger(asset.byteSize) ||
      asset.byteSize <= 0 ||
      asset.byteSize > 10 * 1024 * 1024
    )
      fail(`media[${index}].byteSize must be between 1 and 10485760`)
    if (stat.size !== asset.byteSize) fail(`media[${index}].byteSize does not match the local file`)
    if (!MEDIA_KINDS.has(asset.mimeType))
      fail(`media[${index}].mimeType must be image/png, image/jpeg, or image/webp`)
    const bytes = await readFile(resolved)
    const signature = MEDIA_KINDS.get(asset.mimeType)
    const signatureMatches =
      asset.mimeType === 'image/webp'
        ? bytes.subarray(0, 4).equals(signature) &&
          bytes.subarray(8, 12).toString('ascii') === 'WEBP'
        : bytes.subarray(0, signature.length).equals(signature)
    if (!signatureMatches) fail(`media[${index}] file signature does not match ${asset.mimeType}`)
    if (!SHA256.test(asset.sha256)) fail(`media[${index}].sha256 must be lowercase SHA-256`)
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== asset.sha256) fail(`media[${index}].sha256 does not match the local file`)
    if (hashes.has(actualHash)) fail(`duplicate media content hash ${actualHash}`)
    hashes.add(actualHash)
    nonEmpty(asset.altText, `media[${index}].altText`, 240)
    nonEmpty(asset.sourceName, `media[${index}].sourceName`, 500)
    isoInstant(asset.reviewedAt, `media[${index}].reviewedAt`)
    const rights = object(asset.rights, `media[${index}].rights`)
    if (!RIGHTS_BASES.has(rights.basis)) fail(`media[${index}].rights.basis is unsupported`)
    nonEmpty(rights.statement, `media[${index}].rights.statement`, 2000)
    nonEmpty(rights.evidenceReference, `media[${index}].rights.evidenceReference`, 500)
    validated.push({
      stableKey: key,
      sha256: actualHash,
      byteSize: stat.size,
      mimeType: asset.mimeType,
    })
  }
  return validated
}

export async function validateFounderEvidencePackage(input, options = {}) {
  const value = object(input, 'package')
  assertNoCustomerIdentifiers(value)
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (value.synthetic !== true || value.customerData !== false)
    fail('synthetic must be true and customerData must be false')
  const fixtureId = safeKey(value.fixtureId, 'fixtureId')
  const venue = object(value.venue, 'venue')
  safeKey(venue.stableKey, 'venue.stableKey')
  nonEmpty(venue.name, 'venue.name', 191)

  const approval = object(value.approval, 'approval')
  if (approval.status !== 'APPROVED') fail('approval.status must be APPROVED')
  nonEmpty(approval.approvedByReference, 'approval.approvedByReference', 500)
  isoInstant(approval.approvedAt, 'approval.approvedAt')
  const approvedScopes = exactUniqueStrings(
    approval.approvedScopes,
    'approval.approvedScopes',
    REQUIRED_SCOPES,
  )
  if (REQUIRED_SCOPES.some((scope) => !approvedScopes.includes(scope)))
    fail(`approval.approvedScopes must include ${REQUIRED_SCOPES.join(', ')}`)

  const exercise = object(value.exercise, 'exercise')
  if (exercise.targetEnvironment !== 'railway-staging')
    fail('exercise.targetEnvironment must be railway-staging')
  if (exercise.publicationAuthority !== false || exercise.providerCallsAllowed !== false)
    fail('exercise must not grant publication authority or provider calls')
  const actions = exactUniqueStrings(
    exercise.requiredLifecycleActions,
    'exercise.requiredLifecycleActions',
    REQUIRED_LIFECYCLE_ACTIONS,
  )
  if (REQUIRED_LIFECYCLE_ACTIONS.some((action) => !actions.includes(action)))
    fail(`exercise.requiredLifecycleActions must include ${REQUIRED_LIFECYCLE_ACTIONS.join(', ')}`)

  validateTopology(value.topology)
  validateHistory(value.history)
  const media = await validateMedia(value.media, options.packageDirectory ?? process.cwd())
  const approvalTime = Date.parse(approval.approvedAt)
  const reviewTimes = [
    Date.parse(value.topology.reviewedAt),
    ...value.topology.connections.map((connection) => Date.parse(connection.reviewedAt)),
    ...value.media.map((asset) => Date.parse(asset.reviewedAt)),
  ]
  if (reviewTimes.some((reviewTime) => reviewTime > approvalTime))
    fail('approval.approvedAt must be at or after every topology and media review')
  const canonical = stableStringify(value)
  return {
    schemaVersion: 1,
    fixtureId,
    synthetic: true,
    customerData: false,
    approvedScopes: [...REQUIRED_SCOPES],
    packageSha256: createHash('sha256').update(canonical).digest('hex'),
    topology: {
      floors: value.topology.floors.length,
      locations: value.topology.locations.length,
      connections: value.topology.connections.length,
    },
    media,
    historyChangeClasses: [...CHANGE_CLASSES],
    exercise: {
      targetEnvironment: 'railway-staging',
      publicationAuthority: false,
      providerCallsAllowed: false,
      requiredLifecycleActions: [...REQUIRED_LIFECYCLE_ACTIONS],
    },
  }
}
