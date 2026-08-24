import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AgentIdentityConfigurationFields,
  defaultIntakeNotesProposalPolicyConstraints,
  INTAKE_NOTES_PROPOSAL_POLICY_ACTION,
  INTAKE_NOTES_PROPOSAL_POLICY_CAPABILITY,
  defaultOperationalUpdateDraftPolicyConstraints,
  OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION,
  OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY,
  defaultSupportRequestDraftPolicyConstraints,
  SUPPORT_REQUEST_DRAFT_POLICY_ACTION,
  SUPPORT_REQUEST_DRAFT_POLICY_CAPABILITY,
} from '@pathfinder/contracts'
import {
  ApprovalGrantActionError,
  AgentIdentityConfigurationError,
  createDisabledAgentIdentity as createDisabledAgentIdentityAction,
  disableAgentIdentity as disableAgentIdentityAction,
  editDisabledAgentIdentity as editDisabledAgentIdentityAction,
  enableAgentIdentity as enableAgentIdentityAction,
  issueApprovalGrantAction,
  revokeApprovalGrantAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const agentIdentityScope = z.discriminatedUnion('level', [
  z.object({ level: z.literal('CLIENT'), tenantId: z.string().min(1) }).strict(),
  z
    .object({
      level: z.literal('VENUE'),
      tenantId: z.string().min(1),
      venueId: z.string().min(1),
    })
    .strict(),
])

function identityConfigurationError(error: unknown): never {
  if (error instanceof AgentIdentityConfigurationError) {
    const code =
      error.code === 'INVALID_INPUT'
        ? 'BAD_REQUEST'
        : error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

function approvalGrantError(error: unknown): never {
  if (error instanceof ApprovalGrantActionError) {
    const code =
      error.code === 'INVALID_INPUT'
        ? 'BAD_REQUEST'
        : error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT'
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

export const adminAgentIdentityConfigurationRouter = router({
  issueOperationalUpdateDraftPolicy: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentIdentityId: z.string().min(1),
          policyKey: z
            .string()
            .trim()
            .min(1)
            .max(191)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          issueReason: z.string().trim().min(3).max(2000),
          outcomeObservationIds: z.array(z.string().min(1).max(191)).min(1).max(25),
          maxTitleChars: z.number().int().min(1).max(160),
          maxBodyChars: z.number().int().min(1).max(4000),
          maxUses: z.number().int().min(1).optional(),
          expiresAt: z.coerce.date().optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await issueApprovalGrantAction({
            operationId: input.operationId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            actionName: OPERATIONAL_UPDATE_DRAFT_POLICY_ACTION,
            capability: OPERATIONAL_UPDATE_DRAFT_POLICY_CAPABILITY,
            mode: 'POLICY_BACKED',
            policyKey: input.policyKey,
            scope: {
              contractVersion: 1,
              tenantId: input.tenantId,
              venueId: input.venueId,
              effect: 'DRAFT_ONLY',
            },
            constraints: {
              ...defaultOperationalUpdateDraftPolicyConstraints(),
              maxTitleChars: input.maxTitleChars,
              maxBodyChars: input.maxBodyChars,
            },
            issueReason: input.issueReason,
            outcomeObservationIds: input.outcomeObservationIds,
            ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          approvalGrantError(error)
        }
      }),
    ),

  issueSupportRequestDraftPolicy: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentIdentityId: z.string().min(1),
          policyKey: z
            .string()
            .trim()
            .min(1)
            .max(191)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          issueReason: z.string().trim().min(3).max(2000),
          outcomeObservationIds: z.array(z.string().min(1).max(191)).min(1).max(25),
          maxSubjectChars: z.number().int().min(1).max(200),
          maxBodyChars: z.number().int().min(1).max(20_000),
          maxUses: z.number().int().min(1).optional(),
          expiresAt: z.coerce.date().optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await issueApprovalGrantAction({
            operationId: input.operationId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            actionName: SUPPORT_REQUEST_DRAFT_POLICY_ACTION,
            capability: SUPPORT_REQUEST_DRAFT_POLICY_CAPABILITY,
            mode: 'POLICY_BACKED',
            policyKey: input.policyKey,
            scope: {
              contractVersion: 1,
              tenantId: input.tenantId,
              venueId: input.venueId,
              effect: 'DRAFT_ONLY',
            },
            constraints: {
              ...defaultSupportRequestDraftPolicyConstraints(),
              maxSubjectChars: input.maxSubjectChars,
              maxBodyChars: input.maxBodyChars,
            },
            issueReason: input.issueReason,
            outcomeObservationIds: input.outcomeObservationIds,
            ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          approvalGrantError(error)
        }
      }),
    ),

  issueIntakeNotesProposalPolicy: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentIdentityId: z.string().min(1),
          policyKey: z
            .string()
            .trim()
            .min(1)
            .max(191)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          issueReason: z.string().trim().min(3).max(2000),
          outcomeObservationIds: z.array(z.string().min(1).max(191)).min(1).max(25),
          maxNotesChars: z.number().int().min(1).max(20_000),
          maxUses: z.number().int().min(1).optional(),
          expiresAt: z.coerce.date().optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await issueApprovalGrantAction({
            operationId: input.operationId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            actionName: INTAKE_NOTES_PROPOSAL_POLICY_ACTION,
            capability: INTAKE_NOTES_PROPOSAL_POLICY_CAPABILITY,
            mode: 'POLICY_BACKED',
            policyKey: input.policyKey,
            scope: {
              contractVersion: 1,
              tenantId: input.tenantId,
              venueId: input.venueId,
              effect: 'PROPOSAL_ONLY',
            },
            constraints: {
              ...defaultIntakeNotesProposalPolicyConstraints(),
              maxNotesChars: input.maxNotesChars,
            },
            issueReason: input.issueReason,
            outcomeObservationIds: input.outcomeObservationIds,
            ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          approvalGrantError(error)
        }
      }),
    ),

  revokeAgentApprovalPolicy: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          approvalGrantId: z.string().min(1),
          reason: z.string().trim().min(3).max(1000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await revokeApprovalGrantAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          approvalGrantError(error)
        }
      }),
    ),

  createDisabledAgentIdentity: adminProcedure
    .input(
      z.object({ scope: agentIdentityScope, fields: AgentIdentityConfigurationFields }).strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await createDisabledAgentIdentityAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          identityConfigurationError(error)
        }
      }),
    ),

  editDisabledAgentIdentity: adminProcedure
    .input(
      z
        .object({
          scope: agentIdentityScope,
          agentIdentityId: z.string().min(1),
          expectedUpdatedAt: z.coerce.date(),
          fields: AgentIdentityConfigurationFields,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await editDisabledAgentIdentityAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          identityConfigurationError(error)
        }
      }),
    ),

  disableAgentIdentity: adminProcedure
    .input(
      z
        .object({
          scope: agentIdentityScope,
          agentIdentityId: z.string().min(1),
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await disableAgentIdentityAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          identityConfigurationError(error)
        }
      }),
    ),

  enableAgentIdentity: adminProcedure
    .input(
      z
        .object({
          scope: agentIdentityScope,
          agentIdentityId: z.string().min(1),
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await enableAgentIdentityAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          identityConfigurationError(error)
        }
      }),
    ),
})
