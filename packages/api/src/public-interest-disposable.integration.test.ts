import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from './core'
import type { TRPCContext } from './context'
import { adminPublicInterestRouter } from './routers/admin/public-interest'
import { publicInterestRouter } from './routers/public-interest'

const disposable = process.env.PATHFINDER_PUBLIC_INTEREST_DISPOSABLE === '1' ? it : it.skip

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.44' }),
    session: isPlatformAdmin
      ? {
          userId: 'disposable-founder',
          activeTenantId: null,
          role: null,
          isPlatformAdmin: true,
        }
      : { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
  }
}

const externalEffectCounts = () =>
  withTenantIsolationBypass(async () => ({
    tenants: await db.tenant.count(),
    venues: await db.venue.count(),
    billingAccounts: await db.billingAccount.count(),
    sendOutbox: await db.prospectSendOutbox.count(),
    emailThreads: await db.prospectEmailThread.count(),
  }))

describe('public interest disposable database lifecycle', () => {
  disposable(
    'persists, reviews, converts once, and preserves every external-effect boundary',
    async () => {
      const requestId = randomUUID()
      const publicCaller = router({ interest: publicInterestRouter }).createCaller(
        context(false),
      ).interest
      const request = {
        requestId,
        organizationName: 'Disposable River Museum',
        contactName: 'Avery Guide',
        workEmail: `avery-${requestId}@example.test`,
        website: 'https://example.test',
        cityRegion: 'St. Louis, MO',
        venueType: 'Museum or gallery',
        message: 'Please show us the remote setup workflow.',
      }
      const externalBefore = await externalEffectCounts()

      await expect(publicCaller.submit(request)).resolves.toEqual({ received: true })
      await expect(publicCaller.submit(request)).resolves.toEqual({ received: true })
      const stored = await db.publicInterestSubmission.findUniqueOrThrow({ where: { requestId } })
      expect(stored.status).toBe('NEW')
      expect(await db.publicInterestSubmission.count({ where: { requestId } })).toBe(1)

      const adminCaller = router({ interest: adminPublicInterestRouter }).createCaller(
        context(true),
      ).interest
      await adminCaller.reviewPublicInterestSubmission({
        operationId: randomUUID(),
        submissionId: stored.id,
        decision: 'MARK_REVIEWED',
        reason: 'Disposable review proof.',
      })
      const reviewed = await db.publicInterestSubmission.findUniqueOrThrow({
        where: { id: stored.id },
      })
      expect(reviewed).toMatchObject({ status: 'REVIEWED', reviewedBy: 'disposable-founder' })

      const conversionOperationId = randomUUID()
      const converted = await adminCaller.convertPublicInterestSubmissionToProspect({
        operationId: conversionOperationId,
        submissionId: stored.id,
        reason: 'Disposable canonical CRM conversion proof.',
      })
      expect(converted).toMatchObject({ replayed: false })
      expect(converted.organization).toMatchObject({
        canonicalName: request.organizationName,
        source: 'public-interest',
      })
      if (!converted.venue || !converted.contact) {
        throw new Error('Conversion did not create the required venue and contact')
      }
      expect(converted.venue).toMatchObject({ name: request.organizationName })
      expect(converted.contact).toMatchObject({
        email: request.workEmail,
        emailReadiness: 'REVIEW_REQUIRED',
        permissionState: 'REVIEW_REQUIRED',
        doNotContact: false,
      })
      const conversion = await db.publicInterestProspectConversion.findUniqueOrThrow({
        where: { submissionId: stored.id },
      })
      expect(conversion).toMatchObject({
        operationId: conversionOperationId,
        convertedBy: 'disposable-founder',
        organizationId: converted.organization.id,
        venueId: converted.venue.id,
        contactId: converted.contact.id,
      })
      const source = await db.prospectSourceEvidence.findFirstOrThrow({
        where: { organizationId: converted.organization.id },
      })
      expect(source).toMatchObject({
        sourceType: 'PUBLIC_INTEREST_SUBMISSION',
        sourceUrl: '/request-demo',
        createdBy: 'disposable-founder',
      })
      expect(source.capturedValue).toMatchObject({
        submissionId: stored.id,
        requestId,
        requestHash: stored.requestHash,
        cityRegion: request.cityRegion,
        message: request.message,
      })

      await expect(
        adminCaller.convertPublicInterestSubmissionToProspect({
          operationId: conversionOperationId,
          submissionId: stored.id,
          reason: 'Disposable canonical CRM conversion proof.',
        }),
      ).resolves.toMatchObject({ replayed: true })
      await expect(
        adminCaller.convertPublicInterestSubmissionToProspect({
          operationId: conversionOperationId,
          submissionId: stored.id,
          reason: 'Changed operation intent.',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(
        await db.prospectOrganization.count({ where: { id: converted.organization.id } }),
      ).toBe(1)

      const duplicateRequestId = randomUUID()
      await publicCaller.submit({ ...request, requestId: duplicateRequestId })
      const duplicateSubmission = await db.publicInterestSubmission.findUniqueOrThrow({
        where: { requestId: duplicateRequestId },
      })
      await expect(
        adminCaller.convertPublicInterestSubmissionToProspect({
          operationId: randomUUID(),
          submissionId: duplicateSubmission.id,
          reason: 'Duplicate should fail closed.',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(
        await db.publicInterestProspectConversion.count({
          where: { submissionId: duplicateSubmission.id },
        }),
      ).toBe(0)
      expect(
        await db.publicInterestSubmission.findUniqueOrThrow({
          where: { id: duplicateSubmission.id },
        }),
      ).toMatchObject({ status: 'NEW' })

      const concurrentRequestId = randomUUID()
      await publicCaller.submit({
        ...request,
        requestId: concurrentRequestId,
        organizationName: 'Concurrent Harbor Museum',
        workEmail: `concurrent-${concurrentRequestId}@example.test`,
        website: 'https://concurrent-harbor.example.test',
      })
      const concurrentSubmission = await db.publicInterestSubmission.findUniqueOrThrow({
        where: { requestId: concurrentRequestId },
      })
      const concurrentOperationId = randomUUID()
      const concurrentResults = await Promise.all([
        adminCaller.convertPublicInterestSubmissionToProspect({
          operationId: concurrentOperationId,
          submissionId: concurrentSubmission.id,
          reason: 'Concurrent exact replay proof.',
        }),
        adminCaller.convertPublicInterestSubmissionToProspect({
          operationId: concurrentOperationId,
          submissionId: concurrentSubmission.id,
          reason: 'Concurrent exact replay proof.',
        }),
      ])
      expect(concurrentResults.map((result) => result.replayed).sort()).toEqual([false, true])
      expect(
        await db.publicInterestProspectConversion.count({
          where: { submissionId: concurrentSubmission.id },
        }),
      ).toBe(1)

      await expect(
        db.publicInterestProspectConversion.update({
          where: { id: conversion.id },
          data: { convertedBy: 'mutated' },
        }),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.publicInterestProspectConversion.delete({ where: { id: conversion.id } }),
      ).rejects.toThrow(/append-only/u)

      await expect(externalEffectCounts()).resolves.toEqual(externalBefore)

      await expect(
        db.publicInterestSubmission.update({
          where: { id: stored.id },
          data: { organizationName: 'Mutated evidence' },
        }),
      ).rejects.toThrow(/evidence is immutable/u)
      const review = await db.publicInterestSubmissionReview.findFirstOrThrow({
        where: { submissionId: stored.id },
      })
      await expect(
        db.publicInterestSubmissionReview.update({
          where: { id: review.id },
          data: { reason: 'Mutated history' },
        }),
      ).rejects.toThrow(/append-only/u)
    },
  )
})
