import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
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
  type TestInfo,
} from '@playwright/test'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { setOpenAiEmbeddingsClientForTesting } from '../../../../packages/ai/src/openai-embeddings'

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
const dashboardBaseURL = process.env.ONBOARDING_CONNECTED_BASE_URL ?? 'http://127.0.0.1:3002'

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

assertDisposableRedisTransportBoundary()

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
const venueId = 'fixture-great-lakes-museum'
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
  await page.goto('/dev-fixtures/remote-onboarding?state=share')
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
  test('submits the verified owner file once through the real router and retains processing identity', async ({
    browser,
  }, testInfo) => {
    const state = fixture!
    const submittedSource = state.freshExtraction ?? {
      uploadId: state.uploadId,
      runId: state.runId,
      displayName: 'Connected visitor services handbook',
      extractedTextHash: state.extractedTextHash,
      sourceSha256: state.sourceSha256,
      objectGeneration: state.objectGeneration,
      storageVersionId: state.storageVersionId,
      objectKey: null,
    }
    let submittedReceiptId: string | null = state.freshExtraction ? null : state.receiptId
    state.sessions.set(state.tokens.owner, {
      userId: ownerUserId,
      activeTenantId: tenantId,
      role: 'OWNER',
      isPlatformAdmin: false,
    })
    const context = await connectedContext(browser, state.tokens.owner, { width: 390, height: 844 })
    try {
      const page = await context.newPage()
      await page.goto('/dev-fixtures/remote-onboarding?state=share')
      await expect(page.getByText('Loading saved work…')).toBeHidden()
      await page.getByRole('button', { name: 'Review my materials', exact: true }).click()
      const historicalFile = page.getByRole('checkbox', {
        name: /Connected visitor services handbook/,
      })
      await expect(historicalFile).toBeChecked()
      if (state.freshExtraction) {
        const freshFile = page.getByRole('checkbox', { name: state.freshExtraction.displayName })
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
      if (redisTransportEnabled) {
        const { createIntakeV1FileExtractionResources } =
          await import('../../../workers/src/intake-v1-file-extraction-runtime')
        const {
          closeBullMQConnection,
          closeJobQueues,
          INTAKE_V1_FILE_EXTRACTION_PROCESS_JOB,
          INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB,
        } = await import('@pathfinder/jobs')
        if (state.freshExtraction) {
          expect(freshStorageObjects.get(submittedSource.objectKey!)?.reads).toBe(0)
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
          if (state.freshExtraction) {
            expect(first).toMatchObject({ result: 'completed', state: 'unknown' })
            const completed = await withTenantIsolationBypass(() =>
              db.intakeV1ProcessingDispatch.findFirstOrThrow({
                where: { id: saved.dispatchId, tenantId, venueId },
                select: { status: true, fileExtractionReceiptId: true, attempts: true },
              }),
            )
            expect(completed).toMatchObject({ status: 'COMPLETED', attempts: 1 })
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
                  select: { extractedTextHash: true, sourceSha256: true },
                }),
              ),
            ).resolves.toEqual({
              extractedTextHash: submittedSource.extractedTextHash,
              sourceSha256: submittedSource.sourceSha256,
            })
            expect(freshStorageObjects.get(submittedSource.objectKey!)?.reads).toBe(1)
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
          if (state.freshExtraction) {
            expect(freshStorageObjects.get(submittedSource.objectKey!)?.reads).toBe(1)
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
            extractionMode: state.freshExtraction
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
        proposalNotes: state.freshExtraction ? freshExtractedText : beyondPreviewFact,
        rationale: state.freshExtraction
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
      await page.goto(
        `/dev-fixtures/connected-client-handoff?venueId=${encodeURIComponent(venueId)}`,
      )
      await expect(page.getByRole('heading', { name: 'QR kit is not available yet' })).toBeVisible()
      await expect(page.getByLabel('Subject', { exact: true })).not.toHaveValue('')
      await expect(page.getByRole('button', { name: /download.*svg/i })).toHaveCount(0)
      await page
        .getByLabel('Message', { exact: true })
        .fill('Please confirm what is waiting for review and how I will print our QR.')
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
      await page.goto('/dev-fixtures/remote-onboarding?state=share')
      await expect(page.getByText('Version 1 received', { exact: true })).toBeVisible()
      await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await captureEvidence(page, testInfo, 'file-v1-receipt-390')
      await testInfo.attach('saved-file-v1-identity', {
        body: JSON.stringify({ ...saved, redisDeliveryEvidence }),
        contentType: 'application/json',
      })
    } finally {
      await context.close()
    }
  })
})
