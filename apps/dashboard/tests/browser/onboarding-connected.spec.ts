import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { registerHooks } from 'node:module'
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
const dashboardBaseURL = process.env.ONBOARDING_CONNECTED_BASE_URL ?? 'http://127.0.0.1:3002'

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
    const actor = { type: 'HUMAN' as const, id: staffUserId, role: 'STAFF' as const }
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
    return {
      runId: upload.intakeRunId,
      uploadId: reserved.upload.id,
      receiptId,
      extractedTextHash,
      sourceSha256,
      objectGeneration,
      storageVersionId,
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
      ).toBe(1)
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
})
