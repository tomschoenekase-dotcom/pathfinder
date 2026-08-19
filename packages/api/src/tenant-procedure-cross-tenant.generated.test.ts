import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  type Touch = { kind: 'db-touch' | 'external-touch'; path: string; args: unknown[] }
  const dbTouches: Touch[] = []
  const externalTouches: Touch[] = []
  function makeDbProxy(parts: string[]): unknown {
    return new Proxy(() => undefined, {
      get(_target, property) {
        if (property === 'then') return undefined
        return makeDbProxy([...parts, String(property)])
      },
      apply(_target, _thisArg, args: unknown[]) {
        if (parts.join('.') === '$transaction' && typeof args[0] === 'function') {
          return (args[0] as (tx: unknown) => unknown)(rootDb)
        }
        const touch: Touch = { kind: 'db-touch', path: parts.join('.'), args }
        dbTouches.push(touch)
        return Promise.reject(touch)
      },
    })
  }

  const rootDb = makeDbProxy([])

  const external = (path: string) =>
    vi.fn((...args: unknown[]) => {
      const touch: Touch = { kind: 'external-touch', path, args }
      externalTouches.push(touch)
      return Promise.reject(touch)
    })

  return {
    db: rootDb,
    dbTouches,
    externalTouches,
    inviteOrganizationMember: external('external.inviteOrganizationMember'),
    listPendingOrganizationInvitations: external('external.listPendingOrganizationInvitations'),
  }
})

type LegacyHarnessTx = {
  venue: { findFirst: (args: unknown) => unknown }
  venuePackage: { findFirst: (args: unknown) => unknown }
  place: { findFirst: (args: unknown) => unknown }
  venueKnowledgeEntry: { findFirst: (args: unknown) => unknown }
  engagementQuestion: {
    findFirst: (args: unknown) => unknown
    create: (args: unknown) => unknown
  }
}

type LegacyHarnessClient = {
  $transaction: (callback: (tx: LegacyHarnessTx) => unknown) => unknown
}

vi.mock('@pathfinder/db', async () => {
  const { z } = await import('zod')
  const intakeTouch = async (client: LegacyHarnessClient, args: unknown) => {
    try {
      return await (
        client as unknown as {
          intakeUpload: { findFirst: (args: unknown) => Promise<unknown> }
        }
      ).intakeUpload.findFirst(args)
    } catch (touch) {
      throw Object.assign(
        new Error('Recorded intake-upload database touch', { cause: touch }),
        touch,
      )
    }
  }
  return {
    IntakeUploadActionError: class IntakeUploadActionError extends Error {},
    reserveIntakeUploadAction: vi.fn(
      (input: { tenantId: string; venueId: string; client: LegacyHarnessClient }) =>
        intakeTouch(input.client, {
          where: { tenantId: input.tenantId, venueId: input.venueId },
        }),
    ),
    claimIntakeUploadVerificationAction: vi.fn(
      (input: {
        tenantId: string
        venueId: string
        uploadId: string
        client: LegacyHarnessClient
      }) =>
        intakeTouch(input.client, {
          where: { id: input.uploadId, tenantId: input.tenantId, venueId: input.venueId },
        }),
    ),
    getIntakeUploadMultipartAction: vi.fn(
      (input: {
        tenantId: string
        venueId: string
        uploadId: string
        client: LegacyHarnessClient
      }) =>
        intakeTouch(input.client, {
          where: { id: input.uploadId, tenantId: input.tenantId, venueId: input.venueId },
        }),
    ),
    listIntakeUploadsAction: vi.fn(
      (input: { tenantId: string; venueId: string; client: LegacyHarnessClient }) =>
        (
          input.client as unknown as {
            venue: { findFirst: (args: unknown) => unknown }
          }
        ).venue.findFirst({ where: { tenantId: input.tenantId, id: input.venueId } }),
    ),
    onboardingBootstrapSubmissionInput: z
      .object({
        requestId: z.string().uuid(),
        venue: z.object({
          name: z.string(),
          slug: z.string(),
          guideMode: z.enum(['location_aware', 'non_location']),
        }),
        rawContent: z.object({ kind: z.string(), value: z.record(z.string(), z.unknown()) }),
      })
      .passthrough(),
    OnboardingBootstrapError: class OnboardingBootstrapError extends Error {},
    submitOnboardingBootstrapAction: vi.fn(
      (input: { tenantId: string; client: LegacyHarnessClient }) =>
        input.client.$transaction((tx) =>
          (
            tx as unknown as {
              intakeRun: { findFirst: (args: unknown) => unknown }
            }
          ).intakeRun.findFirst({ where: { tenantId: input.tenantId } }),
        ),
    ),
    getOnboardingBootstrapSubmission: vi.fn(
      (input: { tenantId: string; requestId: string; client: LegacyHarnessClient }) =>
        input.client.$transaction((tx) =>
          (
            tx as unknown as {
              intakeRun: { findFirst: (args: unknown) => unknown }
            }
          ).intakeRun.findFirst({
            where: { tenantId: input.tenantId, submissionRequestId: input.requestId },
          }),
        ),
    ),
    contentHistoryVersionSelect: { id: true, tenantId: true },
    ContentHistoryActionError: class ContentHistoryActionError extends Error {},
    revertContentHistoryAction: vi.fn(
      (input: { tenantId: string; versionId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          (
            tx as unknown as {
              contentVersion: { findFirst: (args: unknown) => unknown }
            }
          ).contentVersion.findFirst({
            where: { id: input.versionId, tenantId: input.tenantId },
          }),
        ),
    ),
    TenantSettingsActionError: class TenantSettingsActionError extends Error {},
    setTenantEngagementModeAction: vi.fn((input: { tenantId: string; db: LegacyHarnessClient }) =>
      input.db.$transaction((tx) =>
        (tx as unknown as { tenant: { findUnique: (args: unknown) => unknown } }).tenant.findUnique(
          { where: { id: input.tenantId } },
        ),
      ),
    ),
    engagementQuestionSelect: { id: true, tenantId: true },
    EngagementQuestionActionError: class EngagementQuestionActionError extends Error {},
    createEngagementQuestionAction: vi.fn((input: { tenantId: string; db: LegacyHarnessClient }) =>
      input.db.$transaction((tx) =>
        tx.engagementQuestion.create({ data: { tenantId: input.tenantId } }),
      ),
    ),
    updateEngagementQuestionAction: vi.fn(
      (input: { tenantId: string; questionId: string; db: LegacyHarnessClient }) =>
        input.db.$transaction((tx) =>
          tx.engagementQuestion.findFirst({
            where: { id: input.questionId, tenantId: input.tenantId },
          }),
        ),
    ),
    deleteEngagementQuestionAction: vi.fn(
      (input: { tenantId: string; questionId: string; db: LegacyHarnessClient }) =>
        input.db.$transaction((tx) =>
          tx.engagementQuestion.findFirst({
            where: { id: input.questionId, tenantId: input.tenantId },
          }),
        ),
    ),
    VenuePackageLifecycleError: class VenuePackageLifecycleError extends Error {},
    approveVenuePackageAction: vi.fn(
      (input: { tenantId: string; packageId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venuePackage.findFirst({
            where: { id: input.packageId, tenantId: input.tenantId },
          }),
        ),
    ),
    applyVenuePackageAction: vi.fn(
      (input: { tenantId: string; packageId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venuePackage.findFirst({
            where: { id: input.packageId, tenantId: input.tenantId },
          }),
        ),
    ),
    revertVenuePackageAction: vi.fn(
      (input: { tenantId: string; packageId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venuePackage.findFirst({
            where: { id: input.packageId, tenantId: input.tenantId },
          }),
        ),
    ),
    VenueActionError: class VenueActionError extends Error {},
    setVenueAvailabilityAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    createVenueAction: vi.fn(
      (input: { tenantId: string; baseSlug: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { tenantId: input.tenantId, slug: input.baseSlug } }),
        ),
    ),
    updateVenueAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    updateVenueAiConfigAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    getVenueBotConfigurationAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        (
          client as unknown as {
            venueBotConfiguration: { findFirst: (args: unknown) => unknown }
          }
        ).venueBotConfiguration.findFirst({
          where: { tenantId: input.tenantId, venueId: input.venueId },
        }),
    ),
    updateVenueBotConfigurationAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          (
            tx as unknown as {
              venueBotConfiguration: { findFirst: (args: unknown) => unknown }
            }
          ).venueBotConfiguration.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    listPersonalityProfilesAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        (
          client as unknown as {
            personalityProfile: { findMany: (args: unknown) => unknown }
          }
        ).personalityProfile.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
        }),
    ),
    createPersonalityProfileAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          (
            tx as unknown as {
              personalityProfile: { create: (args: unknown) => unknown }
            }
          ).personalityProfile.create({
            data: { tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    updatePersonalityProfileAction: vi.fn(
      (
        input: { tenantId: string; venueId: string; profileId: string },
        client: LegacyHarnessClient,
      ) =>
        client.$transaction((tx) =>
          (
            tx as unknown as {
              personalityProfile: { findFirst: (args: unknown) => unknown }
            }
          ).personalityProfile.findFirst({
            where: {
              id: input.profileId,
              tenantId: input.tenantId,
              venueId: input.venueId,
            },
          }),
        ),
    ),
    updateVenueChatDesignAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    deleteVenueAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    LegacyContentActionError: class LegacyContentActionError extends Error {},
    createLegacyPlaceAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    bulkCreateLegacyPlacesAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    updateLegacyPlaceAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.place.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    retireLegacyPlaceAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.place.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    createLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    bulkCreateLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
        ),
    ),
    updateLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venueKnowledgeEntry.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    retireLegacyKnowledgeAction: vi.fn(
      (input: { tenantId: string; venueId: string; id: string }, client: LegacyHarnessClient) =>
        client.$transaction((tx) =>
          tx.venueKnowledgeEntry.findFirst({
            where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    OperationalUpdateActionError: class OperationalUpdateActionError extends Error {},
    operationalUpdateActionSelect: { id: true },
    createOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; fields: { venueId: string } },
        client: {
          $transaction: (
            callback: (tx: { venue: { findFirst: (args: unknown) => unknown } }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({
            where: { id: input.fields.venueId, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    updateOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; id: string },
        client: {
          $transaction: (
            callback: (tx: {
              operationalUpdate: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.operationalUpdate.findFirst({
            where: { id: input.id, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    scheduleOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; id: string },
        client: {
          $transaction: (
            callback: (tx: {
              operationalUpdate: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.operationalUpdate.findFirst({
            where: { id: input.id, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    expireOperationalUpdateAction: vi.fn(
      (
        input: { tenantId: string; id: string },
        client: {
          $transaction: (
            callback: (tx: {
              operationalUpdate: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.operationalUpdate.findFirst({
            where: { id: input.id, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    IntakeActionError: class IntakeActionError extends Error {},
    websiteProposalInput: z
      .object({
        kind: z.literal('WEBSITE'),
        displayName: z.string(),
        websiteUri: z.string().url(),
      })
      .strict(),
    interviewProposalInput: z
      .object({ kind: z.literal('INTERVIEW'), displayName: z.string(), submission: z.unknown() })
      .strict(),
    createIntakeProposal: vi.fn(
      (input: { db: typeof harness.db; tenantId: string; venueId: string }) =>
        (input.db as { venue: { findFirst: (args: unknown) => unknown } }).venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        }),
    ),
    listIntakeProposals: vi.fn(
      (input: { db: typeof harness.db; tenantId: string; venueId: string }) =>
        (input.db as { venue: { findFirst: (args: unknown) => unknown } }).venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        }),
    ),
    getIntakeProposalReview: vi.fn(
      (input: { db: typeof harness.db; tenantId: string; venueId: string }) =>
        (input.db as { venue: { findFirst: (args: unknown) => unknown } }).venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        }),
    ),
    SupportActionError: class SupportActionError extends Error {},
    ClientAssistantActionError: class ClientAssistantActionError extends Error {},
    OnboardingQuestionActionError: class OnboardingQuestionActionError extends Error {},
    tenantSupportRequestAccessWhere: vi.fn((actor: { actorId: string }) => ({
      createdByKind: 'CLIENT',
      requesterUserId: actor.actorId,
    })),
    canTenantActorAccessSupportRequest: vi.fn(() => true),
    appendSupportMessageAction: vi.fn(
      (
        input: { requestId: string; tenantId: string; venueId: string },
        client: {
          $transaction: (
            callback: (tx: {
              supportRequest: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.supportRequest.findFirst({
            where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
            select: { id: true, status: true, version: true },
          }),
        ),
    ),
    respondToSupportInformationAction: vi.fn(
      (
        input: { requestId: string; tenantId: string; venueId: string },
        client: {
          $transaction: (
            callback: (tx: {
              supportRequest: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.supportRequest.findFirst({
            where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
            select: { id: true, status: true, version: true },
          }),
        ),
    ),
    resumeOnboardingQuestionFromSupportAction: vi.fn(),
    setClientAssistantPreferenceAction: vi.fn(),
    reserveClientAssistantTurnAction: vi.fn(),
    claimClientAssistantTurnGenerationAction: vi.fn(),
    markClientAssistantTurnProviderDispatchedAction: vi.fn(),
    completeClientAssistantTurnAction: vi.fn(),
    linkClientAssistantSupportHandoffAction: vi.fn(),
    assertVenueAiAvailable: vi.fn(),
    assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
    createSupportRequestAction: vi.fn(
      (
        input: { tenantId: string; venueId: string },
        client: {
          $transaction: (
            callback: (tx: { venue: { findFirst: (args: unknown) => unknown } }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true },
          }),
        ),
    ),
    grantSupportRequestParticipantAction: vi.fn(
      (
        input: { requestId: string; tenantId: string; venueId: string },
        client: LegacyHarnessClient,
      ) =>
        client.$transaction((tx) =>
          (
            tx as unknown as {
              supportRequest: { findFirst: (args: unknown) => unknown }
            }
          ).supportRequest.findFirst({
            where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    revokeSupportRequestParticipantAction: vi.fn(
      (
        input: { requestId: string; tenantId: string; venueId: string },
        client: LegacyHarnessClient,
      ) =>
        client.$transaction((tx) =>
          (
            tx as unknown as {
              supportRequest: { findFirst: (args: unknown) => unknown }
            }
          ).supportRequest.findFirst({
            where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    createPreviewFeedbackRequestAction: vi.fn(
      (
        input: { tenantId: string; venueId: string },
        _options: unknown,
        client: {
          $transaction: (
            callback: (tx: {
              supportMessage: { findFirst: (args: unknown) => unknown }
            }) => unknown,
          ) => unknown
        },
      ) =>
        client.$transaction((tx) =>
          tx.supportMessage.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
          }),
        ),
    ),
    db: harness.db,
    lockContentVersionEntity: vi.fn().mockResolvedValue(undefined),
    lockOperationalUpdateCapacity: vi.fn().mockResolvedValue(undefined),
    lockVenueContentMutation: vi.fn().mockResolvedValue(undefined),
    setContentVersionContext: vi.fn().mockResolvedValue(undefined),
    writeAuditLog: vi.fn(),
    writeAuditLogStrict: vi.fn(),
  }
})

vi.mock('@pathfinder/jobs', () => ({
  enqueueAgentRun: vi.fn(),
  enqueueEmbedKnowledgeEntry: vi.fn(),
  enqueueEmbedPlace: vi.fn(),
}))

vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn() }))

vi.mock('@pathfinder/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/config')>()),
  isFeatureEnabled: vi.fn(() => true),
}))

vi.mock('@pathfinder/config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return {
    ...actual,
    inviteOrganizationMember: harness.inviteOrganizationMember,
    listPendingOrganizationInvitations: harness.listPendingOrganizationInvitations,
  }
})

import type { TenantRole } from '@pathfinder/auth'
import { router } from './core'
import type { TRPCContext } from './context'
import { analyticsRouter } from './routers/analytics'
import { clientAssistantRouter } from './routers/client-assistant'
import { contentHistoryRouter } from './routers/content-history'
import { engagementQuestionRouter } from './routers/engagement-question'
import { intakeRouter } from './routers/intake'
import { intakeUploadRouter } from './routers/intake-upload'
import { knowledgeRouter } from './routers/knowledge'
import { operationalUpdateRouter } from './routers/operational-update'
import { placeRouter } from './routers/place'
import { portalRouter } from './routers/portal'
import { supportRouter } from './routers/support'
import { tenantRouter } from './routers/tenant'
import { venueRouter } from './routers/venue'
import {
  venuePackageCreateRouter,
  venuePackageLifecycleRouter,
  venuePackageReadRouter,
} from './routers/venue-package'
import cases from './testing/tenant-procedure-cases.json'

const ATTACKER_TENANT_ID = 'tenant_attacker'

const testRouter = router({
  analytics: analyticsRouter,
  clientAssistant: clientAssistantRouter,
  contentHistory: contentHistoryRouter,
  engagementQuestion: engagementQuestionRouter,
  intake: intakeRouter,
  intakeUpload: intakeUploadRouter,
  knowledge: knowledgeRouter,
  operationalUpdate: operationalUpdateRouter,
  place: placeRouter,
  portal: portalRouter,
  support: supportRouter,
  tenant: tenantRouter,
  venue: venueRouter,
  venuePackageCreate: venuePackageCreateRouter,
  venuePackageLifecycle: venuePackageLifecycleRouter,
  venuePackageRead: venuePackageReadRouter,
})

type ProcedureCase = {
  path: string
  kind: 'query' | 'mutation'
  minimumRole: TenantRole
  firstTouch: string
  input: unknown
}

function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$futureMinutes === 'number') {
      return new Date(Date.now() + record.$futureMinutes * 60_000)
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, materialize(item)]))
  }
  return value
}

function authoritativeTenant(touch: {
  kind: 'db-touch' | 'external-touch'
  path: string
  args: unknown[]
}): unknown {
  if (touch.path === 'external.inviteOrganizationMember') {
    return (touch.args[0] as { organizationId?: unknown } | undefined)?.organizationId
  }
  if (touch.path === 'external.listPendingOrganizationInvitations') return touch.args[0]

  const operation = touch.args[0] as
    | {
        where?: {
          id?: unknown
          tenantId?: unknown
          tenantId_flagKey?: { tenantId?: unknown }
        }
        data?: { tenantId?: unknown }
      }
    | undefined
  if (touch.path.startsWith('tenant.')) return operation?.where?.id
  return (
    operation?.where?.tenantId ??
    operation?.where?.tenantId_flagKey?.tenantId ??
    operation?.data?.tenantId
  )
}

function context(role: TenantRole): TRPCContext {
  return {
    db: harness.db as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'attacker_user',
      activeTenantId: ATTACKER_TENANT_ID,
      role,
      isPlatformAdmin: false,
    },
  }
}

function clearTouches() {
  harness.dbTouches.length = 0
  harness.externalTouches.length = 0
}

async function invoke(entry: ProcedureCase, role: TenantRole): Promise<unknown> {
  const [routerName, procedureName] = entry.path.split('.')
  if (!routerName || !procedureName) throw new Error(`Malformed procedure path: ${entry.path}`)

  const caller = testRouter.createCaller(context(role)) as unknown as Record<
    string,
    Record<string, (input?: unknown) => Promise<unknown>>
  >
  const procedure = caller[routerName]?.[procedureName]
  if (!procedure) throw new Error(`Procedure is not callable: ${entry.path}`)
  const input = materialize(entry.input)
  return entry.input === null ? procedure() : procedure(input)
}

describe('generated tenant-procedure cross-tenant boundary', () => {
  beforeEach(() => {
    clearTouches()
    vi.clearAllMocks()
  })

  it.each(cases as ProcedureCase[])(
    '$path reaches only attacker-scoped boundaries',
    async (entry) => {
      const belowMinimumRole =
        entry.minimumRole === 'OWNER' ? 'MANAGER' : entry.minimumRole === 'MANAGER' ? 'STAFF' : null
      if (belowMinimumRole) {
        await expect(invoke(entry, belowMinimumRole)).rejects.toMatchObject({ code: 'FORBIDDEN' })
        expect(harness.dbTouches).toHaveLength(0)
        expect(harness.externalTouches).toHaveLength(0)
        clearTouches()
      }

      let thrown: unknown
      try {
        await invoke(entry, entry.minimumRole)
      } catch (error) {
        thrown = error
      }

      const expectedKind = entry.firstTouch.startsWith('external.') ? 'external-touch' : 'db-touch'
      expect((thrown as { cause?: unknown } | undefined)?.cause).toMatchObject({
        kind: expectedKind,
      })

      const touches = expectedKind === 'db-touch' ? harness.dbTouches : harness.externalTouches
      const unexpectedTouches =
        expectedKind === 'db-touch' ? harness.externalTouches : harness.dbTouches
      expect(touches.map((touch) => touch.path)).toContain(entry.firstTouch)
      expect(touches.length).toBeGreaterThan(0)
      expect(unexpectedTouches).toHaveLength(0)
      for (const touch of touches) {
        expect(authoritativeTenant(touch), touch.path).toBe(ATTACKER_TENANT_ID)
      }
    },
  )
})
