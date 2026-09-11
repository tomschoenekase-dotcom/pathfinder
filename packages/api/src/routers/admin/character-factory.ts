import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { FACTORY_STATES } from '@pathfinder/character-factory'
import {
  cancelCharacterFactoryJobAction,
  claimCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  CustomCharacterFactoryActionError,
  failCharacterFactoryJobAction,
  heartbeatCharacterFactoryJobAction,
  prepareCharacterFactoryJobAction,
  readCustomCharacterFactoryAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { createCharacterArtifactStorage } from '../../lib/character-artifact-storage'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = { tenantId: z.string().min(1), venueId: z.string().min(1) }
const source = z
  .object({
    kind: z.literal('imported'),
    sourceUrl: z.string().url(),
    sourceRevision: z.string().min(1).max(200),
    license: z.string().min(1).max(100),
    attribution: z.string().min(1).max(500),
    importedAt: z.string().datetime(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.enum(['image/svg+xml', 'image/png']),
    byteLength: z.number().int().positive().max(2_000_000),
  })
  .strict()
const rigFamily = z.union([
  z.enum(['morph-v1', 'compact-creature-v1', 'humanoid-v1']),
  z.string().regex(/^custom:[a-z0-9][a-z0-9-]{2,80}$/u),
])
const rigCapabilities = z
  .object({
    schemaVersion: z.literal(1),
    familyId: rigFamily,
    anatomyClass: z.enum(['creature', 'humanoid', 'morph', 'object', 'custom']),
    requiredSlots: z
      .array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/u))
      .min(1)
      .max(32),
    stateControls: z.record(
      z.enum(FACTORY_STATES),
      z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/u)).max(16),
    ),
  })
  .strict()
const spec = z
  .object({
    schemaVersion: z.literal(1),
    characterId: z.string().min(1).max(191),
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(120),
    rigFamily,
    rigCapabilities: rigCapabilities.optional(),
    source,
    masterReference: z.string().min(1).max(500),
    protectedTraits: z.array(z.string().trim().min(1).max(200)).max(40),
    slotMap: z.record(z.string().min(1).max(500)),
    supportedStates: z.array(z.enum(FACTORY_STATES)).min(1),
    status: z.enum([
      'requested',
      'generating',
      'candidate',
      'invalid',
      'exported',
      'active',
      'archived',
    ]),
  })
  .strict()
const requestId = z.string().trim().min(1).max(191)
const leaseToken = z.string().uuid()
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(2_000_000),
    z.array(jsonValue).max(500),
    z.record(jsonValue),
  ]),
)
const jsonObject = z.record(jsonValue)

function translate(error: unknown): never {
  if (error instanceof CustomCharacterFactoryActionError) {
    throw new TRPCError({
      code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
      message: error.message,
    })
  }
  throw error
}

export const adminCharacterFactoryRouter = router({
  prepareCharacterFactoryJob: adminProcedure
    .input(
      z
        .object({
          ...scope,
          requestId,
          action: z.enum([
            'CREATE_FROM_IMPORT',
            'REVISE',
            'INSPECT',
            'PREVIEW',
            'VALIDATE',
            'EXPORT',
          ]),
          requestPayload: jsonObject,
          characterId: z.string().min(1).max(191).optional(),
          baseVersion: z.number().int().positive().optional(),
          baseRevision: z.number().int().positive().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          prepareCharacterFactoryJobAction({
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestId: input.requestId,
            action: input.action,
            requestPayload: input.requestPayload,
            actor: { id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            ...(input.characterId === undefined ? {} : { characterId: input.characterId }),
            ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
            ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
          }),
        )
      } catch (error) {
        return translate(error)
      }
    }),

  claimCharacterFactoryJob: adminProcedure
    .input(z.object({ ...scope, requestId }).strict())
    .mutation(async ({ input }) => {
      try {
        return await withTenantIsolationBypass(() => claimCharacterFactoryJobAction(input))
      } catch (error) {
        return translate(error)
      }
    }),

  heartbeatCharacterFactoryJob: adminProcedure
    .input(z.object({ ...scope, requestId, leaseToken }).strict())
    .mutation(async ({ input }) => {
      try {
        await withTenantIsolationBypass(() => heartbeatCharacterFactoryJobAction(input))
        return { ok: true }
      } catch (error) {
        return translate(error)
      }
    }),

  cancelCharacterFactoryJob: adminProcedure
    .input(z.object({ ...scope, requestId }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          cancelCharacterFactoryJobAction({
            ...input,
            actor: { id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
      } catch (error) {
        return translate(error)
      }
    }),

  completeCharacterFactoryJob: adminProcedure
    .input(
      z
        .object({
          ...scope,
          requestId,
          leaseToken,
          resultPayload: jsonObject,
          characterSpec: spec.optional(),
          assetStorageReference: jsonObject.optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          completeCharacterFactoryJobAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              requestId: input.requestId,
              leaseToken: input.leaseToken,
              resultPayload: input.resultPayload,
              actor: { id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
              ...(input.characterSpec === undefined ? {} : { characterSpec: input.characterSpec }),
              ...(input.assetStorageReference === undefined
                ? {}
                : { assetStorageReference: input.assetStorageReference }),
            },
            undefined,
            {
              verifyArtifact: async ({ tenantId, venueId, reference, expectedSpec }) => {
                const verified = await createCharacterArtifactStorage().getVerified({
                  tenantId,
                  venueId,
                  reference,
                  expectedSpec,
                })
                return { reference: verified.reference, spec: verified.spec }
              },
            },
          ),
        )
      } catch (error) {
        return translate(error)
      }
    }),

  failCharacterFactoryJob: adminProcedure
    .input(
      z
        .object({
          ...scope,
          requestId,
          leaseToken,
          errorCode: z.string().trim().min(1).max(100),
          errorMessage: z.string().trim().min(1).max(1000),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          failCharacterFactoryJobAction({
            ...input,
            actor: { id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
        return { ok: true }
      } catch (error) {
        return translate(error)
      }
    }),

  inspectCustomCharacter: adminProcedure
    .input(z.object({ ...scope, characterId: z.string().min(1).max(191) }).strict())
    .query(async ({ input }) => {
      try {
        return await withTenantIsolationBypass(() => readCustomCharacterFactoryAction(input))
      } catch (error) {
        return translate(error)
      }
    }),
})
