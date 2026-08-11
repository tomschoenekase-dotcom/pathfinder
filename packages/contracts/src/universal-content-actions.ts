import { z } from 'zod'

import { ContentAudience, ContentEvidenceReference } from './content-model'

export const GeneralizedContentKind = z.enum([
  'SERVICE',
  'POLICY',
  'EVENT',
  'OPERATIONAL_FACT',
  'RELATIONSHIP',
])
export type GeneralizedContentKind = z.infer<typeof GeneralizedContentKind>

const optionalText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable().optional()

export const ServiceContentDraft = z
  .object({
    kind: z.literal('SERVICE'),
    name: z.string().trim().min(1).max(200),
    description: optionalText(10_000),
    availability: optionalText(2_000),
    placeId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()

export const PolicyContentDraft = z
  .object({
    kind: z.literal('POLICY'),
    title: z.string().trim().min(1).max(200),
    rule: z.string().trim().min(1).max(20_000),
    appliesTo: z.array(z.string().trim().min(1).max(191)).max(100).default([]),
  })
  .strict()

export const EventContentDraft = z
  .object({
    kind: z.literal('EVENT'),
    name: z.string().trim().min(1).max(200),
    description: optionalText(10_000),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    placeId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Event end must be after its start.',
      })
    }
  })

export const OperationalFactContentDraft = z
  .object({
    kind: z.literal('OPERATIONAL_FACT'),
    label: z.string().trim().min(1).max(200),
    value: z.string().trim().min(1).max(5_000),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()

export const RelationshipContentDraft = z
  .object({
    kind: z.literal('RELATIONSHIP'),
    fromModuleId: z.string().trim().min(1),
    toModuleId: z.string().trim().min(1),
    relationshipType: z.string().trim().min(1).max(100),
    description: optionalText(2_000),
  })
  .strict()
  .refine((value) => value.fromModuleId !== value.toModuleId, {
    path: ['toModuleId'],
    message: 'A relationship must connect two different modules.',
  })

export const GeneralizedContentPayload = z.union([
  ServiceContentDraft,
  PolicyContentDraft,
  EventContentDraft,
  OperationalFactContentDraft,
  RelationshipContentDraft,
])
export type GeneralizedContentPayload = z.infer<typeof GeneralizedContentPayload>

export const GeneralizedContentRevisionDraft = z
  .object({
    audience: ContentAudience,
    effectiveFrom: z.string().datetime({ offset: true }).nullable().optional(),
    effectiveUntil: z.string().datetime({ offset: true }).nullable().optional(),
    evidence: z.array(ContentEvidenceReference).max(100).default([]),
    payload: GeneralizedContentPayload,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.effectiveFrom &&
      value.effectiveUntil &&
      Date.parse(value.effectiveUntil) <= Date.parse(value.effectiveFrom)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'Effective end must be after effective start.',
      })
    }
    const evidenceIdentities = new Set<string>()
    value.evidence.forEach((evidence, index) => {
      const identity = JSON.stringify([evidence.sourceId, evidence.locator ?? null])
      if (evidenceIdentities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index],
          message: 'Evidence references must be unique by source and locator.',
        })
      }
      evidenceIdentities.add(identity)
    })
  })
export type GeneralizedContentRevisionDraft = z.infer<typeof GeneralizedContentRevisionDraft>

export const CreateGeneralizedContentInput = z
  .object({
    tenantId: z.string().trim().min(1),
    venueId: z.string().trim().min(1),
    moduleId: z.string().uuid(),
    draft: GeneralizedContentRevisionDraft,
  })
  .strict()

export const AddGeneralizedContentRevisionInput = z
  .object({
    tenantId: z.string().trim().min(1),
    venueId: z.string().trim().min(1),
    moduleId: z.string().trim().min(1),
    expectedLatestVersion: z.number().int().positive(),
    draft: GeneralizedContentRevisionDraft,
  })
  .strict()

export const RetireGeneralizedContentInput = z
  .object({
    tenantId: z.string().trim().min(1),
    venueId: z.string().trim().min(1),
    moduleId: z.string().trim().min(1),
    expectedLatestVersion: z.number().int().positive(),
    effectiveUntil: z.string().datetime({ offset: true }),
    evidence: z.array(ContentEvidenceReference).max(100).default([]),
  })
  .strict()
