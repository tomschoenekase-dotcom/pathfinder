import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser } from '@playwright/test'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import type { TRPCContext } from '../../../../packages/api/src/context'

import {
  answerAgentQuestionAction,
  db,
  prepareSupportKnowledgeProposalAction,
  publishUniversalContentAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const enabled =
  process.env.RUN_SEMANTIC_CONFLICT_RESOLUTION_BROWSER_INTEGRATION === '1' &&
  /\/pathfinder_disposable_conflict_browser_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')
const dashboardBaseURL =
  process.env.SEMANTIC_CONFLICT_RESOLUTION_CONNECTED_BASE_URL ?? 'http://127.0.0.1:3002'
const tenantId = 'fixture-conflict-tenant'
const venueId = 'fixture-conflict-venue'
const adminId = 'fixture-conflict-platform-admin'

type FixtureState = {
  server: Server
  endpoint: string
  token: string
  identityId: string
  proposalId: string
  entryId: string
  questionId: string
  additionProposalId: string
  additionSupportRequestId: string
  additionSupportMessageId: string
  additionBodyHash: string
  additionContent: string
  supportRequestId: string
  supportMessageId: string
  originalSupportBodyHash: string
  replacementContent: string
  dropCommittedResolutionResponse: boolean
  droppedResolutionResponses: number
  resolutionRequestBodies: string[]
  dropCommittedDraftResponse: boolean
  droppedDraftResponses: number
  draftRequestBodies: string[]
  dropCommittedUniversalDraftResponse: boolean
  droppedUniversalDraftResponses: number
  universalDraftRequestBodies: string[]
}

let fixture: FixtureState | null = null

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

function matchesToken(authorization: string | undefined, expected: string) {
  const candidate = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1]
  if (!candidate) return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function startFixtureServer(): Promise<FixtureState> {
  installSyntheticAuthModule()
  const { appRouter } = await import('@pathfinder/api')
  const token = randomUUID()
  const session = {
    userId: adminId,
    activeTenantId: tenantId,
    role: 'OWNER',
    isPlatformAdmin: true,
  } as const
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const identityId = `fixture-conflict-agent-${suffix}`
  const entryId = `fixture-conflict-entry-${suffix}`
  const canonical = {
    title: 'Willow gallery hours',
    category: 'Hours',
    content: 'The Willow gallery closes at 5 PM.',
    isEnabled: true,
  }
  const conflicting = { ...canonical, content: 'The Willow gallery closes at 7 PM.' }
  const replacementContent = 'The Willow gallery closes at 6 PM.'

  const setup = await withTenantIsolationBypass(async () => {
    await db.tenant.create({
      data: { id: tenantId, name: 'Conflict browser fixture', slug: tenantId },
    })
    await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Conflict browser venue', slug: venueId },
    })
    await db.agentIdentity.create({
      data: {
        id: identityId,
        tenantId,
        venueId,
        identityKey: `semantic.conflict.browser.${suffix}`,
        name: 'Conflict browser content specialist',
        agentType: 'CONTENT',
        accessScope: 'VENUE',
        accessCapabilities: ['content.draft'],
        autonomyLevel: 'DRAFT',
        enabled: true,
        createdBy: adminId,
      },
    })
    await db.venueKnowledgeEntry.create({
      data: {
        id: entryId,
        tenantId,
        venueId,
        ...canonical,
        visibility: 'PUBLIC',
        lastReviewedAt: new Date(),
        lastReviewedBy: adminId,
        humanConfirmedAt: new Date(),
        humanConfirmedBy: adminId,
        sourceType: 'SYNTHETIC_FIXTURE',
        authorship: 'HUMAN_AUTHORED',
      },
    })
    const request = await db.supportRequest.create({
      data: {
        tenantId,
        venueId,
        category: 'CONTENT_CORRECTION',
        status: 'IN_REVIEW',
        subject: 'Conflicting Willow gallery hours',
        createdByKind: 'OPERATOR',
        createdById: adminId,
        updatedByKind: 'OPERATOR',
        updatedById: adminId,
      },
    })
    await db.supportRequestAuditEvent.create({
      data: {
        tenantId,
        venueId,
        supportRequestId: request.id,
        requestVersion: request.version,
        eventType: 'STATUS_CHANGED',
        actorKind: 'OPERATOR',
        actorId: adminId,
        fromStatus: 'OPEN',
        toStatus: 'IN_REVIEW',
      },
    })
    const message = await db.supportMessage.create({
      data: {
        tenantId,
        venueId,
        supportRequestId: request.id,
        authorKind: 'CLIENT',
        authorId: adminId,
        visibility: 'CLIENT_VISIBLE',
        body: conflicting.content,
        submissionRequestId: randomUUID(),
        submissionInputHash: createHash('sha256').update(conflicting.content).digest('hex'),
        requestVersion: request.version,
        clientVersion: request.clientVersion,
      },
    })
    const additionRequest = await db.supportRequest.create({
      data: {
        tenantId,
        venueId,
        category: 'CONTENT_CORRECTION',
        status: 'IN_REVIEW',
        subject: 'New quiet room guidance',
        createdByKind: 'OPERATOR',
        createdById: adminId,
        updatedByKind: 'OPERATOR',
        updatedById: adminId,
      },
    })
    await db.supportRequestAuditEvent.create({
      data: {
        tenantId,
        venueId,
        supportRequestId: additionRequest.id,
        requestVersion: additionRequest.version,
        eventType: 'STATUS_CHANGED',
        actorKind: 'OPERATOR',
        actorId: adminId,
        fromStatus: 'OPEN',
        toStatus: 'IN_REVIEW',
      },
    })
    const additionContent = 'The Juniper quiet room is beside the north reading terrace.'
    const additionMessage = await db.supportMessage.create({
      data: {
        tenantId,
        venueId,
        supportRequestId: additionRequest.id,
        authorKind: 'CLIENT',
        authorId: adminId,
        visibility: 'CLIENT_VISIBLE',
        body: additionContent,
        submissionRequestId: randomUUID(),
        submissionInputHash: createHash('sha256').update(additionContent).digest('hex'),
        requestVersion: additionRequest.version,
        clientVersion: additionRequest.clientVersion,
      },
    })
    return {
      request,
      message,
      identityId,
      entryId,
      conflicting,
      additionRequest,
      additionMessage,
      additionContent,
    }
  })

  const proposalId = randomUUID()
  await prepareSupportKnowledgeProposalAction({
    operationId: proposalId,
    tenantId,
    venueId,
    supportRequestId: setup.request.id,
    expectedVersion: setup.request.version,
    evidenceMessageIds: [setup.message.id],
    targetKnowledgeEntryId: setup.entryId,
    correctionKind: 'UPDATE_KNOWLEDGE',
    aiInference: 'The retained support evidence conflicts with reviewed Willow gallery hours.',
    proposedChange: setup.conflicting.content,
    reason: 'Require an operator to resolve the exact lower-authority conflict.',
    confidence: 0.9,
    actor: {
      type: 'AGENT',
      actorId: setup.identityId,
      role: 'AGENT',
      agentIdentityId: setup.identityId,
      agentRunId: `run-${proposalId}`,
      workerId: `worker-${suffix}`,
      credentialId: `credential-${suffix}`,
      capability: 'knowledge:draft',
      idempotencyKey: proposalId,
      modelProvider: 'deterministic-fixture',
      modelName: 'semantic-conflict-browser-v1',
    },
  })
  const caller = appRouter.createCaller({
    db,
    headers: new Headers(),
    session,
  } satisfies TRPCContext)
  const pending = await db.knowledgeChangeProposal.findFirstOrThrow({
    where: { id: proposalId, tenantId, venueId },
    select: { updatedAt: true },
  })
  await caller.admin.reviewKnowledgeProposal({
    operationId: randomUUID(),
    tenantId,
    venueId,
    proposalId,
    expectedUpdatedAt: pending.updatedAt.toISOString(),
    decision: 'APPROVED',
    reviewNote: 'Evidence reviewed; semantic conflict still requires an explicit resolution.',
  })
  const approved = await db.knowledgeChangeProposal.findFirstOrThrow({
    where: { id: proposalId, tenantId, venueId },
    select: { updatedAt: true },
  })
  const preview = await caller.admin.previewSemanticVenueUpdate({
    tenantId,
    venueId,
    proposalId,
    expectedUpdatedAt: approved.updatedAt,
    relation: 'CORRECTS',
    desired: setup.conflicting,
  })
  const asked = await caller.admin.createSemanticConflictQuestion({
    tenantId,
    venueId,
    proposalId,
    expectedUpdatedAt: approved.updatedAt,
    expectedPreviewHash: preview.previewHash,
    relation: 'CORRECTS',
    desired: setup.conflicting,
    agentIdentityId: setup.identityId,
  })
  const pendingQuestion = await db.agentQuestion.findFirstOrThrow({
    where: { id: asked.questionId, tenantId, venueId },
    select: { updatedAt: true },
  })
  await answerAgentQuestionAction({
    tenantId,
    venueId,
    questionId: asked.questionId,
    expectedUpdatedAt: pendingQuestion.updatedAt,
    outcome: 'ANSWERED',
    answer: `Use the signed operations sheet and prepare ${replacementContent} for review.`,
    actor: { actorType: 'HUMAN', actorId: adminId, auditRole: 'PLATFORM_ADMIN' },
  })

  const additionProposalId = randomUUID()
  await prepareSupportKnowledgeProposalAction({
    operationId: additionProposalId,
    tenantId,
    venueId,
    supportRequestId: setup.additionRequest.id,
    expectedVersion: setup.additionRequest.version,
    evidenceMessageIds: [setup.additionMessage.id],
    correctionKind: 'CREATE_KNOWLEDGE',
    aiInference: 'The retained support evidence describes a new quiet-room fact.',
    proposedChange: setup.additionContent,
    reason: 'Prepare the exact support addition for explicit human review.',
    confidence: 0.92,
    actor: {
      type: 'AGENT',
      actorId: setup.identityId,
      role: 'AGENT',
      agentIdentityId: setup.identityId,
      agentRunId: `run-${additionProposalId}`,
      workerId: `worker-${suffix}`,
      credentialId: `credential-${suffix}`,
      capability: 'knowledge:draft',
      idempotencyKey: additionProposalId,
      modelProvider: 'deterministic-fixture',
      modelName: 'support-authoring-browser-v1',
    },
  })
  const pendingAddition = await db.knowledgeChangeProposal.findFirstOrThrow({
    where: { id: additionProposalId, tenantId, venueId },
    select: { updatedAt: true },
  })
  await caller.admin.reviewKnowledgeProposal({
    operationId: randomUUID(),
    tenantId,
    venueId,
    proposalId: additionProposalId,
    expectedUpdatedAt: pendingAddition.updatedAt.toISOString(),
    decision: 'APPROVED',
    reviewNote: 'Support evidence verifies this addition; publication remains separate.',
  })

  const state: FixtureState = {
    server: undefined as never,
    endpoint: '',
    token,
    identityId: setup.identityId,
    proposalId,
    entryId,
    questionId: asked.questionId,
    additionProposalId,
    additionSupportRequestId: setup.additionRequest.id,
    additionSupportMessageId: setup.additionMessage.id,
    additionBodyHash: createHash('sha256').update(setup.additionContent).digest('hex'),
    additionContent: setup.additionContent,
    supportRequestId: setup.request.id,
    supportMessageId: setup.message.id,
    originalSupportBodyHash: createHash('sha256').update(setup.message.body, 'utf8').digest('hex'),
    replacementContent,
    dropCommittedResolutionResponse: true,
    droppedResolutionResponses: 0,
    resolutionRequestBodies: [],
    dropCommittedDraftResponse: true,
    droppedDraftResponses: 0,
    draftRequestBodies: [],
    dropCommittedUniversalDraftResponse: true,
    droppedUniversalDraftResponses: 0,
    universalDraftRequestBodies: [],
  }
  const server = createServer(async (request, response) => {
    try {
      if (
        !request.url?.startsWith('/api/trpc/') ||
        !['GET', 'POST'].includes(request.method ?? '')
      ) {
        response.writeHead(404).end()
        return
      }
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
      if (request.url.includes('admin.resolveSemanticConflict'))
        state.resolutionRequestBodies.push(body.toString('utf8'))
      if (request.url.includes('admin.createSupportLegacyKnowledgeAdoptionDraft'))
        state.draftRequestBodies.push(body.toString('utf8'))
      if (request.url.includes('admin.createSupportSemanticUniversalContentDraft'))
        state.universalDraftRequestBodies.push(body.toString('utf8'))
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
        createContext: (): TRPCContext => ({
          db,
          headers: webRequest.headers,
          session: matchesToken(request.headers.authorization, token)
            ? session
            : ({
                userId: null,
                activeTenantId: null,
                role: null,
                isPlatformAdmin: false,
              } as const),
        }),
      })
      const responseBody = Buffer.from(await result.arrayBuffer())
      if (
        state.dropCommittedResolutionResponse &&
        request.url.includes('admin.resolveSemanticConflict') &&
        result.status >= 200 &&
        result.status < 300
      ) {
        state.dropCommittedResolutionResponse = false
        state.droppedResolutionResponses += 1
        response.destroy()
        return
      }
      if (
        state.dropCommittedUniversalDraftResponse &&
        request.url.includes('admin.createSupportSemanticUniversalContentDraft') &&
        result.status >= 200 &&
        result.status < 300
      ) {
        state.dropCommittedUniversalDraftResponse = false
        state.droppedUniversalDraftResponses += 1
        response.destroy()
        return
      }
      if (
        state.dropCommittedDraftResponse &&
        request.url.includes('admin.createSupportLegacyKnowledgeAdoptionDraft') &&
        result.status >= 200 &&
        result.status < 300
      ) {
        state.dropCommittedDraftResponse = false
        state.droppedDraftResponses += 1
        response.destroy()
        return
      }
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
      response.end(responseBody)
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Connected tRPC fixture unavailable')
  state.server = server
  state.endpoint = `http://127.0.0.1:${address.port}`
  return state
}

async function connectedPage(browser: Browser) {
  if (!fixture) throw new Error('Connected fixture is unavailable')
  const context = await browser.newContext({
    baseURL: dashboardBaseURL,
    viewport: { width: 1280, height: 900 },
  })
  await context.route('**/api/trpc/**', async (route) => {
    const source = new URL(route.request().url())
    try {
      const result = await route.fetch({
        maxRetries: 0,
        url: `${fixture!.endpoint}${source.pathname}${source.search}`,
        headers: { ...route.request().headers(), authorization: `Bearer ${fixture!.token}` },
      })
      await route.fulfill({ response: result })
    } catch {
      await route.abort('failed')
    }
  })
  const page = await context.newPage()
  return { context, page }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
}

test.describe('connected semantic conflict resolution on disposable PostgreSQL', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!enabled, 'requires the guarded disposable semantic conflict browser database')

  test.beforeAll(async () => {
    fixture = await startFixtureServer()
  })

  test.afterAll(async () => {
    if (fixture) await closeServer(fixture.server)
    await db.$disconnect()
  })

  test('recovers an unknown committed resolution and separately approves its replacement', async ({
    browser,
  }, testInfo) => {
    if (!fixture) throw new Error('Connected fixture is unavailable')
    const { context, page } = await connectedPage(browser)
    try {
      const unauthenticated = await fetch(
        `${fixture.endpoint}/api/trpc/admin.listKnowledgeProposals?input=${encodeURIComponent(JSON.stringify({ json: { tenantId, venueId } }))}`,
      )
      expect(unauthenticated.status).toBe(401)
      await page.goto(
        `/dev-fixtures/semantic-conflict-resolution?connected=1&tenantId=${tenantId}&venueId=${venueId}`,
      )
      const original = page.locator(`#proposal-${fixture.proposalId}`)
      await expect(original).toBeVisible()
      await original.getByRole('button', { name: 'Build semantic change preview' }).click()
      await original.getByLabel('Visitor-facing title').fill('Willow gallery hours')
      await original.getByLabel('Category').fill('Hours')
      await original.getByLabel('Visitor-facing content').fill('The Willow gallery closes at 7 PM.')
      await original.getByRole('button', { name: 'Compute semantic preview' }).click()
      await expect(original.getByText(/signed operations sheet/u)).toBeVisible()
      await original.getByLabel(/Propose replacement/u).check()
      await original
        .getByRole('textbox', { name: 'Replacement content', exact: true })
        .fill(fixture.replacementContent)
      await original
        .getByLabel('Resolution note')
        .fill('Use the signed sheet for a separately reviewed replacement.')
      await original.getByRole('button', { name: 'Record resolution' }).click()
      await expect(original.getByRole('button', { name: 'Retry exact resolution' })).toBeVisible()
      const committedBeforeRetry = await db.semanticConflictResolution.findMany({
        where: { tenantId, venueId, proposalId: fixture.proposalId },
        select: { id: true, replacementProposalId: true },
      })
      expect(committedBeforeRetry).toHaveLength(1)
      expect(committedBeforeRetry[0]!.replacementProposalId).not.toBeNull()
      await original.getByRole('button', { name: 'Retry exact resolution' }).click()
      await expect(original.getByText('Replacement awaits review')).toBeVisible()
      await expect(original.getByText('CLOSED AFTER RESOLUTION')).toBeVisible()
      expect(fixture.droppedResolutionResponses).toBe(1)
      expect(fixture.resolutionRequestBodies).toHaveLength(2)
      expect(fixture.resolutionRequestBodies[1]).toBe(fixture.resolutionRequestBodies[0])

      const resolutions = await db.semanticConflictResolution.findMany({
        where: { tenantId, venueId, proposalId: fixture.proposalId },
        select: { replacementProposalId: true },
      })
      expect(resolutions).toHaveLength(1)
      const replacementProposalId = resolutions[0]!.replacementProposalId
      expect(replacementProposalId).toBe(committedBeforeRetry[0]!.replacementProposalId)
      expect(replacementProposalId).not.toBeNull()
      const beforeReview = await db.knowledgeChangeProposal.findMany({
        where: { tenantId, venueId, id: { in: [fixture.proposalId, replacementProposalId!] } },
        select: { id: true, status: true },
      })
      expect(beforeReview).toEqual(
        expect.arrayContaining([
          { id: fixture.proposalId, status: 'REJECTED' },
          { id: replacementProposalId, status: 'PENDING_REVIEW' },
        ]),
      )
      expect(
        await db.venueKnowledgeEntry.count({
          where: { tenantId, venueId, content: fixture.replacementContent },
        }),
      ).toBe(0)

      await page.getByRole('button', { name: 'Reload proposals' }).click()
      const replacement = page.locator(`#proposal-${replacementProposalId}`)
      await expect(replacement).toBeVisible()
      await replacement
        .getByLabel('Review note')
        .fill('Approve the replacement evidence for preview only.')
      const approve = replacement.getByRole('button', { name: 'Approve evidence' })
      await approve.click()
      await expect(approve).toBeEnabled()
      await page.getByRole('button', { name: 'Reload proposals' }).click()
      await expect(replacement.getByText('APPROVED', { exact: true })).toBeVisible()
      await replacement.getByRole('button', { name: 'Build semantic change preview' }).click()
      await expect(replacement.getByLabel('Change relationship')).toHaveValue('CORRECTS')
      await expect(replacement.getByLabel('Visitor-facing title')).toHaveValue(
        'Willow gallery hours',
      )
      await expect(replacement.getByLabel('Category')).toHaveValue('Hours')
      await expect(replacement.getByLabel('Visitor-facing content')).toHaveValue(
        fixture.replacementContent,
      )
      await replacement.getByRole('button', { name: 'Compute semantic preview' }).click()
      await expect(replacement.getByText('CORRECTION', { exact: true })).toBeVisible()

      const persisted = await db.knowledgeChangeProposal.findFirstOrThrow({
        where: { id: replacementProposalId!, tenantId, venueId },
        select: { status: true },
      })
      expect(persisted.status).toBe('APPROVED')
      const canonical = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { id: fixture.entryId, tenantId, venueId },
        select: { title: true, category: true, content: true, isEnabled: true },
      })
      expect(canonical).toEqual({
        title: 'Willow gallery hours',
        category: 'Hours',
        content: 'The Willow gallery closes at 5 PM.',
        isEnabled: true,
      })
      const contentEffects = await Promise.all([
        db.contentModuleIdentity.count({ where: { tenantId, venueId } }),
        db.contentModuleRevision.count({ where: { tenantId, venueId } }),
        db.contentModulePublication.count({ where: { tenantId, venueId } }),
      ])
      expect(contentEffects).toEqual([0, 0, 0])

      await replacement.getByRole('button', { name: 'Prepare private draft' }).click()
      await replacement.getByRole('combobox', { name: 'Content type' }).selectOption('POLICY')
      await replacement.getByRole('combobox', { name: 'Content type' }).focus()
      await page.keyboard.press('Tab')
      await expect(replacement.getByRole('combobox', { name: 'Audience' })).toBeFocused()
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        await page.screenshot({
          path: testInfo.outputPath(`prepared-private-draft-${width}.png`),
          fullPage: true,
        })
      }

      await replacement.getByRole('button', { name: 'Create private draft' }).click()
      await expect(
        replacement.getByRole('button', { name: 'Retry exact private draft' }),
      ).toBeVisible()

      const committedDraftBeforeRetry = await db.contentModuleRevision.findMany({
        where: { tenantId, venueId },
        select: {
          id: true,
          moduleId: true,
          version: true,
          audience: true,
          policy: { select: { title: true, rule: true, appliesTo: true } },
          evidence: {
            select: { sourceId: true, locator: true, excerptHash: true },
            orderBy: { sourceId: 'asc' },
          },
        },
      })
      expect(committedDraftBeforeRetry).toHaveLength(1)
      expect(committedDraftBeforeRetry[0]).toMatchObject({
        version: 1,
        audience: 'PUBLIC',
        policy: {
          title: 'Willow gallery hours',
          rule: fixture.replacementContent,
          appliesTo: [],
        },
        evidence: [
          {
            sourceId: `support-message:${fixture.supportMessageId}`,
            locator: `support-request:${fixture.supportRequestId}`,
            excerptHash: fixture.originalSupportBodyHash,
          },
        ],
      })
      expect(
        await Promise.all([
          db.contentModuleIdentity.count({ where: { tenantId, venueId } }),
          db.legacyKnowledgeUniversalContentAdoption.count({ where: { tenantId, venueId } }),
        ]),
      ).toEqual([1, 1])
      expect(await db.contentModulePublication.count({ where: { tenantId, venueId } })).toBe(0)
      expect(
        await db.legacyKnowledgeAdoptionActivation.count({ where: { tenantId, venueId } }),
      ).toBe(0)
      expect(fixture.droppedDraftResponses).toBe(1)
      expect(fixture.draftRequestBodies).toHaveLength(1)

      await replacement.getByRole('button', { name: 'Retry exact private draft' }).click()
      await expect(
        replacement.getByText('Private draft ready for separate publication review'),
      ).toBeVisible()
      expect(fixture.droppedDraftResponses).toBe(1)
      expect(fixture.draftRequestBodies).toHaveLength(2)
      expect(fixture.draftRequestBodies[1]).toBe(fixture.draftRequestBodies[0])
      expect(await db.contentModuleRevision.count({ where: { tenantId, venueId } })).toBe(1)
      expect(await db.contentModulePublication.count({ where: { tenantId, venueId } })).toBe(0)
      expect(
        await db.legacyKnowledgeAdoptionActivation.count({ where: { tenantId, venueId } }),
      ).toBe(0)
      expect(
        await db.venueKnowledgeEntry.findFirstOrThrow({
          where: { id: fixture.entryId, tenantId, venueId },
          select: { content: true },
        }),
      ).toEqual({ content: 'The Willow gallery closes at 5 PM.' })

      await testInfo.attach('durable-resolution-readback', {
        body: JSON.stringify(
          {
            proposalId: fixture.proposalId,
            replacementProposalId,
            committedBeforeRetry: committedBeforeRetry[0],
            resolutionRequests: fixture.resolutionRequestBodies.length,
            exactRetryBodyHash: createHash('sha256')
              .update(fixture.resolutionRequestBodies[0]!)
              .digest('hex'),
            replacementStatus: persisted.status,
            contentEffects,
            privateDraft: committedDraftBeforeRetry[0],
            privateDraftRequests: fixture.draftRequestBodies.length,
            exactPrivateDraftRetryBodyHash: createHash('sha256')
              .update(fixture.draftRequestBodies[0]!)
              .digest('hex'),
            publicationCount: 0,
            activationCount: 0,
            canonical,
            authentication: 'synthetic platform admin; unauthenticated request denied',
          },
          null,
          2,
        ),
        contentType: 'application/json',
      })
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        await page.screenshot({
          path: testInfo.outputPath(`replacement-private-draft-${width}.png`),
          fullPage: true,
        })
      }

      await page.getByRole('button', { name: 'Reload proposals' }).click()
      const addition = page.locator(`#proposal-${fixture.additionProposalId}`)
      await expect(addition).toBeVisible()
      await addition.getByRole('button', { name: 'Build semantic change preview' }).click()
      await addition.getByLabel('Change relationship').selectOption('NEW_FACT')
      await addition.getByLabel('Visitor-facing title').fill('Juniper quiet room')
      await addition.getByLabel('Category').fill('Visitor services')
      await addition.getByLabel('Visitor-facing content').fill(fixture.additionContent)
      await addition.getByRole('button', { name: 'Compute semantic preview' }).click()
      await expect(addition.getByText('ADDITION', { exact: true })).toBeVisible()
      await addition.getByRole('button', { name: 'Prepare private draft' }).click()
      await addition.getByRole('combobox', { name: 'Content type' }).selectOption('POLICY')
      await expect(addition.getByText('Approved wording')).toBeVisible()
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        await page.screenshot({
          path: testInfo.outputPath(`universal-addition-prepared-${width}.png`),
          fullPage: true,
        })
      }
      await addition.getByRole('button', { name: 'Create private draft' }).click()
      await expect(
        addition.getByRole('button', { name: 'Retry exact private draft' }),
      ).toBeVisible()
      const additionReceiptBeforeRetry =
        await db.knowledgeProposalUniversalContentHandoff.findFirstOrThrow({
          where: { proposalId: fixture.additionProposalId, tenantId, venueId },
          select: { moduleId: true, revisionId: true, classification: true },
        })
      expect(additionReceiptBeforeRetry.classification).toBe('ADDITION')
      expect(
        await db.contentModuleRevision.count({
          where: { tenantId, venueId, moduleId: additionReceiptBeforeRetry.moduleId },
        }),
      ).toBe(1)
      expect(fixture.droppedUniversalDraftResponses).toBe(1)
      expect(fixture.universalDraftRequestBodies).toHaveLength(1)
      await addition.getByRole('button', { name: 'Retry exact private draft' }).click()
      await expect(
        addition.getByText('Private draft ready for separate publication review'),
      ).toBeVisible()
      expect(fixture.universalDraftRequestBodies).toHaveLength(2)
      expect(fixture.universalDraftRequestBodies[1]).toBe(fixture.universalDraftRequestBodies[0])
      expect(
        await db.contentModuleEvidence.findMany({
          where: {
            tenantId,
            venueId,
            revisionId: additionReceiptBeforeRetry.revisionId,
            sourceId: `support-message:${fixture.additionSupportMessageId}`,
          },
          select: { sourceId: true, locator: true, excerptHash: true },
        }),
      ).toEqual([
        {
          sourceId: `support-message:${fixture.additionSupportMessageId}`,
          locator: `support-request:${fixture.additionSupportRequestId}`,
          excerptHash: fixture.additionBodyHash,
        },
      ])
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        await page.screenshot({
          path: testInfo.outputPath(`universal-addition-created-${width}.png`),
          fullPage: true,
        })
      }

      const additionPublication = await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: additionReceiptBeforeRetry.moduleId,
        revisionId: additionReceiptBeforeRetry.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor: { type: 'HUMAN', id: adminId, role: 'PLATFORM_ADMIN' },
      })
      const nativeTarget = await db.venueKnowledgeEntry.create({
        data: {
          id: `native-quiet-room-${randomUUID()}`,
          tenantId,
          venueId,
          title: 'Juniper quiet room',
          category: 'Visitor services',
          content: fixture.additionContent,
          isEnabled: true,
          visibility: 'PUBLIC',
          sourceType: 'SYNTHETIC_FIXTURE',
          authorship: 'HUMAN_AUTHORED',
          contentModuleId: additionReceiptBeforeRetry.moduleId,
          contentRevisionId: additionReceiptBeforeRetry.revisionId,
          contentPublicationId: additionPublication.publicationId,
        },
        select: { id: true },
      })
      const supersedingContent =
        'The Juniper quiet room is now beside the south conservation studio.'
      const supersession = await withTenantIsolationBypass(async () => {
        const request = await db.supportRequest.create({
          data: {
            tenantId,
            venueId,
            category: 'CONTENT_CORRECTION',
            status: 'IN_REVIEW',
            subject: 'Updated quiet room location',
            createdByKind: 'OPERATOR',
            createdById: adminId,
            updatedByKind: 'OPERATOR',
            updatedById: adminId,
          },
        })
        await db.supportRequestAuditEvent.create({
          data: {
            tenantId,
            venueId,
            supportRequestId: request.id,
            requestVersion: request.version,
            eventType: 'STATUS_CHANGED',
            actorKind: 'OPERATOR',
            actorId: adminId,
            fromStatus: 'OPEN',
            toStatus: 'IN_REVIEW',
          },
        })
        const message = await db.supportMessage.create({
          data: {
            tenantId,
            venueId,
            supportRequestId: request.id,
            authorKind: 'CLIENT',
            authorId: adminId,
            visibility: 'CLIENT_VISIBLE',
            body: supersedingContent,
            submissionRequestId: randomUUID(),
            submissionInputHash: createHash('sha256').update(supersedingContent).digest('hex'),
            requestVersion: request.version,
            clientVersion: request.clientVersion,
          },
        })
        return { request, message }
      })
      const supersessionProposalId = randomUUID()
      await prepareSupportKnowledgeProposalAction({
        operationId: supersessionProposalId,
        tenantId,
        venueId,
        supportRequestId: supersession.request.id,
        expectedVersion: supersession.request.version,
        evidenceMessageIds: [supersession.message.id],
        targetKnowledgeEntryId: nativeTarget.id,
        correctionKind: 'UPDATE_KNOWLEDGE',
        aiInference: 'The newer support evidence supersedes the published quiet-room location.',
        proposedChange: supersedingContent,
        reason: 'Prepare the exact native supersession for human review.',
        confidence: 0.93,
        actor: {
          type: 'AGENT',
          actorId: fixture.identityId,
          role: 'AGENT',
          agentIdentityId: fixture.identityId,
          agentRunId: `run-${supersessionProposalId}`,
          workerId: `worker-${supersessionProposalId}`,
          credentialId: `credential-${supersessionProposalId}`,
          capability: 'knowledge:draft',
          idempotencyKey: supersessionProposalId,
          modelProvider: 'deterministic-fixture',
          modelName: 'support-authoring-browser-v1',
        },
      })
      await page.getByRole('button', { name: 'Reload proposals' }).click()
      const nativeSupersession = page.locator(`#proposal-${supersessionProposalId}`)
      await nativeSupersession
        .getByLabel('Review note')
        .fill('Approve the second support message for a private native supersession.')
      await nativeSupersession.getByRole('button', { name: 'Approve evidence' }).click()
      await page.getByRole('button', { name: 'Reload proposals' }).click()
      await nativeSupersession
        .getByRole('button', { name: 'Build semantic change preview' })
        .click()
      await nativeSupersession.getByLabel('Change relationship').selectOption('SUPERSEDES')
      await nativeSupersession.getByLabel('Visitor-facing title').fill('Juniper quiet room')
      await nativeSupersession.getByLabel('Category').fill('Visitor services')
      await nativeSupersession.getByLabel('Visitor-facing content').fill(supersedingContent)
      await nativeSupersession.getByRole('button', { name: 'Compute semantic preview' }).click()
      await expect(nativeSupersession.getByText('SUPERSESSION', { exact: true })).toBeVisible()
      await nativeSupersession.getByRole('button', { name: 'Prepare private draft' }).click()
      const fixedKind = nativeSupersession.getByRole('combobox', { name: 'Content type' })
      await expect(fixedKind).toHaveValue('POLICY')
      await expect(fixedKind).toBeDisabled()
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        await page.screenshot({
          path: testInfo.outputPath(`native-supersession-prepared-${width}.png`),
          fullPage: true,
        })
      }
      await nativeSupersession.getByRole('button', { name: 'Create private draft' }).click()
      await expect(
        nativeSupersession.getByText('Private draft ready for separate publication review'),
      ).toBeVisible()
      const nativeReceipt = await db.knowledgeProposalUniversalContentHandoff.findFirstOrThrow({
        where: { proposalId: supersessionProposalId, tenantId, venueId },
        select: { moduleId: true, revisionId: true, classification: true },
      })
      expect(nativeReceipt).toMatchObject({
        moduleId: additionReceiptBeforeRetry.moduleId,
        classification: 'SUPERSESSION',
      })
      expect(
        await db.contentModuleRevision.count({
          where: { tenantId, venueId, moduleId: additionReceiptBeforeRetry.moduleId },
        }),
      ).toBe(2)
      expect(await db.contentModuleIdentity.count({ where: { tenantId, venueId } })).toBe(2)
      expect(
        await db.contentModuleEvidence.findMany({
          where: {
            tenantId,
            venueId,
            revisionId: nativeReceipt.revisionId,
            sourceId: `support-message:${supersession.message.id}`,
          },
          select: { sourceId: true, locator: true, excerptHash: true },
        }),
      ).toEqual([
        {
          sourceId: `support-message:${supersession.message.id}`,
          locator: `support-request:${supersession.request.id}`,
          excerptHash: createHash('sha256').update(supersedingContent).digest('hex'),
        },
      ])
      await page.reload()
      const reloadedSupersession = page.locator(`#proposal-${supersessionProposalId}`)
      await reloadedSupersession
        .getByRole('button', { name: 'Build semantic change preview' })
        .click()
      await reloadedSupersession.getByLabel('Change relationship').selectOption('SUPERSEDES')
      await reloadedSupersession.getByLabel('Visitor-facing title').fill('Juniper quiet room')
      await reloadedSupersession.getByLabel('Category').fill('Visitor services')
      await reloadedSupersession.getByLabel('Visitor-facing content').fill(supersedingContent)
      await reloadedSupersession.getByRole('button', { name: 'Compute semantic preview' }).click()
      await reloadedSupersession.getByRole('button', { name: 'Prepare private draft' }).click()
      await expect(reloadedSupersession.getByText('Existing content revision')).toBeVisible()
      await expect(
        reloadedSupersession.getByRole('button', { name: 'Create private draft' }),
      ).toHaveCount(0)
      expect(
        await db.contentModuleRevision.count({
          where: { tenantId, venueId, moduleId: additionReceiptBeforeRetry.moduleId },
        }),
      ).toBe(2)
      expect(await db.contentModuleIdentity.count({ where: { tenantId, venueId } })).toBe(2)
      expect(
        await db.contentModuleRevision.count({
          where: {
            id: additionReceiptBeforeRetry.revisionId,
            tenantId,
            venueId,
            moduleId: additionReceiptBeforeRetry.moduleId,
            version: 1,
          },
        }),
      ).toBe(1)
      expect(await db.contentModulePublication.count({ where: { tenantId, venueId } })).toBe(1)
      await testInfo.attach('support-universal-authoring-readback', {
        body: JSON.stringify(
          {
            additionProposalId: fixture.additionProposalId,
            additionReceipt: additionReceiptBeforeRetry,
            additionSupportEvidence: {
              sourceId: `support-message:${fixture.additionSupportMessageId}`,
              locator: `support-request:${fixture.additionSupportRequestId}`,
              excerptHash: fixture.additionBodyHash,
            },
            droppedUniversalDraftResponses: fixture.droppedUniversalDraftResponses,
            exactUniversalRetryBodyHash: createHash('sha256')
              .update(fixture.universalDraftRequestBodies[0]!)
              .digest('hex'),
            supersessionProposalId,
            supersessionReceipt: nativeReceipt,
            supersessionSupportEvidence: {
              sourceId: `support-message:${supersession.message.id}`,
              locator: `support-request:${supersession.request.id}`,
              excerptHash: createHash('sha256').update(supersedingContent).digest('hex'),
            },
            moduleIdentityCount: 2,
            moduleRevisionCount: 3,
            modulePublicationCount: 1,
            adoptionActivationCount: 0,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      })
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        await page.screenshot({
          path: testInfo.outputPath(`native-supersession-created-${width}.png`),
          fullPage: true,
        })
      }

      expect(
        await db.venueKnowledgeEntry.count({
          where: { tenantId, venueId, content: fixture.replacementContent },
        }),
      ).toBe(0)
    } finally {
      await context.close()
    }
  })
})
