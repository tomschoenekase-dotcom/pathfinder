import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '../index'
import { reviewProspectInboundReplyAction } from './prospect-inbound-reply-review-actions'

const enabled =
  process.env.RUN_PROSPECT_ONBOARDING_DELIVERY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

const disposable = enabled ? it : it.skip

describe('positive-interest onboarding delivery disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  disposable(
    'creates one provider-dark DRAFT per exact venue across replay and retry',
    async () => {
      await withTenantIsolationBypass(async () => {
        const suffix = randomUUID().slice(0, 8)
        const actor = {
          type: 'HUMAN' as const,
          id: `founder-${suffix}`,
          role: 'PLATFORM_ADMIN' as const,
        }
        const organization = await db.prospectOrganization.create({
          data: {
            canonicalName: `Museum Group ${suffix}`,
            normalizedName: `museum group ${suffix}`,
            source: 'disposable-positive-interest',
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        })
        const venues = await Promise.all(
          ['North', 'South'].map((name) =>
            db.prospectVenue.create({
              data: {
                organizationId: organization.id,
                name: `${name} Museum ${suffix}`,
                normalizedName: `${name.toLowerCase()} museum ${suffix}`,
                createdBy: actor.id,
                updatedBy: actor.id,
              },
            }),
          ),
        )
        const email = `guide-${suffix}@example.test`
        const contact = await db.prospectContact.create({
          data: {
            organizationId: organization.id,
            venueId: null,
            fullName: 'Avery Guide',
            email,
            normalizedEmail: email,
            source: 'disposable-positive-interest',
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        })
        const messages = []
        for (const venue of venues) {
          const thread = await db.prospectEmailThread.create({
            data: {
              organizationId: organization.id,
              venueId: venue.id,
              contactId: contact.id,
              replyTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
            },
          })
          messages.push(
            await db.prospectEmailMessage.create({
              data: {
                threadId: thread.id,
                organizationId: organization.id,
                venueId: venue.id,
                contactId: contact.id,
                direction: 'INBOUND',
                status: 'RECEIVED',
                fromAddress: email,
                toAddresses: ['founder@example.test'],
                subject: `Interested in ${venue.name}`,
                bodyRetentionState: 'NOT_STORED',
                sourceReference: `gmail://message/${venue.id}`,
                occurredAt: new Date(),
              },
            }),
          )
        }

        const firstOperationId = randomUUID()
        const firstInput = {
          operationId: firstOperationId,
          messageId: messages[0]!.id,
          disposition: 'POSITIVE_INTEREST' as const,
          reason: 'Human reviewed the reply and confirmed positive interest.',
          actor,
        }
        const concurrent = await Promise.all([
          reviewProspectInboundReplyAction(firstInput),
          reviewProspectInboundReplyAction(firstInput),
        ])
        expect(concurrent.map((result) => result.replayed).sort()).toEqual([false, true])
        expect(new Set(concurrent.map((result) => result.deliveryAttempt?.id)).size).toBe(1)

        const retriedClassification = await reviewProspectInboundReplyAction({
          ...firstInput,
          operationId: randomUUID(),
          reason: 'A second human callback confirms the same positive-interest scope.',
        })
        expect(retriedClassification).toMatchObject({
          replayed: false,
          deliveryAttempt: { id: concurrent[0]!.deliveryAttempt!.id, status: 'DRAFT' },
        })

        const secondVenue = await reviewProspectInboundReplyAction({
          operationId: randomUUID(),
          messageId: messages[1]!.id,
          disposition: 'POSITIVE_INTEREST',
          reason: 'Human reviewed positive interest for the second exact venue.',
          actor,
        })
        expect(secondVenue.deliveryAttempt?.id).not.toBe(concurrent[0]!.deliveryAttempt!.id)

        const retained = await db.prospectOnboardingDeliveryAttempt.findMany({
          where: { organizationId: organization.id },
          orderBy: { prospectVenueId: 'asc' },
        })
        expect(retained).toHaveLength(2)
        expect(new Set(retained.map((attempt) => attempt.prospectVenueId))).toEqual(
          new Set(venues.map((venue) => venue.id)),
        )
        expect(retained).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: 'DRAFT',
              contactId: contact.id,
              recipientEmailSnapshot: email,
              templateVersion: 'positive-interest-onboarding-v1',
            }),
          ]),
        )
        expect(await db.prospectSendOutbox.count()).toBe(0)
        expect(await db.customerAccessRequest.count()).toBe(0)
        expect(await db.tenant.count()).toBe(0)
        expect(await db.venue.count()).toBe(0)
      })
    },
  )
})
