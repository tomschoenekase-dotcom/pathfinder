import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import jsQR from 'jsqr'
import sharp from 'sharp'
import { setOpenAiEmbeddingsClientForTesting } from '../../../../packages/ai/src/openai-embeddings'
import { retrieveGuestKnowledge } from '../../../../packages/api/src/lib/guest-knowledge-retrieval'
import { loadPublicLocationScope } from '../../../../packages/api/src/routers/location-public-scope'

import {
  claimIntakeUploadVerificationAction,
  db,
  getIntakeSubmissionDraft,
  recordIntakeFileExtractionReceiptAction,
  recordIntakeUploadPrecheckAction,
  reserveIntakeUploadAction,
  saveIntakeSubmissionDraft,
  settleIntakeUploadAuthoritativeVerificationAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const enabled =
  process.env.RUN_ONBOARDING_CONNECTED_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_onboarding_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')
const redisTransportEnabled = process.env.RUN_ONBOARDING_CONNECTED_REDIS_INTEGRATION === '1'
const freshExtractionEnabled = process.env.RUN_ONBOARDING_CONNECTED_FRESH_EXTRACTION === '1'
const storageTransportEnabled = process.env.RUN_ONBOARDING_CONNECTED_STORAGE === '1'
const scannerTransportEnabled = process.env.RUN_ONBOARDING_CONNECTED_SCANNER === '1'
const storageRecoveryEnabled = process.env.RUN_ONBOARDING_CONNECTED_STORAGE_RECOVERY === '1'
const qrReleaseEnabled = process.env.RUN_ONBOARDING_CONNECTED_QR_RELEASE === '1'
const scannerReleaseEnabled = process.env.RUN_ONBOARDING_CONNECTED_SCANNER_RELEASE === '1'
const themeRequestEnabled = process.env.RUN_ONBOARDING_CONNECTED_THEME_REQUEST === '1'
if (themeRequestEnabled && !scannerReleaseEnabled) {
  throw new Error('Theme request proof requires the guarded scanner release mode.')
}
const dashboardBaseURL = process.env.ONBOARDING_CONNECTED_BASE_URL ?? 'http://127.0.0.1:3002'
const scannerCleanText =
  'Visitor-provided notes require review before they become venue knowledge.\n'

async function decodeQrSvg(svgBytes: Buffer): Promise<string | undefined> {
  const { data, info } = await sharp(svgBytes)
    .resize(832, 832, { kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return jsQR(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
    { inversionAttempts: 'attemptBoth' },
  )?.data
}

if (qrReleaseEnabled && (!enabled || storageTransportEnabled || freshExtractionEnabled)) {
  throw new Error(
    'Connected QR release proof requires the base disposable database mode without storage or fresh extraction.',
  )
}
if (
  scannerReleaseEnabled &&
  (!enabled ||
    !scannerTransportEnabled ||
    !storageTransportEnabled ||
    !redisTransportEnabled ||
    freshExtractionEnabled ||
    qrReleaseEnabled)
) {
  throw new Error(
    'Connected scanner release proof requires real scanner extraction with guarded storage and Redis, without the mocked fresh extraction or separate QR release modes.',
  )
}

function assertDisposableRedisTransportBoundary(): void {
  if (freshExtractionEnabled && !redisTransportEnabled) {
    throw new Error('Fresh connected extraction requires the guarded Redis transport.')
  }
  if (!redisTransportEnabled) return
  if (
    process.env.PATHFINDER_DISPOSABLE_ONBOARDING_REDIS_CONFIRMATION !==
    'pathfinder_disposable_onboarding_connected'
  ) {
    throw new Error('Connected Redis proof requires exact disposable confirmation')
  }
  const redisUrl = new URL(process.env.REDIS_URL ?? '')
  if (
    redisUrl.protocol !== 'redis:' ||
    redisUrl.hostname !== '127.0.0.1' ||
    !redisUrl.port ||
    redisUrl.username ||
    redisUrl.password ||
    redisUrl.search ||
    redisUrl.hash ||
    (redisUrl.pathname !== '' && redisUrl.pathname !== '/')
  ) {
    throw new Error('Connected Redis proof requires credential-free loopback Redis')
  }
}

function assertDisposableStorageTransportBoundary(): void {
  if (scannerTransportEnabled && !storageTransportEnabled)
    throw new Error('Connected browser scanner proof requires the guarded storage mode.')
  if (storageRecoveryEnabled && !storageTransportEnabled)
    throw new Error('Connected browser storage recovery requires the guarded storage mode.')
  if (!storageTransportEnabled) return
  if (!redisTransportEnabled)
    throw new Error('Connected browser storage proof requires the guarded Redis transport.')
  if (freshExtractionEnabled)
    throw new Error(
      'Connected browser storage proof and fresh extraction mode are mutually exclusive.',
    )
  const endpoint = new URL(process.env.STORAGE_ENDPOINT ?? '')
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port !== '19393' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== '' && endpoint.pathname !== '/')
  ) {
    throw new Error(
      'Connected browser storage proof requires the disposable loopback MinIO endpoint.',
    )
  }
  if (!/^pathfinder-disposable-intake-[a-f0-9]{12}$/u.test(process.env.STORAGE_BUCKET ?? ''))
    throw new Error('Connected browser storage proof requires its exact disposable bucket.')
  if (
    !process.env.STORAGE_REGION ||
    !process.env.STORAGE_ACCESS_KEY_ID ||
    !process.env.STORAGE_SECRET_ACCESS_KEY
  ) {
    throw new Error('Connected browser storage proof requires fixture storage configuration.')
  }
  if (scannerTransportEnabled) {
    if (
      process.env.INTAKE_CLAMAV_HOST !== '127.0.0.1' ||
      process.env.INTAKE_CLAMAV_PORT !== '19310'
    )
      throw new Error('Connected browser scanner proof requires the exact disposable scanner.')
  } else if (process.env.INTAKE_CLAMAV_HOST || process.env.INTAKE_CLAMAV_PORT)
    throw new Error('Connected browser storage proof must not configure an authoritative scanner.')
}

assertDisposableRedisTransportBoundary()
assertDisposableStorageTransportBoundary()

type ConnectedQueueJob = {
  id?: string | number
  name: string
  data?: { dispatchId?: string }
  getState(): Promise<string>
}

type ConnectedWorker = {
  on(event: 'completed', listener: (job: ConnectedQueueJob, result: unknown) => void): unknown
  off(event: 'completed', listener: (job: ConnectedQueueJob, result: unknown) => void): unknown
}

type FailedVerificationJob = {
  id?: string | number
  name: string
  data?: { uploadId?: string }
  attemptsMade?: number
  failedReason?: string
  getState(): Promise<string>
}

type FailedVerificationWorker = {
  on(
    event: 'failed',
    listener: (job: FailedVerificationJob | undefined, error: Error) => void,
  ): unknown
  off(
    event: 'failed',
    listener: (job: FailedVerificationJob | undefined, error: Error) => void,
  ): unknown
}

async function waitForVerificationFailure(
  worker: FailedVerificationWorker,
  uploadId: string,
): Promise<{ jobId: string; attemptsMade: number; state: string; name: string; message: string }> {
  return new Promise((resolveFailure, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      worker.off('failed', onFailed)
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for the registered intake upload verification worker'))
    }, 45_000)
    const onFailed = (job: FailedVerificationJob | undefined, error: Error) => {
      if (!job || job.data?.uploadId !== uploadId) return
      void job.getState().then(
        (state) => {
          cleanup()
          resolveFailure({
            jobId: String(job.id),
            attemptsMade: job.attemptsMade ?? 0,
            state,
            name: error.name,
            message: error.message,
          })
        },
        (readError: unknown) => {
          cleanup()
          reject(readError)
        },
      )
    }
    worker.on('failed', onFailed)
  })
}

async function waitForWorkerResult(
  worker: ConnectedWorker,
  predicate: (job: ConnectedQueueJob) => boolean,
  enqueue: () => Promise<unknown>,
): Promise<{ id: string; result: unknown; state: string }> {
  return new Promise((resolveResult, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      worker.off('completed', onCompleted)
    }
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const timeout = setTimeout(() => {
      fail(new Error('Timed out waiting for connected intake V1 worker delivery'))
    }, 45_000)
    const onCompleted = (job: ConnectedQueueJob, result: unknown) => {
      if (!predicate(job)) return
      worker.off('completed', onCompleted)
      void job.getState().then((state) => {
        cleanup()
        resolveResult({ id: String(job.id), result, state })
      }, fail)
    }
    worker.on('completed', onCompleted)
    void Promise.resolve().then(enqueue).catch(fail)
  })
}

const tenantId = 'fixture-remote-onboarding-tenant'
const venueId = scannerReleaseEnabled ? 'c000000000000000000000001' : 'fixture-great-lakes-museum'
const remoteOnboardingFixtureUrl = `/dev-fixtures/remote-onboarding?state=share${scannerReleaseEnabled ? `&venueId=${venueId}` : ''}`
const ownerUserId = 'fixture-onboarding-owner'
const otherUserId = 'fixture-onboarding-other'
const staffUserId = 'fixture-onboarding-staff'
const adminUserId = 'fixture-onboarding-admin'
const otherTenantId = 'fixture-onboarding-other-tenant'
const originalDraft = 'The east entrance is step-free during public hours.'
const winnerDraft = 'The east entrance is step-free; use the blue call button after 6 p.m.'
const staleDraft = 'Stale second-device wording must remain visible but unsaved.'
const secondDeviceDraft = 'The east entrance is step-free and the call button is beside the door.'
const beyondPreviewFact = 'FACT BEYOND 4000: loan wheelchairs are stored at the east welcome desk.'
const extractedText = `${'A'.repeat(3_999)}\u{1F600}${beyondPreviewFact}${'B'.repeat(1_000)}`
const freshExtractedText =
  'Fresh fixture source: the accessible entrance is beside the visitor desk.'

type FreshStorageObject = { versionId: string; bytes: Buffer; reads: number }
const freshStorageObjects = new Map<string, FreshStorageObject>()
let restoreFreshStorageTransport: (() => void) | null = null

function installFreshStorageTransport() {
  if (!freshExtractionEnabled) return
  // Patch only the SDK transport used by the actual extraction service in this test process.
  // The registry, processor, exact-version reader, extraction and canonical receipt stay real.
  const sdk = createRequire(resolve(__dirname, '../../../../packages/api/package.json'))(
    '@aws-sdk/client-s3',
  ) as {
    S3Client: { prototype: { send(command: unknown): Promise<unknown> } }
    GetObjectCommand: new (input: Record<string, unknown>) => {
      input: { Key?: string; VersionId?: string }
    }
  }
  const originalSend = sdk.S3Client.prototype.send
  sdk.S3Client.prototype.send = async (command: unknown) => {
    if (!(command instanceof sdk.GetObjectCommand))
      throw new Error('Unexpected fresh fixture storage command')
    const object = freshStorageObjects.get(command.input.Key ?? '')
    if (!object || command.input.VersionId !== object.versionId)
      throw new Error('Exact fresh fixture object version unavailable')
    object.reads += 1
    return {
      Body: (async function* () {
        yield object.bytes
      })(),
    }
  }
  restoreFreshStorageTransport = () => {
    sdk.S3Client.prototype.send = originalSend
  }
}

type FixtureSession = {
  userId: string
  activeTenantId: string | null
  role: 'STAFF' | 'MANAGER' | 'OWNER' | null
  isPlatformAdmin: boolean
}
type FixtureState = {
  server: Server
  endpoint: string
  tokens: { owner: string; other: string; staff: string; admin: string }
  sessions: Map<string, FixtureSession>
  runId: string
  uploadId: string
  receiptId: string
  extractedTextHash: string
  sourceSha256: string
  objectGeneration: string
  storageVersionId: string
  sourceRequests: Array<Record<string, unknown>>
  sourceResponseCursors: Array<string | null>
  freshExtraction: null | {
    uploadId: string
    runId: string
    displayName: string
    extractedTextHash: string
    sourceSha256: string
    objectGeneration: string
    storageVersionId: string
    objectKey: string
  }
  scannerExtraction: null | {
    uploadId: string
    runId: string
    displayName: string
    extractedTextHash: string
    sourceSha256: string
    objectGeneration: string
    storageVersionId: string
    objectKey: string
  }
}

let fixture: FixtureState | null = null

function tokenMatches(candidate: string, expected: string) {
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function resolveFixtureSession(
  authorization: string | undefined,
  sessions: Map<string, FixtureSession>,
) {
  const candidate = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1]
  if (!candidate) return null
  for (const [token, session] of sessions) {
    if (tokenMatches(candidate, token)) return session
  }
  return null
}

function installSyntheticAuthModule() {
  const authEntryUrl = pathToFileURL(
    resolve(__dirname, '../../../../packages/auth/src/index.ts'),
  ).href
  const permissionsUrl = pathToFileURL(
    resolve(__dirname, '../../../../packages/auth/src/permissions.ts'),
  ).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@pathfinder/auth' || specifier === authEntryUrl)
        return { url: 'fixture:pathfinder-auth', shortCircuit: true }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url !== 'fixture:pathfinder-auth' && url !== authEntryUrl) return nextLoad(url, context)
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export { requireTenantRole, requirePlatformAdmin } from ${JSON.stringify(permissionsUrl)}
          const unavailable = async () => { throw new Error('Unavailable in connected fixture') }
          export const createOrganization = unavailable
          export const currentUser = unavailable
          export const ensureOrganizationInvitation = unavailable
          export const inviteOrganizationMember = unavailable
          export const listPendingOrganizationInvitations = unavailable
          export const requireAuth = unavailable
          export const validateExistingOrganizationOwner = unavailable
          export const resolveSession = async () => null
        `,
      }
    },
  })
}

async function startFixtureServer(): Promise<FixtureState> {
  installSyntheticAuthModule()
  installFreshStorageTransport()
  const { appRouter } = await import('@pathfinder/api')
  const tokens = {
    owner: randomUUID(),
    other: randomUUID(),
    staff: randomUUID(),
    admin: randomUUID(),
  }
  const sessions = new Map<string, FixtureSession>([
    [
      tokens.owner,
      { userId: ownerUserId, activeTenantId: tenantId, role: 'OWNER', isPlatformAdmin: false },
    ],
    [
      tokens.other,
      { userId: otherUserId, activeTenantId: tenantId, role: 'OWNER', isPlatformAdmin: false },
    ],
    [
      tokens.staff,
      { userId: staffUserId, activeTenantId: tenantId, role: 'STAFF', isPlatformAdmin: false },
    ],
    [
      tokens.admin,
      { userId: adminUserId, activeTenantId: tenantId, role: 'OWNER', isPlatformAdmin: true },
    ],
  ])
  const sourceRequests: Array<Record<string, unknown>> = []
  const sourceResponseCursors: Array<string | null> = []

  const seeded = await withTenantIsolationBypass(async () => {
    await db.tenant.createMany({
      data: [
        { id: tenantId, name: 'Connected onboarding fixture', slug: tenantId },
        { id: otherTenantId, name: 'Other connected fixture', slug: otherTenantId },
      ],
    })
    await db.user.createMany({
      data: [ownerUserId, otherUserId, staffUserId, adminUserId].map((id) => ({
        id,
        email: `${id}@example.test`,
      })),
    })
    await db.tenantMembership.createMany({
      data: [
        { tenantId, userId: ownerUserId, role: 'OWNER', joinedAt: new Date() },
        { tenantId, userId: otherUserId, role: 'OWNER', joinedAt: new Date() },
        { tenantId, userId: staffUserId, role: 'STAFF', joinedAt: new Date() },
      ],
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Great Lakes Discovery Museum', slug: venueId },
    })
    await saveIntakeSubmissionDraft({
      tenantId,
      venueId,
      ownerUserId,
      sourceKind: 'NOTES',
      expectedRevision: 0,
      content: { kind: 'NOTES', notes: originalDraft },
    })

    const bytes = Buffer.from(extractedText, 'utf8')
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
    const objectGeneration = randomUUID()
    const storageVersionId = 'connected-source-version-1'
    const actor = { type: 'HUMAN' as const, id: ownerUserId, role: 'OWNER' as const }
    const reserved = await reserveIntakeUploadAction({
      tenantId,
      venueId,
      actor,
      request: {
        requestId: randomUUID(),
        displayName: 'Connected visitor services handbook',
        fileName: 'connected-visitor-services.txt',
        mimeType: 'text/plain',
        category: 'DOCUMENT',
        byteSize: bytes.byteLength,
        sha256: sourceSha256,
      },
      trustedObjectIdentity: {
        objectKey: `intake-quarantine/${randomUUID()}`,
        objectGeneration,
      },
    })
    const precheckClaim = randomUUID()
    await claimIntakeUploadVerificationAction({
      tenantId,
      venueId,
      uploadId: reserved.upload.id,
      actor,
      claimId: precheckClaim,
    })
    await recordIntakeUploadPrecheckAction({
      tenantId,
      venueId,
      uploadId: reserved.upload.id,
      actor,
      claimId: precheckClaim,
      verified: {
        objectGeneration,
        storageVersionId,
        mimeType: 'text/plain',
        byteSize: bytes.byteLength,
        sha256: sourceSha256,
      },
      evidence: {
        engine: 'connected-fixture-magic-bytes',
        engineVersion: '1',
        verdictHash: createHash('sha256').update('connected-precheck-passed').digest('hex'),
        computedByteSize: bytes.byteLength,
        computedSha256: sourceSha256,
      },
    })
    const authoritativeClaim = randomUUID()
    await claimIntakeUploadVerificationAction({
      tenantId,
      venueId,
      uploadId: reserved.upload.id,
      actor,
      claimId: authoritativeClaim,
    })
    await settleIntakeUploadAuthoritativeVerificationAction({
      tenantId,
      venueId,
      uploadId: reserved.upload.id,
      actor,
      claimId: authoritativeClaim,
      malware: {
        verdict: 'CLEAN',
        engine: 'connected-fixture-malware',
        engineVersion: '1',
        verdictHash: createHash('sha256').update('connected-malware-clean').digest('hex'),
        computedByteSize: bytes.byteLength,
        computedSha256: sourceSha256,
      },
    })
    const upload = await db.intakeUpload.findUniqueOrThrow({
      where: { id: reserved.upload.id },
      select: { intakeRunId: true },
    })
    if (!upload.intakeRunId) throw new Error('Connected upload did not create an intake run')
    const receiptId = randomUUID()
    const extractedTextHash = createHash('sha256').update(extractedText).digest('hex')
    await recordIntakeFileExtractionReceiptAction({
      operationId: receiptId,
      tenantId,
      venueId,
      runId: upload.intakeRunId,
      uploadId: reserved.upload.id,
      requestHash: createHash('sha256').update('connected-extraction-request').digest('hex'),
      outcome: 'SUCCEEDED',
      sourceObjectGeneration: objectGeneration,
      sourceStorageVersionId: storageVersionId,
      sourceSha256,
      sourceByteSize: bytes.byteLength,
      sourceMimeType: 'text/plain',
      extractor: 'pathfinder-utf8-document',
      extractorVersion: '1',
      extractedText,
      extractedTextHash,
      extractedCharacterCount: [...extractedText].length,
      extractedLineCount: extractedText.split('\n').length,
      createdBy: adminUserId,
    })
    let freshExtraction: FixtureState['freshExtraction'] = null
    if (freshExtractionEnabled) {
      const freshBytes = Buffer.from(freshExtractedText, 'utf8')
      const freshSourceSha256 = createHash('sha256').update(freshBytes).digest('hex')
      const freshObjectGeneration = randomUUID()
      const freshStorageVersionId = 'connected-fresh-source-version-1'
      const freshObjectKey = `intake-quarantine/${randomUUID()}`
      const freshReserved = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor,
        request: {
          requestId: randomUUID(),
          displayName: 'Connected fresh extraction handbook',
          fileName: 'connected-fresh-extraction.txt',
          mimeType: 'text/plain',
          category: 'DOCUMENT',
          byteSize: freshBytes.byteLength,
          sha256: freshSourceSha256,
        },
        trustedObjectIdentity: {
          objectKey: freshObjectKey,
          objectGeneration: freshObjectGeneration,
        },
      })
      const freshPrecheckClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: freshReserved.upload.id,
        actor,
        claimId: freshPrecheckClaim,
      })
      await recordIntakeUploadPrecheckAction({
        tenantId,
        venueId,
        uploadId: freshReserved.upload.id,
        actor,
        claimId: freshPrecheckClaim,
        verified: {
          objectGeneration: freshObjectGeneration,
          storageVersionId: freshStorageVersionId,
          mimeType: 'text/plain',
          byteSize: freshBytes.byteLength,
          sha256: freshSourceSha256,
        },
        evidence: {
          engine: 'connected-fresh-fixture-magic-bytes',
          engineVersion: '1',
          verdictHash: createHash('sha256').update('connected-fresh-precheck-passed').digest('hex'),
          computedByteSize: freshBytes.byteLength,
          computedSha256: freshSourceSha256,
        },
      })
      const freshAuthoritativeClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: freshReserved.upload.id,
        actor,
        claimId: freshAuthoritativeClaim,
      })
      await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId: freshReserved.upload.id,
        actor,
        claimId: freshAuthoritativeClaim,
        malware: {
          verdict: 'CLEAN',
          engine: 'connected-fresh-fixture-malware',
          engineVersion: '1',
          verdictHash: createHash('sha256').update('connected-fresh-malware-clean').digest('hex'),
          computedByteSize: freshBytes.byteLength,
          computedSha256: freshSourceSha256,
        },
      })
      const freshUpload = await db.intakeUpload.findUniqueOrThrow({
        where: { id: freshReserved.upload.id },
        select: { intakeRunId: true },
      })
      if (!freshUpload.intakeRunId) {
        throw new Error('Fresh connected upload did not create an intake run')
      }
      freshStorageObjects.set(freshObjectKey, {
        versionId: freshStorageVersionId,
        bytes: freshBytes,
        reads: 0,
      })
      freshExtraction = {
        uploadId: freshReserved.upload.id,
        runId: freshUpload.intakeRunId,
        displayName: 'Connected fresh extraction handbook',
        extractedTextHash: createHash('sha256').update(freshExtractedText).digest('hex'),
        sourceSha256: freshSourceSha256,
        objectGeneration: freshObjectGeneration,
        storageVersionId: freshStorageVersionId,
        objectKey: freshObjectKey,
      }
    }
    return {
      runId: upload.intakeRunId,
      uploadId: reserved.upload.id,
      receiptId,
      extractedTextHash,
      sourceSha256,
      objectGeneration,
      storageVersionId,
      freshExtraction,
      scannerExtraction: null,
    }
  })

  const server = createServer(async (request, response) => {
    const timeout = setTimeout(() => {
      if (!response.headersSent) response.writeHead(504)
      response.end()
    }, 15_000)
    try {
      if (
        !request.url?.startsWith('/api/trpc/') ||
        !['GET', 'POST'].includes(request.method ?? '')
      ) {
        response.writeHead(404).end()
        return
      }
      const session = resolveFixtureSession(request.headers.authorization, sessions)
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 1024 * 1024) {
          response.writeHead(413).end()
          return
        }
        chunks.push(buffer)
      }
      const body = Buffer.concat(chunks)
      if (request.url.includes('readIntakeFileExtractionSource')) {
        const encoded = new URL(request.url, 'http://127.0.0.1').searchParams.get('input')
        if (encoded) {
          const parsed = JSON.parse(encoded) as Record<string, unknown>
          const envelope = (parsed['0'] ?? parsed) as Record<string, unknown>
          const input = envelope.json
          sourceRequests.push(
            typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
          )
        }
      }
      const webRequest = new Request(`http://127.0.0.1${request.url}`, {
        method: request.method ?? 'GET',
        headers: new Headers(
          Object.entries(request.headers).flatMap(([key, value]) =>
            value === undefined
              ? []
              : [[key, Array.isArray(value) ? value.join(', ') : value] as [string, string]],
          ),
        ),
        ...(body.length ? { body } : {}),
      })
      const result = await fetchRequestHandler({
        endpoint: '/api/trpc',
        req: webRequest,
        router: appRouter,
        onError: ({ error, path }) => {
          process.stderr.write(
            JSON.stringify({
              fixture: 'connected-onboarding',
              path,
              code: error.code,
              message: error.message,
            }) + '\n',
          )
        },
        createContext: () => ({
          db,
          headers: webRequest.headers,
          session:
            session ??
            ({ userId: null, activeTenantId: null, role: null, isPlatformAdmin: false } as const),
        }),
      })
      const responseBody = Buffer.from(await result.arrayBuffer())
      if (request.url.includes('readIntakeFileExtractionSource')) {
        const payload = JSON.parse(responseBody.toString('utf8')) as
          | Array<{ result?: { data?: { json?: { nextCursor?: unknown } } } }>
          | { result?: { data?: { json?: { nextCursor?: unknown } } } }
        const envelope = Array.isArray(payload) ? payload[0] : payload
        const nextCursor = envelope?.result?.data?.json?.nextCursor
        sourceResponseCursors.push(typeof nextCursor === 'string' ? nextCursor : null)
      }
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
      response.end(responseBody)
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    } finally {
      clearTimeout(timeout)
    }
  })
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Connected tRPC fixture unavailable')
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}`,
    tokens,
    sessions,
    ...seeded,
    sourceRequests,
    sourceResponseCursors,
  }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

async function connectedContext(
  browser: Browser,
  token: string,
  viewport: { width: number; height: number },
) {
  if (!fixture) throw new Error('Connected fixture is unavailable')
  const context = await browser.newContext({
    baseURL: dashboardBaseURL,
    viewport,
  })
  await context.route('**/api/trpc/**', async (route) => {
    const source = new URL(route.request().url())
    const forwarded = `${fixture!.endpoint}${source.pathname}${source.search}`
    const result = await route.fetch({
      url: forwarded,
      headers: { ...route.request().headers(), authorization: `Bearer ${token}` },
    })
    await route.fulfill({ response: result })
  })
  return context
}

async function selectNotes(context: BrowserContext) {
  const page = await context.newPage()
  await page.goto(remoteOnboardingFixtureUrl)
  await expect(page.getByText('Loading saved work…')).toBeHidden()
  await page.getByRole('radio', { name: 'Optional notes' }).check()
  return { page, notes: page.getByRole('textbox', { name: 'Notes', exact: true }) }
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      })),
    )
    .toMatchObject({
      documentWidth: page.viewportSize()!.width,
      viewportWidth: page.viewportSize()!.width,
    })
}

async function captureEvidence(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test.describe('connected onboarding on disposable PostgreSQL', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!enabled, 'requires the guarded disposable onboarding database')

  test.beforeAll(async () => {
    fixture = await startFixtureServer()
  })

  test.afterAll(async () => {
    restoreFreshStorageTransport?.()
    restoreFreshStorageTransport = null
    if (fixture) await closeServer(fixture.server)
    await db.$disconnect()
  })

  test.afterEach(() => {
    setOpenAiEmbeddingsClientForTesting(null)
  })

  test('retains drafts across reload and browser contexts without hiding CAS or permission loss', async ({
    browser,
  }, testInfo) => {
    const state = fixture!
    const contextA = await connectedContext(browser, state.tokens.owner, {
      width: 320,
      height: 568,
    })
    const contextB = await connectedContext(browser, state.tokens.owner, {
      width: 320,
      height: 568,
    })
    try {
      const first = await selectNotes(contextA)
      const second = await selectNotes(contextB)
      await expect(first.notes).toHaveValue(originalDraft)
      await expect(second.notes).toHaveValue(originalDraft)
      await expectNoHorizontalOverflow(first.page)

      const firstSave = first.page.waitForResponse((response) =>
        response.url().includes('/api/trpc/intake.saveSubmissionDraft'),
      )
      await first.notes.fill(winnerDraft)
      expect((await firstSave).status()).toBe(200)
      await expect
        .poll(async () =>
          withTenantIsolationBypass(
            async () =>
              (
                await getIntakeSubmissionDraft({
                  tenantId,
                  venueId,
                  ownerUserId,
                  sourceKind: 'NOTES',
                })
              )?.revision,
          ),
        )
        .toBe(2)
      await expect(first.page.getByText('Saved', { exact: true })).toBeVisible()
      await first.page.reload()
      await expect(first.page.getByText('Loading saved work…')).toBeHidden()
      await first.page.getByRole('radio', { name: 'Optional notes' }).check()
      await expect(first.page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(
        winnerDraft,
      )

      const conflictingSave = second.page.waitForResponse((response) =>
        response.url().includes('/api/trpc/intake.saveSubmissionDraft'),
      )
      await second.notes.fill(staleDraft)
      expect(await (await conflictingSave).text()).toContain('CONFLICT')
      await expect(
        second.page.getByText('This draft changed elsewhere. Reload before continuing.'),
      ).toBeVisible()
      await expect(second.notes).toHaveValue(staleDraft)
      await captureEvidence(second.page, testInfo, 'draft-conflict-320')
      await second.page.reload()
      await expect(second.page.getByText('Loading saved work…')).toBeHidden()
      await second.page.getByRole('radio', { name: 'Optional notes' }).check()
      await expect(second.page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(
        winnerDraft,
      )
      const secondSave = second.page.waitForResponse((response) =>
        response.url().includes('/api/trpc/intake.saveSubmissionDraft'),
      )
      await second.page.getByRole('textbox', { name: 'Notes', exact: true }).fill(secondDeviceDraft)
      expect((await secondSave).status()).toBe(200)
      await expect
        .poll(async () =>
          withTenantIsolationBypass(
            async () =>
              (
                await getIntakeSubmissionDraft({
                  tenantId,
                  venueId,
                  ownerUserId,
                  sourceKind: 'NOTES',
                })
              )?.revision,
          ),
        )
        .toBe(3)
      await expect(second.page.getByText('Saved', { exact: true })).toBeVisible()
      await first.page.reload()
      await expect(first.page.getByText('Loading saved work…')).toBeHidden()
      await first.page.getByRole('radio', { name: 'Optional notes' }).check()
      await expect(first.page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(
        secondDeviceDraft,
      )

      state.sessions.set(state.tokens.owner, {
        userId: ownerUserId,
        activeTenantId: tenantId,
        role: 'STAFF',
        isPlatformAdmin: false,
      })
      await first.page
        .getByRole('textbox', { name: 'Notes', exact: true })
        .fill('This unsaved text survives permission loss.')
      await expect(
        first.page.getByText(
          'Could not save. Your edits remain on this page; retry by editing again.',
        ),
      ).toBeVisible()
      await expect(first.page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(
        'This unsaved text survives permission loss.',
      )
      await captureEvidence(first.page, testInfo, 'draft-permission-loss-320')
      await expect(
        withTenantIsolationBypass(() =>
          getIntakeSubmissionDraft({ tenantId, venueId, ownerUserId, sourceKind: 'NOTES' }),
        ),
      ).resolves.toMatchObject({
        content: { kind: 'NOTES', notes: secondDeviceDraft },
        revision: 3,
      })

      const roleChanged = await connectedContext(browser, state.tokens.owner, {
        width: 320,
        height: 568,
      })
      try {
        const deniedReload = await selectNotes(roleChanged)
        await expect(deniedReload.notes).toHaveValue('')
        await expect(deniedReload.page.getByText(secondDeviceDraft)).toHaveCount(0)
      } finally {
        await roleChanged.close()
      }

      const other = await connectedContext(browser, state.tokens.other, { width: 320, height: 568 })
      try {
        const isolated = await selectNotes(other)
        await expect(isolated.notes).toHaveValue('')
        await expect(isolated.page.getByText(secondDeviceDraft)).toHaveCount(0)
      } finally {
        await other.close()
      }
      expect(
        await withTenantIsolationBypass(() => db.intakeRun.count({ where: { tenantId, venueId } })),
      ).toBe(state.freshExtraction ? 2 : 1)
      expect(
        await withTenantIsolationBypass(() =>
          db.intakeRun.count({
            where: { tenantId, venueId, sourceKind: { not: 'FILE_UPLOAD' } },
          }),
        ),
      ).toBe(0)
      expect(
        await withTenantIsolationBypass(() =>
          db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
        ),
      ).toBe(0)
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })

  test('reads the exact retained extraction beyond 4,000 characters and denies wrong scope or role', async ({
    browser,
  }, testInfo) => {
    const state = fixture!
    const admin = await connectedContext(browser, state.tokens.admin, { width: 820, height: 1180 })
    const url = `/dev-fixtures/connected-intake-reader?tenantId=${tenantId}&venueId=${venueId}&runId=${state.runId}`
    try {
      const page = await admin.newPage()
      await page.goto(url)
      await page.getByRole('button', { name: /Builder status/iu }).click()
      await expect(page.getByText('Bounded preview', { exact: true })).toBeVisible()
      await expect(
        page.getByText('Bounded preview', { exact: true }).locator('..').locator('pre'),
      ).toHaveText(Array.from(extractedText).slice(0, 4_000).join(''))
      await expect(page.getByText(/private evidence, not venue truth/iu)).toBeVisible()
      await expect(page.getByText(/does not open the original upload/iu)).toBeVisible()
      await page.getByRole('button', { name: 'Read full extracted source' }).click()
      await expect(page.getByText(/Characters 0–4,000 of/iu)).toBeVisible()
      await expect(
        page.getByRole('region', { name: 'Retained source reader' }).locator('pre'),
      ).toHaveText(Array.from(extractedText).slice(0, 4_000).join(''))
      await expectNoHorizontalOverflow(page)
      await page.getByRole('button', { name: 'Next page' }).click()
      await expect(page.getByText(/Characters 4,000–/iu)).toBeVisible()
      await expect(page.getByText(beyondPreviewFact, { exact: false })).toBeVisible()
      await captureEvidence(page, testInfo, 'retained-source-page-two-820')

      expect(state.sourceRequests).toHaveLength(2)
      expect(state.sourceResponseCursors).toHaveLength(2)
      const firstInput = state.sourceRequests[0]
      const secondInput = state.sourceRequests[1]
      expect(firstInput).toMatchObject({
        tenantId,
        venueId,
        runId: state.runId,
        receiptId: state.receiptId,
        expectedExtractedTextHash: state.extractedTextHash,
        pageSize: 4_000,
      })
      expect(firstInput).not.toHaveProperty('cursor')
      expect(state.sourceResponseCursors[0]).toEqual(expect.any(String))
      expect(secondInput).toMatchObject({
        tenantId,
        venueId,
        runId: state.runId,
        receiptId: state.receiptId,
        expectedExtractedTextHash: state.extractedTextHash,
        pageSize: 4_000,
        cursor: state.sourceResponseCursors[0],
      })
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(page.getByText(beyondPreviewFact, { exact: false })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await captureEvidence(page, testInfo, 'retained-source-page-two-1440')

      const staff = await connectedContext(browser, state.tokens.staff, {
        width: 820,
        height: 1180,
      })
      try {
        const denied = await staff.newPage()
        await denied.goto(url)
        await denied.getByRole('button', { name: /Builder status/iu }).click()
        await expect(
          denied.getByText(
            'Builder lifecycle is unavailable. Retry to inspect the latest retained state.',
          ),
        ).toBeVisible()
        await expect(denied.getByText(beyondPreviewFact, { exact: false })).toHaveCount(0)
      } finally {
        await staff.close()
      }

      const wrongScope = await admin.newPage()
      await wrongScope.goto(
        `/dev-fixtures/connected-intake-reader?tenantId=${otherTenantId}&venueId=${venueId}&runId=${state.runId}`,
      )
      await wrongScope.getByRole('button', { name: /Builder status/iu }).click()
      await expect(
        wrongScope.getByText(
          'Builder lifecycle is unavailable. Retry to inspect the latest retained state.',
        ),
      ).toBeVisible()
      await expect(wrongScope.getByText(beyondPreviewFact, { exact: false })).toHaveCount(0)

      await expect(
        withTenantIsolationBypass(() =>
          db.intakeUpload.findFirstOrThrow({
            where: { id: state.uploadId, tenantId, venueId },
            select: {
              status: true,
              sha256: true,
              objectGeneration: true,
              storageVersionId: true,
            },
          }),
        ),
      ).resolves.toEqual({
        status: 'AWAITING_REVIEW',
        sha256: state.sourceSha256,
        objectGeneration: state.objectGeneration,
        storageVersionId: state.storageVersionId,
      })
      await expect(
        withTenantIsolationBypass(() =>
          db.intakeFileExtractionReceipt.findFirstOrThrow({
            where: { id: state.receiptId, tenantId, venueId, runId: state.runId },
            select: {
              outcome: true,
              extractedTextHash: true,
              extractedCharacterCount: true,
              sourceSha256: true,
            },
          }),
        ),
      ).resolves.toEqual({
        outcome: 'SUCCEEDED',
        extractedTextHash: state.extractedTextHash,
        extractedCharacterCount: [...extractedText].length,
        sourceSha256: state.sourceSha256,
      })
      expect(
        await withTenantIsolationBypass(() =>
          db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
        ),
      ).toBe(0)
    } finally {
      await admin.close()
    }
  })
  if (scannerTransportEnabled) {
    test('routes exact browser uploads through the registered disposable scanner', async ({
      browser,
    }, testInfo) => {
      const state = fixture!
      const cleanBytes = Buffer.from(scannerCleanText, 'utf8')
      const markerBytes = Buffer.from('TORCHIKO_FIXTURE_TEXT_MARKER_20260908_8C1F4E2A\n', 'utf8')
      expect(createHash('sha256').update(markerBytes).digest('hex')).toBe(
        '9b20982a05f466a4ec3482fa7edc1a4dd01f9653bfeb97aff58f2efb7c809410',
      )
      state.sessions.set(state.tokens.owner, {
        userId: ownerUserId,
        activeTenantId: tenantId,
        role: 'OWNER',
        isPlatformAdmin: false,
      })
      const context = await connectedContext(browser, state.tokens.owner, {
        width: 390,
        height: 844,
      })
      let resources: { worker: unknown; close(): Promise<void> } | null = null
      let closeJobQueues: (() => Promise<void>) | null = null
      let closeBullMQConnection: (() => Promise<void>) | null = null
      try {
        const sdk = createRequire(resolve(__dirname, '../../../../packages/api/package.json'))(
          '@aws-sdk/client-s3',
        ) as {
          S3Client: new (input: Record<string, unknown>) => {
            send(command: unknown): Promise<unknown>
            destroy(): void
          }
          CreateBucketCommand: new (input: Record<string, unknown>) => unknown
          PutBucketVersioningCommand: new (input: Record<string, unknown>) => unknown
        }
        const storage = new sdk.S3Client({
          endpoint: process.env.STORAGE_ENDPOINT!,
          region: process.env.STORAGE_REGION!,
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
            secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
          },
        })
        try {
          await storage.send(new sdk.CreateBucketCommand({ Bucket: process.env.STORAGE_BUCKET! }))
          await storage.send(
            new sdk.PutBucketVersioningCommand({
              Bucket: process.env.STORAGE_BUCKET!,
              VersioningConfiguration: { Status: 'Enabled' },
            }),
          )
          const page = await context.newPage()
          await page.goto(remoteOnboardingFixtureUrl)
          await expect(page.getByText('Loading saved work…')).toBeHidden()
          await page.getByLabel('Choose files').setInputFiles([
            { name: 'scanner-clean.txt', mimeType: 'text/plain', buffer: cleanBytes },
            {
              name: 'harmless-marker.txt',
              mimeType: 'text/plain',
              buffer: markerBytes,
            },
          ])
          const storageOrigin = new URL(process.env.STORAGE_ENDPOINT!).origin
          let putCount = 0
          page.on('response', (response) => {
            if (
              response.request().method() === 'PUT' &&
              new URL(response.url()).origin === storageOrigin &&
              response.status() === 200
            )
              putCount += 1
          })
          await page.getByRole('button', { name: 'Upload', exact: true }).first().click()
          await expect(page.getByText('Security check pending', { exact: true })).toHaveCount(1)
          await page.getByRole('button', { name: 'Upload', exact: true }).click()
          await expect(page.getByText('Security check pending', { exact: true })).toHaveCount(2)
          expect(putCount).toBe(2)

          await expect
            .poll(
              () =>
                withTenantIsolationBypass(() =>
                  db.intakeUpload.findMany({
                    where: {
                      tenantId,
                      venueId,
                      fileName: { in: ['scanner-clean.txt', 'harmless-marker.txt'] },
                    },
                    orderBy: { fileName: 'asc' },
                    select: { id: true, fileName: true, status: true, storageVersionId: true },
                  }),
                ),
              { timeout: 30_000 },
            )
            .toMatchObject([
              { fileName: 'harmless-marker.txt', status: 'PRECHECK_PASSED' },
              { fileName: 'scanner-clean.txt', status: 'PRECHECK_PASSED' },
            ])
          const persisted = await withTenantIsolationBypass(() =>
            db.intakeUpload.findMany({
              where: {
                tenantId,
                venueId,
                fileName: { in: ['scanner-clean.txt', 'harmless-marker.txt'] },
              },
              orderBy: { fileName: 'asc' },
              select: { id: true, fileName: true, storageVersionId: true },
            }),
          )
          const { createIntakeUploadVerificationResources } =
            await import('../../../workers/src/intake-upload-verification-runtime')
          const jobs = await import('@pathfinder/jobs')
          closeJobQueues = jobs.closeJobQueues
          closeBullMQConnection = jobs.closeBullMQConnection
          resources = await createIntakeUploadVerificationResources()
          expect(resources.worker).toBeTruthy()

          await expect
            .poll(
              () =>
                withTenantIsolationBypass(() =>
                  db.intakeUpload.findMany({
                    where: { id: { in: persisted.map(({ id }) => id) }, tenantId, venueId },
                    orderBy: { fileName: 'asc' },
                    select: { fileName: true, status: true, intakeRunId: true },
                  }),
                ),
              { timeout: 30_000 },
            )
            .toEqual([
              { fileName: 'harmless-marker.txt', status: 'REJECTED', intakeRunId: null },
              {
                fileName: 'scanner-clean.txt',
                status: 'AWAITING_REVIEW',
                intakeRunId: expect.any(String),
              },
            ])
          const receipts = await withTenantIsolationBypass(() =>
            db.intakeUploadVerificationReceipt.findMany({
              where: { tenantId, venueId, uploadId: { in: persisted.map(({ id }) => id) } },
              orderBy: [{ uploadId: 'asc' }, { kind: 'asc' }],
              select: {
                uploadId: true,
                kind: true,
                verdict: true,
                engine: true,
                engineVersion: true,
                claimId: true,
                computedSha256: true,
                storageVersionId: true,
              },
            }),
          )
          for (const upload of persisted) {
            const exact = receipts.filter(({ uploadId }) => uploadId === upload.id)
            expect(upload.storageVersionId).toEqual(expect.any(String))
            expect(upload.storageVersionId).not.toBe('')
            expect(exact).toHaveLength(3)
            const authoritative = exact.filter(({ kind }) => kind !== 'PRECHECK')
            expect(authoritative).toHaveLength(2)
            expect(new Set(authoritative.map(({ claimId }) => claimId)).size).toBe(1)
            expect(authoritative[0]?.claimId).toEqual(expect.any(String))
            expect(exact).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ kind: 'PRECHECK', verdict: 'PASSED' }),
                expect.objectContaining({ kind: 'RESOURCE_SAFETY', verdict: 'PASSED' }),
                expect.objectContaining({
                  kind: 'MALWARE',
                  verdict: upload.fileName === 'scanner-clean.txt' ? 'CLEAN' : 'REJECTED',
                  engine: 'clamav-clamd',
                  engineVersion: 'daemon',
                  computedSha256:
                    upload.fileName === 'scanner-clean.txt'
                      ? createHash('sha256').update(cleanBytes).digest('hex')
                      : createHash('sha256').update(markerBytes).digest('hex'),
                  storageVersionId: upload.storageVersionId,
                }),
              ]),
            )
          }
          const cleanUpload = await withTenantIsolationBypass(() =>
            db.intakeUpload.findFirstOrThrow({
              where: { tenantId, venueId, fileName: 'scanner-clean.txt' },
              select: {
                id: true,
                intakeRunId: true,
                sha256: true,
                objectGeneration: true,
                storageVersionId: true,
                objectKey: true,
              },
            }),
          )
          if (!cleanUpload.intakeRunId || !cleanUpload.storageVersionId)
            throw new Error('Clean scanner upload did not produce exact extraction identity')
          state.scannerExtraction = {
            uploadId: cleanUpload.id,
            runId: cleanUpload.intakeRunId,
            displayName: 'scanner-clean.txt',
            extractedTextHash: createHash('sha256').update(cleanBytes).digest('hex'),
            sourceSha256: cleanUpload.sha256,
            objectGeneration: cleanUpload.objectGeneration,
            storageVersionId: cleanUpload.storageVersionId,
            objectKey: cleanUpload.objectKey,
          }
          await testInfo.attach('browser-upload-scanner-identity', {
            body: JSON.stringify({
              tenantId,
              venueId,
              putCount,
              markerSha256: createHash('sha256').update(markerBytes).digest('hex'),
              uploads: persisted,
              receipts,
              scanner: `${process.env.INTAKE_CLAMAV_HOST}:${process.env.INTAKE_CLAMAV_PORT}`,
            }),
            contentType: 'application/json',
          })
        } finally {
          storage.destroy()
        }
      } finally {
        try {
          await resources?.close()
        } finally {
          try {
            await closeJobQueues?.()
          } finally {
            await closeBullMQConnection?.()
            await context.close()
          }
        }
      }
    })
  }

  test('submits the verified owner file once through the real router and retains processing identity', async ({
    browser,
  }, testInfo) => {
    const state = fixture!
    const submittedSource = state.scannerExtraction ??
      state.freshExtraction ?? {
        uploadId: state.uploadId,
        runId: state.runId,
        displayName: 'Connected visitor services handbook',
        extractedTextHash: state.extractedTextHash,
        sourceSha256: state.sourceSha256,
        objectGeneration: state.objectGeneration,
        storageVersionId: state.storageVersionId,
        objectKey: null,
      }
    let submittedReceiptId: string | null =
      state.scannerExtraction || state.freshExtraction ? null : state.receiptId
    state.sessions.set(state.tokens.owner, {
      userId: ownerUserId,
      activeTenantId: tenantId,
      role: 'OWNER',
      isPlatformAdmin: false,
    })
    const context = await connectedContext(browser, state.tokens.owner, { width: 390, height: 844 })
    try {
      const page = await context.newPage()
      await page.goto(remoteOnboardingFixtureUrl)
      await expect(page.getByText('Loading saved work…')).toBeHidden()
      await page.getByRole('button', { name: 'Review my materials', exact: true }).click()
      const historicalFile = page.getByRole('checkbox', {
        name: /Connected visitor services handbook/,
      })
      await expect(historicalFile).toBeChecked()
      if (state.scannerExtraction || state.freshExtraction) {
        const freshFile = page.getByRole('checkbox', { name: submittedSource.displayName })
        await historicalFile.uncheck()
        await freshFile.check()
      }
      const notes = page.getByRole('checkbox', { name: /Shared notes draft/ })
      if (await notes.count()) await notes.uncheck()
      const submitted = page.waitForResponse((response) =>
        response.url().includes('/api/trpc/intake.submitV1'),
      )
      await page
        .getByRole('button', { name: 'Submit this version', exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click()
          button.click()
        })
      const response = await submitted
      expect(await response.text()).not.toContain('"error"')
      await expect(page.getByText('Version 1 received', { exact: true })).toBeVisible()
      await expect(page.getByText('Material processing', { exact: true })).toBeVisible()
      await expect(
        page.getByText(
          'Processing details could not be refreshed. Your saved submission is unchanged.',
        ),
      ).toHaveCount(0)
      const saved = await withTenantIsolationBypass(async () => {
        const submissions = await db.intakeV1Submission.findMany({
          where: { tenantId, venueId, ownerUserId },
          include: { revisions: { include: { members: true } } },
        })
        expect(submissions).toHaveLength(1)
        const revision = submissions[0]!.revisions[0]!
        expect(revision.members).toHaveLength(1)
        expect(revision.members[0]).toMatchObject({
          kind: 'INTAKE_UPLOAD',
          intakeUploadId: submittedSource.uploadId,
        })
        const dispatches = await db.intakeV1ProcessingDispatch.findMany({
          where: { tenantId, venueId, revisionId: revision.id },
        })
        expect(dispatches).toHaveLength(1)
        expect(dispatches[0]).toMatchObject({
          kind: 'FILE_EXTRACTION',
          status: 'PENDING',
          sourceHash: revision.members[0]!.immutableHash,
        })
        expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(0)
        return {
          submissionId: submissions[0]!.id,
          manifestHash: revision.manifestHash,
          dispatchId: dispatches[0]!.id,
          memberId: revision.members[0]!.id,
        }
      })
      let redisDeliveryEvidence: Record<string, unknown> | null = null
      let extractionAttempts: number | null = null
      if (redisTransportEnabled) {
        const { createIntakeV1FileExtractionResources } =
          await import('../../../workers/src/intake-v1-file-extraction-runtime')
        const {
          closeBullMQConnection,
          closeJobQueues,
          INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB,
          INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB,
        } = await import('@pathfinder/jobs')
        if (submittedSource.objectKey) {
          if (state.freshExtraction)
            expect(freshStorageObjects.get(submittedSource.objectKey)?.reads).toBe(0)
          expect(
            await withTenantIsolationBypass(() =>
              db.intakeFileExtractionReceipt.count({
                where: { tenantId, venueId, uploadId: submittedSource.uploadId },
              }),
            ),
          ).toBe(0)
        }
        const resources = await createIntakeV1FileExtractionResources()
        try {
          const first = await waitForWorkerResult(
            resources.worker,
            (job) =>
              job.name === INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB &&
              job.data?.dispatchId === saved.dispatchId,
            () => resources.queue.add(INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB, {}),
          )
          if (submittedSource.objectKey) {
            expect(first).toMatchObject({ result: 'completed', state: 'unknown' })
            const completed = await withTenantIsolationBypass(() =>
              db.intakeV1ProcessingDispatch.findFirstOrThrow({
                where: { id: saved.dispatchId, tenantId, venueId },
                select: { status: true, fileExtractionReceiptId: true, attempts: true },
              }),
            )
            expect(completed).toMatchObject({ status: 'COMPLETED', attempts: 1 })
            extractionAttempts = completed.attempts
            expect(completed.fileExtractionReceiptId).toEqual(expect.any(String))
            submittedReceiptId = completed.fileExtractionReceiptId
            await expect(
              withTenantIsolationBypass(() =>
                db.intakeFileExtractionReceipt.findFirstOrThrow({
                  where: {
                    id: submittedReceiptId!,
                    tenantId,
                    venueId,
                    runId: submittedSource.runId,
                    uploadId: submittedSource.uploadId,
                  },
                  select: {
                    extractedTextHash: true,
                    sourceSha256: true,
                    sourceObjectGeneration: true,
                    sourceStorageVersionId: true,
                  },
                }),
              ),
            ).resolves.toEqual({
              extractedTextHash: submittedSource.extractedTextHash,
              sourceSha256: submittedSource.sourceSha256,
              sourceObjectGeneration: submittedSource.objectGeneration,
              sourceStorageVersionId: submittedSource.storageVersionId,
            })
            if (state.freshExtraction)
              expect(freshStorageObjects.get(submittedSource.objectKey)?.reads).toBe(1)
          } else {
            // Historical connected mode retains its pre-existing receipt. The claim transaction
            // inherits it without leasing new extraction work, and the queue removes its job.
            expect(first).toMatchObject({ result: 'not-claimed', state: 'unknown' })
            await expect(
              withTenantIsolationBypass(() =>
                db.intakeV1ProcessingDispatch.findFirstOrThrow({
                  where: { id: saved.dispatchId, tenantId, venueId },
                }),
              ),
            ).resolves.toMatchObject({
              status: 'COMPLETED',
              fileExtractionReceiptId: state.receiptId,
              attempts: 0,
            })
          }

          const replay = await waitForWorkerResult(
            resources.worker,
            (job) =>
              job.name === INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB &&
              job.data?.dispatchId === saved.dispatchId &&
              String(job.id) !== first.id,
            () =>
              resources.queue.add(
                INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB,
                { dispatchId: saved.dispatchId },
                { jobId: `connected-v1-replay-${randomUUID()}` },
              ),
          )
          expect(replay).toMatchObject({ result: 'not-claimed', state: 'completed' })
          if (submittedSource.objectKey) {
            if (state.freshExtraction)
              expect(freshStorageObjects.get(submittedSource.objectKey)?.reads).toBe(1)
            expect(
              await withTenantIsolationBypass(() =>
                db.intakeFileExtractionReceipt.count({
                  where: { tenantId, venueId, uploadId: submittedSource.uploadId },
                }),
              ),
            ).toBe(1)
          }
          redisDeliveryEvidence = {
            queueName: resources.worker.name,
            dispatchId: saved.dispatchId,
            deliveredJobId: first.id,
            deliveredResult: first.result,
            deliveredEvent: 'completed',
            deliveredJobStateAfterRemoval: first.state,
            extractionMode: state.scannerExtraction
              ? 'scanner-clean-exact-minio-read'
              : state.freshExtraction
                ? 'fresh-exact-storage-read'
                : 'inherited-existing-receipt',
            ...(state.freshExtraction
              ? {
                  storageReadCount: freshStorageObjects.get(submittedSource.objectKey!)?.reads,
                  attempts: 1,
                  receiptId: submittedReceiptId,
                  sourceSha256: submittedSource.sourceSha256,
                }
              : {}),
            replayJobId: replay.id,
            replayResult: replay.result,
          }
        } finally {
          try {
            await resources.close()
          } finally {
            try {
              await closeJobQueues()
            } finally {
              await closeBullMQConnection()
            }
          }
        }
      } else {
        // Historical connected mode retains the direct handler seam. The guarded Redis mode
        // above is the transport proof and never silently falls back to this branch.
        const { handleIntakeV1FileExtraction } =
          await import('../../../workers/src/intake-v1-file-extraction-runtime')
        const { INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB } = await import('@pathfinder/jobs')
        const job = {
          name: INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB,
          id: 'connected-v1',
          data: { dispatchId: saved.dispatchId },
        }
        await handleIntakeV1FileExtraction(
          job as Parameters<typeof handleIntakeV1FileExtraction>[0],
        )
        await handleIntakeV1FileExtraction(
          job as Parameters<typeof handleIntakeV1FileExtraction>[0],
        )
      }
      await expect(
        withTenantIsolationBypass(() =>
          db.intakeV1ProcessingDispatch.findFirstOrThrow({
            where: { id: saved.dispatchId, tenantId, venueId },
          }),
        ),
      ).resolves.toMatchObject({ status: 'COMPLETED', fileExtractionReceiptId: submittedReceiptId })
      if (!submittedReceiptId) throw new Error('Connected extraction did not retain a receipt ID')
      const { appRouter } = await import('@pathfinder/api')
      const caller = (token: string) =>
        appRouter.createCaller({ db, headers: new Headers(), session: state.sessions.get(token)! })
      const admin = caller(state.tokens.admin)
      const owner = caller(state.tokens.owner)
      const selection = {
        tenantId,
        venueId,
        submissionId: saved.submissionId,
        revision: 1,
        selectedMemberIds: [saved.memberId],
      }
      const beforeReview = await admin.admin.previewIntakeV1Package(selection)
      expect(beforeReview.ready).toBe(false)
      expect(beforeReview.members[0]).toMatchObject({ state: 'REVIEW_REQUIRED' })
      await expect(owner.admin.previewIntakeV1Package(selection)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await admin.admin.reviewIntakeFileExtraction({
        tenantId,
        venueId,
        sourceRunId: submittedSource.runId,
        receiptId: submittedReceiptId,
        operationId: randomUUID(),
        expectedExtractedTextHash: submittedSource.extractedTextHash,
        decision: 'ACCEPTED_FOR_PROPOSAL',
        proposalTitle: 'Visitor services handbook',
        proposalNotes: state.scannerExtraction
          ? scannerCleanText
          : state.freshExtraction
            ? freshExtractedText
            : beyondPreviewFact,
        rationale: state.scannerExtraction
          ? 'Reviewed the exact clean scanner source extracted from disposable storage.'
          : state.freshExtraction
            ? 'Reviewed the exact freshly extracted source.'
            : 'Reviewed the exact retained source beyond its first page.',
      })
      const ready = await admin.admin.previewIntakeV1Package(selection)
      expect(ready).toMatchObject({ ready: true, published: false })
      const command = {
        ...selection,
        operationId: randomUUID(),
        expectedManifestHash: ready.manifestHash,
        expectedCandidateHash: ready.candidateHash!,
        expectedPayloadHash: ready.payloadHash!,
        partialAcknowledged: false,
      }
      // This fixture has no inference provider. Exercise the real gate instead of
      // presenting reviewed source material as a saved or published package.
      await expect(admin.admin.createIntakeV1PackageDraft(command)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'The embedding provider is not configured; no draft was saved.',
      })
      await expect(admin.admin.createIntakeV1PackageDraft(command)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      })
      expect(
        await withTenantIsolationBypass(() =>
          db.venuePackage.count({ where: { tenantId, venueId } }),
        ),
      ).toBe(0)
      // Reuse the retained onboarding fixture's provider-only seam. Admission,
      // budget accounting, duplicate analysis, persistence and replay stay real.
      let syntheticEmbeddingCalls = 0
      let scannerPackageDraft:
        | Awaited<ReturnType<typeof admin.admin.createIntakeV1PackageDraft>>['value']
        | null = null
      setOpenAiEmbeddingsClientForTesting({
        embeddings: {
          create: async ({ input: texts, dimensions }) => {
            syntheticEmbeddingCalls += 1
            return {
              data: texts.map((_text, index) => ({
                index,
                embedding: Array.from({ length: dimensions }, (_, position) =>
                  position === index % Math.min(dimensions, 4) ? 1 : 0,
                ),
              })),
              usage: { prompt_tokens: texts.length, total_tokens: texts.length },
            }
          },
        },
      })
      try {
        const syntheticCommand = { ...command, operationId: randomUUID() }
        const draft = await admin.admin.createIntakeV1PackageDraft(syntheticCommand)
        scannerPackageDraft = draft.value
        expect(draft.value).toMatchObject({ status: 'DRAFT', replayed: false })
        const callsAfterDraft = syntheticEmbeddingCalls
        expect(callsAfterDraft).toBeGreaterThan(0)
        const replay = await admin.admin.createIntakeV1PackageDraft(syntheticCommand)
        expect(replay.value).toMatchObject({ id: draft.value.id, status: 'DRAFT', replayed: true })
        expect(syntheticEmbeddingCalls).toBe(callsAfterDraft)
        await testInfo.attach('synthetic-embedding-draft-identity', {
          body: JSON.stringify({
            packageId: draft.value.id,
            syntheticEmbeddingCalls,
            providerProof: false,
          }),
          contentType: 'application/json',
        })
      } finally {
        setOpenAiEmbeddingsClientForTesting(null)
      }
      const requestCount = () =>
        withTenantIsolationBypass(() => db.supportRequest.count({ where: { tenantId, venueId } }))
      expect(await requestCount()).toBe(0)
      if (themeRequestEnabled) {
        await page.goto(`${remoteOnboardingFixtureUrl}&v1=1`)
        const entry = page.getByRole('link', { name: 'Request guide appearance', exact: true })
        await expect(entry).toBeVisible()
        const href = new URL((await entry.getAttribute('href'))!, dashboardBaseURL)
        expect(href.pathname).toBe('/support')
        expect(href.searchParams.get('venue')).toBe(venueId)
        expect(href.searchParams.get('new')).toBe('theme-preference')
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await expectNoHorizontalOverflow(page)
          await testInfo.attach(`appearance-entry-${width}`, {
            body: await page.locator('#review').screenshot(),
            contentType: 'image/png',
          })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        expect(await requestCount()).toBe(0)
      }
      const themeBeforeRequest = themeRequestEnabled
        ? await withTenantIsolationBypass(() =>
            db.venue.findFirstOrThrow({
              where: { id: venueId, tenantId },
              select: { chatTheme: true },
            }),
          )
        : null
      await page.goto(
        `/dev-fixtures/connected-client-handoff?venueId=${encodeURIComponent(venueId)}${themeRequestEnabled ? '&new=theme-preference' : ''}`,
      )
      await expect(page.getByRole('heading', { name: 'QR kit is not available yet' })).toBeVisible()
      await expect(page.getByLabel('Subject', { exact: true })).not.toHaveValue('')
      await expect(page.getByRole('button', { name: /download.*svg/i })).toHaveCount(0)
      const supportBody = themeRequestEnabled
        ? 'Please review a calm navy guide appearance with readable labels. Keep the current guide unchanged until this request is reviewed.'
        : 'Please confirm what is waiting for review and how I will print our QR.'
      if (themeRequestEnabled) {
        await expect(page.getByRole('combobox', { name: /What is this about/ })).toHaveValue(
          'BRANDING',
        )
        await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
      }
      await page.getByLabel('Message', { exact: true }).fill(supportBody)
      // Querying, prefilling and editing the production form creates no durable request.
      expect(await requestCount()).toBe(0)
      await expectNoHorizontalOverflow(page)
      await captureEvidence(page, testInfo, 'draft-qr-unsent-support-390')
      await page.setViewportSize({ width: 1440, height: 900 })
      await expectNoHorizontalOverflow(page)
      await captureEvidence(page, testInfo, 'draft-qr-unsent-support-1440')
      await page.setViewportSize({ width: 390, height: 844 })
      const supportWrite = page.waitForRequest(
        (request) =>
          request.method() === 'POST' && request.url().includes('/api/trpc/support.createRequest'),
      )
      await page.getByRole('button', { name: 'Send request', exact: true }).click()
      const rawSupportInput = (await supportWrite).postDataJSON() as Record<string, unknown>
      const serializedSupportInput = rawSupportInput['0'] ?? rawSupportInput
      const request = (
        serializedSupportInput &&
        typeof serializedSupportInput === 'object' &&
        'json' in serializedSupportInput
          ? serializedSupportInput.json
          : serializedSupportInput
      ) as Parameters<typeof owner.support.createRequest>[0]
      expect(request.venueId).toBe(venueId)
      expect(request.operationId).toEqual(expect.any(String))
      await expect(page.getByLabel('Reply', { exact: true })).toBeVisible()
      expect(await requestCount()).toBe(1)
      const support = await owner.support.createRequest(request)
      expect((await owner.support.createRequest(request)).request.id).toBe(support.request.id)
      expect(await requestCount()).toBe(1)
      expect(
        (await owner.support.getRequest({ venueId, requestId: support.request.id })).venueId,
      ).toBe(venueId)
      if (themeRequestEnabled) {
        const readback = await owner.support.getRequest({ venueId, requestId: support.request.id })
        expect(readback).toMatchObject({ venueId, category: 'BRANDING', status: 'OPEN' })
        expect(readback.messages.some((message) => message.body === supportBody)).toBe(true)
        const stored = await withTenantIsolationBypass(() =>
          db.supportRequest.findFirstOrThrow({
            where: { id: support.request.id, tenantId, venueId },
            select: { id: true, tenantId: true, venueId: true, category: true, status: true },
          }),
        )
        expect(stored).toMatchObject({ tenantId, venueId, category: 'BRANDING', status: 'OPEN' })
        const themeAfterRequest = await withTenantIsolationBypass(() =>
          db.venue.findFirstOrThrow({
            where: { id: venueId, tenantId },
            select: { chatTheme: true },
          }),
        )
        expect(themeAfterRequest).toEqual(themeBeforeRequest)
        await testInfo.attach('browser-theme-request-identity', {
          body: JSON.stringify({
            ...stored,
            noRequestBeforeSend: true,
            replayCount: await requestCount(),
            bodyReadbackMatched: true,
            themeUnchanged: true,
            providerProof: false,
          }),
          contentType: 'application/json',
        })
      }
      await captureEvidence(page, testInfo, 'draft-support-saved-390')
      const lifecycle = (await owner.portal.getVenueLifecycles()).find(
        (item) => item.venueId === venueId,
      )
      expect(lifecycle).toBeDefined()
      expect(['READY', 'LIVE']).not.toContain(lifecycle!.lifecycle.state)
      expect(
        await withTenantIsolationBypass(() =>
          db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
        ),
      ).toBe(0)
      if (scannerReleaseEnabled) {
        expect(scannerPackageDraft).not.toBeNull()
        const reviewed = await owner.venuePackage.getById({ id: scannerPackageDraft!.id })
        expect(reviewed).toMatchObject({
          id: scannerPackageDraft!.id,
          status: 'DRAFT',
          payloadHash: scannerPackageDraft!.payloadHash,
        })
        const approved = await owner.venuePackage.approve({
          id: reviewed.id,
          expectedUpdatedAt: reviewed.updatedAt,
          commandKey: randomUUID(),
          acknowledgedWarningDigest: reviewed.previewPlan.warningDigest,
          acknowledgedPayloadHash: reviewed.payloadHash,
        })
        expect(approved.status).toBe('APPROVED')
        const applied = await owner.venuePackage.applyPackage({
          id: approved.id,
          expectedUpdatedAt: approved.updatedAt,
          commandKey: randomUUID(),
        })
        expect(applied.status).toBe('APPLIED')

        const contentVersions = await withTenantIsolationBypass(() =>
          db.contentVersion.findMany({
            where: { tenantId, venueId, venuePackageId: applied.id, venuePackageAction: 'APPLY' },
            select: { id: true, entityType: true, entityId: true },
            orderBy: { sequence: 'asc' },
          }),
        )
        expect(contentVersions.length).toBeGreaterThan(0)

        const anonymousToken = randomUUID()
        const publicCaller = appRouter.createCaller({
          db,
          headers: new Headers(),
          session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
        })
        const guestSession = await publicCaller.chat.session({ venueId, anonymousToken })
        const publicScope = await loadPublicLocationScope(db, { anonymousToken, venueId })
        expect(publicScope).toMatchObject({ tenantId, venueId, experienceScope: 'PUBLIC' })
        const publicKnowledge = await retrieveGuestKnowledge({
          reader: db,
          query: 'visitor provided notes review venue knowledge',
          tenantId: publicScope!.tenantId,
          venueId: publicScope!.venueId,
          includeSecondLayer: false,
          queryEmbedding: null,
        })
        expect(publicKnowledge.entries.length).toBeGreaterThan(0)
        expect(
          publicKnowledge.entries.some((entry) => entry.content.includes(scannerCleanText.trim())),
        ).toBe(true)
        for (const entry of publicKnowledge.entries) {
          expect(contentVersions).toContainEqual(
            expect.objectContaining({ entityType: 'KNOWLEDGE_ENTRY', entityId: entry.id }),
          )
        }

        const releasedLifecycle = (await owner.portal.getVenueLifecycles()).find(
          (item) => item.venueId === venueId,
        )
        expect(releasedLifecycle?.release.released).toBe(true)
        expect(['READY', 'LIVE', 'REVISIONS']).toContain(releasedLifecycle?.lifecycle.state)
        let qrDecodedUrl: string | undefined
        for (const viewport of [
          { name: '390', width: 390, height: 844 },
          { name: '1440', width: 1440, height: 900 },
        ] as const) {
          await page.setViewportSize(viewport)
          await page.goto(
            `/dev-fixtures/connected-client-handoff?venueId=${encodeURIComponent(venueId)}`,
          )
          await expect(page.getByRole('heading', { name: /QR kit$/u })).toBeVisible()
          const downloadButton = page.getByRole('button', { name: /Download SVG/i }).first()
          await expect(downloadButton).toBeVisible()
          const qrUrl = page.locator('article').first().locator('p.font-mono')
          const expectedVenueQrUrl = new URL(
            `/${encodeURIComponent(publicScope!.venueSlug)}/chat?source=qr`,
            process.env.NEXT_PUBLIC_WEB_URL!,
          ).toString()
          await expect(qrUrl).toHaveText(expectedVenueQrUrl)
          const download = page.waitForEvent('download')
          await downloadButton.click()
          const downloaded = await download
          expect(downloaded.suggestedFilename()).toMatch(/\.svg$/u)
          const svgPath = testInfo.outputPath(`scanner-release-${viewport.name}.svg`)
          await downloaded.saveAs(svgPath)
          const expectedUrl = (await qrUrl.textContent())?.trim()
          qrDecodedUrl = await decodeQrSvg(await readFile(svgPath))
          expect(qrDecodedUrl).toBe(expectedUrl)
          await expectNoHorizontalOverflow(page)
          await captureEvidence(page, testInfo, `scanner-release-qr-${viewport.name}`)
        }
        await testInfo.attach('browser-scanner-release-identity', {
          body: JSON.stringify({
            tenantId,
            venueId,
            selectedUploadId: submittedSource.uploadId,
            selectedRunId: submittedSource.runId,
            extractionReceiptId: submittedReceiptId,
            submissionId: saved.submissionId,
            manifestHash: saved.manifestHash,
            candidateHash: ready.candidateHash,
            payloadHash: ready.payloadHash,
            packageId: applied.id,
            appliedStatus: applied.status,
            contentVersionIds: contentVersions.map((version) => version.id),
            contentVersions,
            publicKnowledgeIds: publicKnowledge.entries.map((entry) => entry.id),
            guestSessionId: guestSession.sessionId,
            venueSlug: publicScope!.venueSlug,
            lifecycleState: releasedLifecycle?.lifecycle.state,
            released: releasedLifecycle?.release.released,
            publicScopeResolved: publicScope !== null,
            qrDecodedUrl,
            providerProof: false,
          }),
          contentType: 'application/json',
        })
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(remoteOnboardingFixtureUrl)
      await expect(page.getByText('Version 1 received', { exact: true })).toBeVisible()
      await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await captureEvidence(page, testInfo, 'file-v1-receipt-390')
      await testInfo.attach('saved-file-v1-identity', {
        body: JSON.stringify({ ...saved, redisDeliveryEvidence }),
        contentType: 'application/json',
      })
      if (state.scannerExtraction) {
        const markerUpload = await withTenantIsolationBypass(() =>
          db.intakeUpload.findFirstOrThrow({
            where: { tenantId, venueId, fileName: 'harmless-marker.txt' },
            select: { id: true, intakeRunId: true, status: true },
          }),
        )
        expect(markerUpload).toMatchObject({ status: 'REJECTED', intakeRunId: null })
        expect(
          await withTenantIsolationBypass(() =>
            db.intakeFileExtractionReceipt.count({
              where: { tenantId, venueId, uploadId: markerUpload.id },
            }),
          ),
        ).toBe(0)
        await testInfo.attach('browser-scanner-v1-extraction-identity', {
          body: JSON.stringify({
            tenantId,
            venueId,
            submissionId: saved.submissionId,
            manifestHash: saved.manifestHash,
            memberId: saved.memberId,
            dispatchId: saved.dispatchId,
            selectedUploadId: submittedSource.uploadId,
            selectedRunId: submittedSource.runId,
            sourceSha256: submittedSource.sourceSha256,
            objectGeneration: submittedSource.objectGeneration,
            storageVersionId: submittedSource.storageVersionId,
            extractionReceiptId: submittedReceiptId,
            extractedTextHash: submittedSource.extractedTextHash,
            extractionAttempts,
            replayResult: redisDeliveryEvidence?.replayResult,
            markerUploadId: markerUpload.id,
            markerStatus: markerUpload.status,
            markerIntakeRunId: markerUpload.intakeRunId,
          }),
          contentType: 'application/json',
        })
      }
    } finally {
      await context.close()
    }
  })

  if (qrReleaseEnabled) {
    test('keeps the current QR release available while a newer package remains a draft', async ({
      browser,
    }, testInfo) => {
      const state = fixture!
      const qrVenue = await withTenantIsolationBypass(() =>
        db.venue.create({
          data: {
            tenantId,
            name: 'Connected released QR venue',
            slug: 'fixture-connected-released-qr-venue',
          },
        }),
      )
      const qrVenueId = qrVenue.id
      const { appRouter } = await import('@pathfinder/api')
      const admin = appRouter.createCaller({
        db,
        headers: new Headers(),
        session: state.sessions.get(state.tokens.admin)!,
      })
      setOpenAiEmbeddingsClientForTesting({
        embeddings: {
          create: async ({ input: texts, dimensions }) => ({
            data: texts.map((_text, index) => ({
              index,
              embedding: Array.from({ length: dimensions }, (_, position) =>
                position === index % Math.min(dimensions, 4) ? 1 : 0,
              ),
            })),
            usage: { prompt_tokens: texts.length, total_tokens: texts.length },
          }),
        },
      })
      const appliedPayload = {
        schemaVersion: 1 as const,
        places: [
          {
            name: 'Connected release gallery',
            type: 'exhibit',
            lat: 41.88,
            lng: -87.63,
            tags: ['connected-qr-release'],
            importanceScore: 60,
          },
        ],
        knowledgeEntries: [],
      }
      const appliedDraft = await admin.venuePackage.createDraft({
        venueId: qrVenueId,
        payload: appliedPayload,
        draftKey: randomUUID(),
      })
      expect(appliedDraft.preview.report.errors).toEqual([])
      expect(appliedDraft.preview.report.semanticDuplicateScan.status).toBe('COMPLETE')
      const approved = await admin.venuePackage.approve({
        id: appliedDraft.id,
        expectedUpdatedAt: appliedDraft.updatedAt,
        commandKey: randomUUID(),
        acknowledgedWarningDigest: appliedDraft.preview.warningDigest,
        acknowledgedPayloadHash: appliedDraft.payloadHash,
      })
      const applied = await admin.venuePackage.applyPackage({
        id: appliedDraft.id,
        expectedUpdatedAt: approved.updatedAt,
        commandKey: randomUUID(),
      })
      expect(applied.status).toBe('APPLIED')

      const unreleasedPayload = {
        schemaVersion: 1 as const,
        places: [
          {
            name: 'Connected unreleased gallery',
            type: 'exhibit',
            lat: 41.88,
            lng: -87.63,
            tags: ['connected-qr-draft'],
            importanceScore: 40,
          },
        ],
        knowledgeEntries: [],
      }
      const newerDraft = await admin.venuePackage.createDraft({
        venueId: qrVenueId,
        payload: unreleasedPayload,
        draftKey: randomUUID(),
      })
      expect(newerDraft.status).toBe('DRAFT')

      const lifecycle = (await admin.portal.getVenueLifecycles()).find(
        (candidate) => candidate.venueId === qrVenueId,
      )
      expect(lifecycle).toMatchObject({
        venueId: qrVenueId,
        lifecycle: { state: 'REVISIONS' },
        release: { released: true },
      })
      const places = await admin.place.list({ venueId: qrVenueId })
      expect(places.length).toBeGreaterThan(0)
      expect(places.every((place) => place.isActive && place.visibility === 'PUBLIC')).toBe(true)
      expect(places.map((place) => place.name)).toContain('Connected release gallery')
      expect(places.map((place) => place.name)).not.toContain('Connected unreleased gallery')
      await testInfo.attach('qr-current-release-identity', {
        body: JSON.stringify({
          tenantId,
          venueId: qrVenueId,
          appliedPackageId: applied.id,
          appliedStatus: applied.status,
          draftPackageId: newerDraft.id,
          lifecycleState: lifecycle?.lifecycle.state,
          released: lifecycle?.release.released,
          providerProof: false,
          publicActivePlaceIds: places.map((place) => place.id),
        }),
        contentType: 'application/json',
      })

      for (const viewport of [
        { name: '390', width: 390, height: 844 },
        { name: '1440', width: 1440, height: 900 },
      ] as const) {
        const context = await connectedContext(browser, state.tokens.admin, viewport)
        try {
          const page = await context.newPage()
          await page.goto(
            `/dev-fixtures/connected-client-handoff?venueId=${encodeURIComponent(qrVenueId)}`,
          )
          await expect(
            page.getByRole('heading', { name: 'Connected released QR venue QR kit' }),
          ).toBeVisible()
          await expect(page.getByRole('button', { name: /Download SVG/i })).toHaveCount(2)
          await expect(page.getByText('Connected release gallery', { exact: true })).toBeVisible()
          await expect(page.getByText('Connected unreleased gallery', { exact: true })).toHaveCount(
            0,
          )
          await expectNoHorizontalOverflow(page)
          await captureEvidence(page, testInfo, `qr-current-release-${viewport.name}`)
        } finally {
          await context.close()
        }
      }

      const unreleasedVenue = await withTenantIsolationBypass(() =>
        db.venue.create({
          data: {
            tenantId,
            name: 'Connected unreleased QR sibling',
            slug: 'fixture-connected-unreleased-qr-sibling',
          },
        }),
      )
      const siblingDraft = await admin.venuePackage.createDraft({
        venueId: unreleasedVenue.id,
        payload: unreleasedPayload,
        draftKey: randomUUID(),
      })
      expect(siblingDraft.status).toBe('DRAFT')
      await withTenantIsolationBypass(() =>
        db.place.create({
          data: {
            tenantId,
            venueId: unreleasedVenue.id,
            name: 'Employee-only sibling place',
            type: 'exhibit',
            tags: ['connected-qr-private-only'],
            visibility: 'SECOND_LAYER',
            isActive: true,
          },
        }),
      )
      const siblingLifecycle = (await admin.portal.getVenueLifecycles()).find(
        (candidate) => candidate.venueId === unreleasedVenue.id,
      )
      expect(siblingLifecycle).toMatchObject({
        venueId: unreleasedVenue.id,
        lifecycle: { state: 'INTERNAL_REVIEW' },
        release: { released: false },
      })
      await expect(
        admin.portal.getOnboardingJourney({ venueId: unreleasedVenue.id }),
      ).resolves.toMatchObject({
        venue: { id: unreleasedVenue.id },
        release: { released: false },
      })
      const siblingContext = await connectedContext(browser, state.tokens.admin, {
        width: 390,
        height: 844,
      })
      try {
        const siblingPage = await siblingContext.newPage()
        await siblingPage.goto(
          `/dev-fixtures/connected-client-handoff?venueId=${encodeURIComponent(unreleasedVenue.id)}`,
        )
        await expect(
          siblingPage.getByRole('heading', { name: 'QR kit is not available yet' }),
        ).toBeVisible()
        await expect(siblingPage.getByRole('button', { name: /Download SVG/i })).toHaveCount(0)
      } finally {
        await siblingContext.close()
      }
      setOpenAiEmbeddingsClientForTesting(null)
    })
  }
  if (storageTransportEnabled && !scannerTransportEnabled) {
    test('uploads one browser file to disposable storage and leaves it pending without a scanner', async ({
      browser,
    }, testInfo) => {
      const state = fixture!
      const fixtureBytes = Buffer.from(
        'Browser storage fixture: this is a harmless text upload for precheck only.\n',
        'utf8',
      )
      const sourceSha256 = createHash('sha256').update(fixtureBytes).digest('hex')
      const sdk = createRequire(resolve(__dirname, '../../../../packages/api/package.json'))(
        '@aws-sdk/client-s3',
      ) as {
        S3Client: new (input: Record<string, unknown>) => {
          send(command: unknown): Promise<unknown>
          destroy(): void
        }
        CreateBucketCommand: new (input: Record<string, unknown>) => unknown
        PutBucketVersioningCommand: new (input: Record<string, unknown>) => unknown
        HeadObjectCommand: new (input: Record<string, unknown>) => unknown
      }
      const storage = new sdk.S3Client({
        endpoint: process.env.STORAGE_ENDPOINT!,
        region: process.env.STORAGE_REGION!,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
        },
      })
      const bucket = process.env.STORAGE_BUCKET!
      state.sessions.set(state.tokens.owner, {
        userId: ownerUserId,
        activeTenantId: tenantId,
        role: 'OWNER',
        isPlatformAdmin: false,
      })
      const context = await connectedContext(browser, state.tokens.owner, {
        width: 390,
        height: 844,
      })
      let resources: { worker: unknown; close(): Promise<void> } | null = null
      let closeJobQueues: (() => Promise<void>) | null = null
      let closeBullMQConnection: (() => Promise<void>) | null = null
      try {
        await storage.send(new sdk.CreateBucketCommand({ Bucket: bucket }))
        await storage.send(
          new sdk.PutBucketVersioningCommand({
            Bucket: bucket,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        )
        const { createIntakeUploadVerificationResources } =
          await import('../../../workers/src/intake-upload-verification-runtime')
        const jobs = await import('@pathfinder/jobs')
        closeJobQueues = jobs.closeJobQueues
        closeBullMQConnection = jobs.closeBullMQConnection
        const page = await context.newPage()
        await page.goto(remoteOnboardingFixtureUrl)
        await expect(page.getByText('Loading saved work…')).toBeHidden()
        const storageOrigin = new URL(process.env.STORAGE_ENDPOINT!).origin
        let actualPutCount = 0
        page.on('response', (response) => {
          const url = new URL(response.url())
          if (response.request().method() === 'PUT' && url.origin === storageOrigin)
            actualPutCount += 1
        })
        const actualPut = page.waitForResponse((response) => {
          const url = new URL(response.url())
          return response.request().method() === 'PUT' && url.origin === storageOrigin
        })
        await page.getByLabel('Choose files').setInputFiles({
          name: 'browser-storage-precheck.txt',
          mimeType: 'text/plain',
          buffer: fixtureBytes,
        })
        await page.getByRole('button', { name: 'Upload', exact: true }).click()
        expect((await actualPut).status()).toBe(200)
        expect(actualPutCount).toBe(1)
        await expect(page.getByText('Security check pending', { exact: true })).toBeVisible()
        await expect
          .poll(async () =>
            withTenantIsolationBypass(() =>
              db.intakeUpload.findFirst({
                where: { tenantId, venueId, fileName: 'browser-storage-precheck.txt' },
                select: {
                  id: true,
                  status: true,
                  sha256: true,
                  byteSize: true,
                  objectKey: true,
                  objectGeneration: true,
                  storageVersionId: true,
                  intakeRunId: true,
                },
              }),
            ),
          )
          .toMatchObject({
            status: 'PRECHECK_PASSED',
            sha256: sourceSha256,
            byteSize: fixtureBytes.byteLength,
            objectGeneration: expect.any(String),
            storageVersionId: expect.any(String),
            intakeRunId: null,
          })
        // Read only after the precheck state is proven; the registered worker has not started yet.
        const persistedUpload = await withTenantIsolationBypass(() =>
          db.intakeUpload.findFirstOrThrow({
            where: { tenantId, venueId, fileName: 'browser-storage-precheck.txt' },
            select: {
              id: true,
              status: true,
              sha256: true,
              byteSize: true,
              objectKey: true,
              objectGeneration: true,
              storageVersionId: true,
              intakeRunId: true,
              updatedAt: true,
            },
          }),
        )
        const head = (await storage.send(
          new sdk.HeadObjectCommand({
            Bucket: bucket,
            Key: persistedUpload.objectKey,
            VersionId: persistedUpload.storageVersionId!,
            ChecksumMode: 'ENABLED',
          }),
        )) as {
          VersionId?: string
          ContentLength?: number
          ChecksumSHA256?: string
          Metadata?: Record<string, string>
        }
        expect(head).toMatchObject({
          VersionId: persistedUpload.storageVersionId,
          ContentLength: fixtureBytes.byteLength,
          ChecksumSHA256: Buffer.from(sourceSha256, 'hex').toString('base64'),
          Metadata: { 'pf-intake-upload-generation': persistedUpload.objectGeneration },
        })
        await expectNoHorizontalOverflow(page)
        await captureEvidence(page, testInfo, 'browser-upload-security-pending-390')
        await page.setViewportSize({ width: 1440, height: 900 })
        await expect(page.getByText('Security check pending', { exact: true })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await captureEvidence(page, testInfo, 'browser-upload-security-pending-1440')
        resources = await createIntakeUploadVerificationResources()
        const workerFailure = await waitForVerificationFailure(
          resources.worker as unknown as FailedVerificationWorker,
          persistedUpload.id,
        )
        expect(workerFailure).toMatchObject({
          attemptsMade: 1,
          name: 'Error',
          message: 'WORKER_JOB_FAILED',
        })
        const { intakeUploadScannerAvailable } =
          await import('@pathfinder/api/intake-upload-verification')
        const { processIntakeUploadVerificationJob } =
          await import('../../../workers/src/processors/intake-upload-verification')
        const scannerConfigured = intakeUploadScannerAvailable()
        expect(scannerConfigured).toBe(false)
        // The registered queue intentionally sanitizes errors. Prove the unavailable scanner
        // independently through the same real processor without bypassing that queue boundary.
        await expect(
          processIntakeUploadVerificationJob(
            {
              tenantId,
              venueId,
              uploadId: persistedUpload.id,
              observedUpdatedAt: persistedUpload.updatedAt.toISOString(),
            },
            workerFailure.jobId,
          ),
        ).rejects.toMatchObject({
          name: 'IntakeUploadScannerUnavailableError',
          message: 'Authoritative intake upload scanner is not configured',
        })
        expect(workerFailure.state).toMatch(/^(active|delayed|waiting)$/u)
        const postWorkerUpload = await withTenantIsolationBypass(() =>
          db.intakeUpload.findFirstOrThrow({
            where: { id: persistedUpload.id, tenantId, venueId },
            select: { status: true, intakeRunId: true, storageVersionId: true },
          }),
        )
        expect(postWorkerUpload).toEqual({
          status: 'PRECHECK_PASSED',
          intakeRunId: null,
          storageVersionId: persistedUpload.storageVersionId,
        })
        const receipts = await withTenantIsolationBypass(() =>
          db.intakeUploadVerificationReceipt.findMany({
            where: { tenantId, venueId, uploadId: persistedUpload.id },
            select: {
              kind: true,
              verdict: true,
              computedByteSize: true,
              computedSha256: true,
              storageVersionId: true,
            },
          }),
        )
        expect(receipts).toEqual([
          expect.objectContaining({
            kind: 'PRECHECK',
            verdict: 'PASSED',
            computedByteSize: fixtureBytes.byteLength,
            computedSha256: sourceSha256,
            storageVersionId: persistedUpload.storageVersionId,
          }),
        ])
        const authoritativeReceiptCount = receipts.filter(
          (receipt) => receipt.kind === 'MALWARE',
        ).length
        expect(authoritativeReceiptCount).toBe(0)
        expect(
          await withTenantIsolationBypass(() =>
            db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
          ),
        ).toBe(0)
        await testInfo.attach('browser-upload-storage-identity', {
          body: JSON.stringify({
            uploadId: persistedUpload.id,
            sourceSha256,
            storageVersionId: persistedUpload.storageVersionId,
            uploadStatus: postWorkerUpload.status,
            precheckPassed: postWorkerUpload.status === 'PRECHECK_PASSED',
            authoritativeReceiptCount,
            scannerConfigured,
            directProcessorScannerUnavailable: true,
            workerError: { name: workerFailure.name, message: workerFailure.message },
            workerAttemptsMade: workerFailure.attemptsMade,
            actualPutCount,
          }),
          contentType: 'application/json',
        })
      } finally {
        try {
          await resources?.close()
        } finally {
          try {
            await closeJobQueues?.()
          } finally {
            await closeBullMQConnection?.()
            storage.destroy()
            await context.close()
          }
        }
      }
    })
  }

  if (storageRecoveryEnabled) {
    test('keeps a valid browser batch pending while a failed storage PUT retries without duplicates', async ({
      browser,
    }, testInfo) => {
      const state = fixture!
      const firstBytes = Buffer.from('Browser batch first valid source.\n', 'utf8')
      const retryBytes = Buffer.from('Browser batch retry source.\n', 'utf8')
      const firstHash = createHash('sha256').update(firstBytes).digest('hex')
      const retryHash = createHash('sha256').update(retryBytes).digest('hex')
      const context = await connectedContext(browser, state.tokens.owner, {
        width: 390,
        height: 844,
      })
      const storageOrigin = new URL(process.env.STORAGE_ENDPOINT!).origin
      let resources: { worker: unknown; close(): Promise<void> } | null = null
      let closeJobQueues: (() => Promise<void>) | null = null
      let closeBullMQConnection: (() => Promise<void>) | null = null
      try {
        state.sessions.set(state.tokens.owner, {
          userId: ownerUserId,
          activeTenantId: tenantId,
          role: 'OWNER',
          isPlatformAdmin: false,
        })
        const { createIntakeUploadVerificationResources } =
          await import('../../../workers/src/intake-upload-verification-runtime')
        const jobs = await import('@pathfinder/jobs')
        closeJobQueues = jobs.closeJobQueues
        closeBullMQConnection = jobs.closeBullMQConnection
        const page = await context.newPage()
        await page.goto(remoteOnboardingFixtureUrl)
        await expect(page.getByText('Loading saved work…')).toBeHidden()
        let successfulPutCount = 0
        page.on('response', (response) => {
          const url = new URL(response.url())
          if (response.request().method() === 'PUT' && url.origin === storageOrigin)
            successfulPutCount += 1
        })
        await page.getByLabel('Choose files').setInputFiles([
          {
            name: 'browser-batch-first.txt',
            mimeType: 'text/plain',
            buffer: firstBytes,
          },
          {
            name: 'browser-batch-invalid.exe',
            mimeType: 'application/x-msdownload',
            buffer: Buffer.from('not an executable', 'utf8'),
          },
          {
            name: 'browser-batch-retry.txt',
            mimeType: 'text/plain',
            buffer: retryBytes,
          },
        ])
        await expect(
          page.getByText('Choose a supported document, image, video, or audio file.', {
            exact: true,
          }),
        ).toBeVisible()
        expect(
          await withTenantIsolationBypass(() =>
            db.intakeUpload.count({
              where: { tenantId, venueId, fileName: 'browser-batch-invalid.exe' },
            }),
          ),
        ).toBe(0)
        const firstPut = page.waitForResponse((response) => {
          const url = new URL(response.url())
          return response.request().method() === 'PUT' && url.origin === storageOrigin
        })
        await page.getByRole('button', { name: 'Upload', exact: true }).first().click()
        expect((await firstPut).status()).toBe(200)
        await expect(page.getByText('Security check pending', { exact: true })).toBeVisible()
        const abortFirstRetryPut = async (route: Route) => {
          if (route.request().method() !== 'PUT') return route.continue()
          abortedPutCount += 1
          await route.abort('failed')
        }
        let abortedPutCount = 0
        await page.route(`${storageOrigin}/**`, abortFirstRetryPut)
        await page.getByRole('button', { name: 'Upload', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
        await page.unroute(`${storageOrigin}/**`, abortFirstRetryPut)
        expect(abortedPutCount).toBe(1)
        expect(successfulPutCount).toBe(1)
        const whileRetryPending = await withTenantIsolationBypass(() =>
          db.intakeUpload.findMany({
            where: {
              tenantId,
              venueId,
              fileName: { in: ['browser-batch-first.txt', 'browser-batch-retry.txt'] },
            },
            select: {
              id: true,
              fileName: true,
              requestId: true,
              requestHash: true,
              status: true,
              storageVersionId: true,
              objectGeneration: true,
              intakeRunId: true,
            },
            orderBy: { fileName: 'asc' },
          }),
        )
        expect(whileRetryPending).toEqual([
          expect.objectContaining({
            fileName: 'browser-batch-first.txt',
            status: 'PRECHECK_PASSED',
            storageVersionId: expect.any(String),
            intakeRunId: null,
          }),
          expect.objectContaining({
            fileName: 'browser-batch-retry.txt',
            status: 'RESERVED',
            storageVersionId: null,
            intakeRunId: null,
          }),
        ])
        await expectNoHorizontalOverflow(page)
        await captureEvidence(page, testInfo, 'browser-upload-batch-partial-390')
        const retryIdentity = whileRetryPending[1]!
        const retryPut = page.waitForResponse((response) => {
          const url = new URL(response.url())
          return response.request().method() === 'PUT' && url.origin === storageOrigin
        })
        await page.getByRole('button', { name: 'Retry', exact: true }).click()
        expect((await retryPut).status()).toBe(200)
        await expect(page.getByText('Security check pending', { exact: true })).toHaveCount(2)
        expect(successfulPutCount).toBe(2)
        await expectNoHorizontalOverflow(page)
        await captureEvidence(page, testInfo, 'browser-upload-batch-recovered-390')
        await expect
          .poll(async () =>
            withTenantIsolationBypass(() =>
              db.intakeUpload.findMany({
                where: {
                  tenantId,
                  venueId,
                  fileName: { in: ['browser-batch-first.txt', 'browser-batch-retry.txt'] },
                },
                select: {
                  id: true,
                  fileName: true,
                  requestId: true,
                  requestHash: true,
                  status: true,
                  sha256: true,
                  storageVersionId: true,
                  intakeRunId: true,
                  objectGeneration: true,
                },
                orderBy: { fileName: 'asc' },
              }),
            ),
          )
          .toEqual([
            expect.objectContaining({
              fileName: 'browser-batch-first.txt',
              status: 'PRECHECK_PASSED',
              sha256: firstHash,
              storageVersionId: expect.any(String),
              intakeRunId: null,
            }),
            expect.objectContaining({
              id: retryIdentity.id,
              requestId: retryIdentity.requestId,
              requestHash: retryIdentity.requestHash,
              objectGeneration: retryIdentity.objectGeneration,
              fileName: 'browser-batch-retry.txt',
              status: 'PRECHECK_PASSED',
              sha256: retryHash,
              storageVersionId: expect.any(String),
              intakeRunId: null,
            }),
          ])
        const persistedUploads = await withTenantIsolationBypass(() =>
          db.intakeUpload.findMany({
            where: {
              tenantId,
              venueId,
              fileName: { in: ['browser-batch-first.txt', 'browser-batch-retry.txt'] },
            },
            select: {
              id: true,
              fileName: true,
              requestId: true,
              requestHash: true,
              status: true,
              storageVersionId: true,
              objectGeneration: true,
              intakeRunId: true,
            },
            orderBy: { fileName: 'asc' },
          }),
        )
        const retryIdentityAfter = persistedUploads.find(
          (upload) => upload.fileName === 'browser-batch-retry.txt',
        )!
        expect(retryIdentityAfter).toMatchObject({
          id: retryIdentity.id,
          requestId: retryIdentity.requestId,
          requestHash: retryIdentity.requestHash,
          objectGeneration: retryIdentity.objectGeneration,
        })
        expect(new Set(persistedUploads.map((upload) => upload.storageVersionId)).size).toBe(2)
        resources = await createIntakeUploadVerificationResources()
        const workerFailures = await Promise.all(
          persistedUploads.map((upload) =>
            waitForVerificationFailure(resources!.worker as FailedVerificationWorker, upload.id),
          ),
        )
        expect(workerFailures).toHaveLength(2)
        expect(workerFailures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attemptsMade: 1,
              name: 'Error',
              message: 'WORKER_JOB_FAILED',
            }),
          ]),
        )
        const finalRows = await withTenantIsolationBypass(() =>
          db.intakeUpload.findMany({
            where: { id: { in: persistedUploads.map((upload) => upload.id) }, tenantId, venueId },
            select: { status: true, intakeRunId: true },
            orderBy: { id: 'asc' },
          }),
        )
        expect(finalRows).toEqual([
          { status: 'PRECHECK_PASSED', intakeRunId: null },
          { status: 'PRECHECK_PASSED', intakeRunId: null },
        ])
        const receipts = await withTenantIsolationBypass(() =>
          db.intakeUploadVerificationReceipt.findMany({
            where: {
              uploadId: { in: persistedUploads.map((upload) => upload.id) },
              tenantId,
              venueId,
            },
            select: { uploadId: true, kind: true, verdict: true, computedSha256: true },
          }),
        )
        expect(receipts).toHaveLength(2)
        expect(receipts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'PRECHECK',
              verdict: 'PASSED',
              computedSha256: firstHash,
            }),
            expect.objectContaining({
              kind: 'PRECHECK',
              verdict: 'PASSED',
              computedSha256: retryHash,
            }),
          ]),
        )
        const invalidReservationCount = await withTenantIsolationBypass(() =>
          db.intakeUpload.count({
            where: { tenantId, venueId, fileName: 'browser-batch-invalid.exe' },
          }),
        )
        expect(invalidReservationCount).toBe(0)
        await testInfo.attach('browser-upload-storage-recovery-identity', {
          body: JSON.stringify({
            validUploads: persistedUploads.map((upload) => ({
              uploadId: upload.id,
              storageVersionId: upload.storageVersionId,
              status: upload.status,
            })),
            hashes: { firstHash, retryHash },
            invalidReservationCount,
            retryIdentityBefore: {
              id: retryIdentity.id,
              requestId: retryIdentity.requestId,
              requestHash: retryIdentity.requestHash,
              objectGeneration: retryIdentity.objectGeneration,
            },
            retryIdentityAfter: {
              id: retryIdentityAfter.id,
              requestId: retryIdentityAfter.requestId,
              requestHash: retryIdentityAfter.requestHash,
              objectGeneration: retryIdentityAfter.objectGeneration,
            },
            abortedPutCount,
            successfulPutCount,
            workerFailures: workerFailures.map(({ name, message, attemptsMade }) => ({
              name,
              message,
              attemptsMade,
            })),
          }),
          contentType: 'application/json',
        })
      } finally {
        try {
          await resources?.close()
        } finally {
          try {
            await closeJobQueues?.()
          } finally {
            await closeBullMQConnection?.()
            await context.close()
          }
        }
      }
    })
  }
})
