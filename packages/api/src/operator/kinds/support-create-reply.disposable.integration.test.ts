/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed parsed output */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { resolveOperatorConfig } from '../config'
import { OperatorNotFoundError } from '../grants'
import type { VerifiedOperatorGrant } from '../oauth'
import { approveAndApplyProposal, createKindRegistry, createProposal } from '../proposals'
import { setNotificationDepsForTests } from '../notifications'
import { OPERATOR_PROPOSAL_KINDS } from './index'

/**
 * New support request and customer reply proposals, and the notification intent an approved
 * request records, on a real disposable PostgreSQL. Invented names only. Email is never sent: the
 * queue and identity provider are replaced by recorders, and the deployment switch is exercised
 * both ways. Runs only against a database named pathfinder_disposable_*.
 */
const enabled =
  process.env.RUN_OPERATOR_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

const resolution = resolveOperatorConfig({
  OPERATOR_OAUTH_ENABLED: true,
  OPERATOR_OAUTH_ISSUER: 'https://app.operator.test',
  OPERATOR_OAUTH_PEPPERS: `k1:${randomBytes(32).toString('base64url')}`,
  OPERATOR_OAUTH_REDIRECT_ORIGINS: 'https://connector.example.com',
  OPERATOR_OAUTH_ALLOWED_USER_IDS: 'user_owner',
  RAILWAY_ENVIRONMENT: 'staging',
})
if (resolution.status !== 'ready') throw new Error('operator config not ready')
const config = resolution.config
const kinds = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
const dependencies = { database: db, kinds, allowedUserIds: config.allowedUserIds }

const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const tenantId = `scr-tenant-${suffix}`
const otherTenantId = `scr-other-${suffix}`
const clientId = `opc_scr_${suffix}`
const memberId = `scr-member-${suffix}`
const otherMemberId = `scr-outsider-${suffix}`
let venueId = ''
let grant: VerifiedOperatorGrant
let otherGrant: VerifiedOperatorGrant

const service = (forGrant = grant) => ({
  config,
  database: db,
  grant: forGrant,
  kinds,
  now: new Date(),
  requestId: randomUUID(),
})
const propose = (
  tool: string,
  args: Record<string, unknown>,
  operationId = randomUUID(),
  forGrant = grant,
) => createProposal(tool, { ...args, operationId }, service(forGrant))
const approve = (view: { proposalId: string; argsHash: string }) =>
  approveAndApplyProposal(
    {
      proposalId: view.proposalId,
      argsHash: view.argsHash,
      actorUserId: 'user_owner',
      requestId: randomUUID(),
      now: new Date(),
    },
    dependencies,
  )

describe.skipIf(!enabled)(
  'operator support create and reply on disposable PostgreSQL',
  { timeout: 120_000 },
  () => {
    const queued: unknown[] = []
    let switchOn = false

    beforeAll(async () => {
      setNotificationDepsForTests({
        emailEnabled: () => switchOn,
        resolveVerifiedEmail: async (userId) => (userId === memberId ? 'member@example.com' : null),
        enqueueEmail: async (payload) => {
          queued.push(payload)
        },
      })
      await withTenantIsolationBypass(async () => {
        for (const id of [tenantId, otherTenantId]) {
          await db.tenant.create({ data: { id, name: `Example ${id}`, slug: id } })
        }
        venueId = `scr-venue-${suffix}`
        await db.venue.create({
          data: { id: venueId, tenantId, name: 'Example Garden', slug: `scr-garden-${suffix}` },
        })
        for (const [id, tenant] of [
          [memberId, tenantId],
          [otherMemberId, otherTenantId],
        ] as const) {
          await db.user.create({ data: { id, email: `${id}@example.com` } })
          await db.tenantMembership.create({
            data: { tenantId: tenant, userId: id, role: 'OWNER', status: 'ACTIVE' },
          })
        }
      })
      await db.operatorOAuthClient.create({
        data: {
          id: clientId,
          clientName: 'Example connector',
          redirectUris: ['https://connector.example.com/cb'],
          registrationIpHash: 'a'.repeat(64),
          consentedAt: new Date(),
        },
      })
      const make = async (tenants: string[]) => {
        const row = await db.operatorGrant.create({
          data: {
            clientId,
            userId: 'user_owner',
            allTenants: false,
            tenantIds: tenants,
            capabilities: [...OperatorCapability.options],
            resource: config.resource,
            scope: 'operator',
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        })
        return {
          grantId: row.id,
          clientId,
          userId: 'user_owner',
          allTenants: false,
          tenantIds: tenants,
          capabilities: [...OperatorCapability.options],
        } satisfies VerifiedOperatorGrant
      }
      grant = await make([tenantId])
      otherGrant = await make([otherTenantId])
    })

    afterAll(async () => {
      setNotificationDepsForTests(null)
      await db.$disconnect()
    })

    const createArgs = (overrides: Record<string, unknown> = {}) => ({
      tenantId,
      venueId,
      recipientUserId: memberId,
      category: 'GENERAL',
      subject: 'Current menu photos',
      body: 'Could you share current menu photos when you have a moment?',
      priority: 'HIGH',
      ...overrides,
    })

    it('opens a request only after a person approves, for an active member of that tenant', async () => {
      const view = await propose('support.propose_create_request', createArgs())
      expect(view.status).toBe('PENDING')
      expect(await db.supportRequest.count({ where: { tenantId } })).toBe(0)

      expect((await approve(view)).status).toBe('APPLIED')

      const request = await db.supportRequest.findFirstOrThrow({
        where: { tenantId, subject: 'Current menu photos' },
      })
      expect(request).toMatchObject({ status: 'OPEN', createdByKind: 'OPERATOR', venueId })
      expect(request.artifacts).toMatchObject({ operatorPriority: 'HIGH' })
      const message = await db.supportMessage.findFirstOrThrow({
        where: { tenantId, supportRequestId: request.id },
      })
      expect(message.visibility).toBe('CLIENT_VISIBLE')
      expect(
        await db.supportRequestParticipant.count({
          where: { tenantId, supportRequestId: request.id, userId: memberId },
        }),
      ).toBe(1)
      expect(
        await db.auditLog.count({
          where: { tenantId, action: 'support-request.created-by-operator', targetId: request.id },
        }),
      ).toBe(1)
      // Portal only unless email was asked for: no intent, nothing queued.
      expect(await db.clientNotificationIntent.count({ where: { tenantId } })).toBe(0)
    })

    it('returns the same proposal for a replayed operation and never opens a second request', async () => {
      const operationId = randomUUID()
      const args = createArgs({ subject: 'Replay subject' })
      const first = await propose('support.propose_create_request', args, operationId)
      const again = await propose('support.propose_create_request', args, operationId)
      expect(again.proposalId).toBe(first.proposalId)
      await approve(first)
      // A second approval of an applied proposal is refused; either way nothing is repeated.
      await approve(first).catch(() => undefined)
      expect(
        await db.supportRequest.count({ where: { tenantId, subject: 'Replay subject' } }),
      ).toBe(1)
    })

    it('refuses another tenant, and a recipient from another tenant, as not found', async () => {
      await expect(
        propose('support.propose_create_request', createArgs(), randomUUID(), otherGrant),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      await expect(
        propose('support.propose_create_request', createArgs({ recipientUserId: otherMemberId })),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      await expect(
        propose(
          'support.propose_create_request',
          createArgs({ tenantId: otherTenantId, recipientUserId: otherMemberId }),
        ),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
    })

    it('goes stale when the recipient leaves the tenant before approval', async () => {
      const leaver = `scr-leaver-${suffix}`
      await withTenantIsolationBypass(async () => {
        await db.user.create({ data: { id: leaver, email: `${leaver}@example.com` } })
        await db.tenantMembership.create({
          data: { tenantId, userId: leaver, role: 'STAFF', status: 'ACTIVE' },
        })
      })
      const view = await propose(
        'support.propose_create_request',
        createArgs({ recipientUserId: leaver, subject: 'Leaver subject' }),
      )
      await withTenantIsolationBypass(() =>
        db.tenantMembership.updateMany({
          where: { tenantId, userId: leaver },
          data: { status: 'SUSPENDED' },
        }),
      )

      expect((await approve(view)).status).toBe('STALE')
      expect(
        await db.supportRequest.count({ where: { tenantId, subject: 'Leaver subject' } }),
      ).toBe(0)
    })

    it('records one intent, queues one email and reposts nothing when email is asked for and allowed', async () => {
      switchOn = true
      queued.length = 0
      const view = await propose(
        'support.propose_create_request',
        createArgs({ subject: 'Email subject', notifyByEmail: true }),
      )
      expect((await approve(view)).status).toBe('APPLIED')

      const request = await db.supportRequest.findFirstOrThrow({
        where: { tenantId, subject: 'Email subject' },
      })
      const intent = await db.clientNotificationIntent.findFirstOrThrow({
        where: { tenantId, supportRequestId: request.id },
      })
      expect(intent).toMatchObject({
        recipientUserId: memberId,
        recipientEmail: 'member@example.com',
        emailStatus: 'QUEUED',
        emailGeneration: 1,
      })
      expect(queued).toEqual([{ tenantId, intentId: intent.id, generation: 1 }])
      const receipts = await db.clientNotificationReceipt.findMany({
        where: { tenantId, intentId: intent.id },
        orderBy: { createdAt: 'asc' },
      })
      expect(receipts.map((receipt) => receipt.status)).toEqual(['PORTAL_POSTED', 'EMAIL_QUEUED'])
      // Receipts are evidence: the database refuses to change or remove one.
      await expect(
        db.clientNotificationReceipt.update({
          where: { id: receipts[0]!.id },
          data: { status: 'EMAIL_SENT' },
        }),
      ).rejects.toThrow()
    })

    it('posts to the portal and records the email as not sent while the switch is off', async () => {
      switchOn = false
      queued.length = 0
      const view = await propose(
        'support.propose_create_request',
        createArgs({ subject: 'Switch off subject', notifyByEmail: true }),
      )
      expect((await approve(view)).status).toBe('APPLIED')

      const request = await db.supportRequest.findFirstOrThrow({
        where: { tenantId, subject: 'Switch off subject' },
      })
      expect(
        await db.supportMessage.count({ where: { tenantId, supportRequestId: request.id } }),
      ).toBe(1)
      expect(
        await db.clientNotificationIntent.findFirstOrThrow({
          where: { tenantId, supportRequestId: request.id },
        }),
      ).toMatchObject({ emailStatus: 'FAILED', emailLastErrorCode: 'EMAIL_DELIVERY_DISABLED' })
      expect(queued).toHaveLength(0)
    })

    it('replies to the customer at the version it read, portal only', async () => {
      const request = await db.supportRequest.findFirstOrThrow({
        where: { tenantId, subject: 'Current menu photos' },
      })
      const view = await propose('support.propose_client_reply', {
        tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        body: 'Thank you, we have received your photos.',
      })
      expect(view.status).toBe('PENDING')

      expect((await approve(view)).status).toBe('APPLIED')

      const reply = await db.supportMessage.findFirstOrThrow({
        where: {
          tenantId,
          supportRequestId: request.id,
          authorKind: 'OPERATOR',
          visibility: 'CLIENT_VISIBLE',
        },
        orderBy: { createdAt: 'desc' },
      })
      expect(reply.body).toBe('Thank you, we have received your photos.')
      expect(
        await db.clientNotificationIntent.count({
          where: { tenantId, supportRequestId: request.id },
        }),
      ).toBe(0)
    })

    it('a customer message that arrived after the reply was read makes it stale', async () => {
      const request = await db.supportRequest.findFirstOrThrow({
        where: { tenantId, subject: 'Replay subject' },
      })
      const view = await propose('support.propose_client_reply', {
        tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        body: 'This reply was drafted before the customer wrote again.',
      })
      await withTenantIsolationBypass(async () => {
        await db.supportRequest.update({
          where: { id: request.id },
          data: { version: { increment: 1 } },
        })
        await db.supportMessage.create({
          data: {
            tenantId,
            venueId,
            supportRequestId: request.id,
            authorKind: 'CLIENT',
            authorId: memberId,
            visibility: 'CLIENT_VISIBLE',
            clientVersion: 2,
            body: 'Actually, one more thing.',
          },
        })
      })

      expect((await approve(view)).status).toBe('STALE')
      expect(
        await db.supportMessage.count({
          where: {
            tenantId,
            supportRequestId: request.id,
            authorKind: 'OPERATOR',
            body: { startsWith: 'This reply' },
          },
        }),
      ).toBe(0)
    })

    it('does not let another tenant reply to, or read, this tenant request', async () => {
      const request = await db.supportRequest.findFirstOrThrow({
        where: { tenantId, subject: 'Current menu photos' },
      })

      await expect(
        propose(
          'support.propose_client_reply',
          {
            tenantId,
            venueId,
            requestId: request.id,
            expectedVersion: request.version,
            body: 'Hello',
          },
          randomUUID(),
          otherGrant,
        ),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
      await expect(
        propose(
          'support.propose_client_reply',
          {
            tenantId: otherTenantId,
            venueId,
            requestId: request.id,
            expectedVersion: request.version,
            body: 'Hello',
          },
          randomUUID(),
          otherGrant,
        ),
      ).rejects.toBeInstanceOf(OperatorNotFoundError)
    })
  },
)
