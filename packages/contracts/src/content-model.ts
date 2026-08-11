import { z } from 'zod'

export const ContentModuleKind = z.enum([
  'PLACE',
  'ITEM',
  'KNOWLEDGE',
  'SERVICE',
  'POLICY',
  'EVENT',
  'OPERATIONAL_FACT',
  'RELATIONSHIP',
])
export type ContentModuleKind = z.infer<typeof ContentModuleKind>

export const ContentAudience = z.enum(['PUBLIC', 'CLIENT', 'OPERATOR'])
export type ContentAudience = z.infer<typeof ContentAudience>

export const ContentEvidenceReference = z
  .object({
    sourceId: z.string().min(1),
    locator: z.string().trim().min(1).max(2_000).optional(),
    capturedAt: z.string().datetime({ offset: true }),
    excerptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict()
export type ContentEvidenceReference = z.infer<typeof ContentEvidenceReference>

const moduleEnvelope = z.object({
  id: z.string().min(1),
  venueId: z.string().min(1),
  version: z.number().int().positive(),
  audience: ContentAudience,
  evidence: z.array(ContentEvidenceReference).max(100).default([]),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  effectiveUntil: z.string().datetime({ offset: true }).optional(),
})

export const PlaceModule = moduleEnvelope
  .extend({
    kind: z.literal('PLACE'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    parentPlaceId: z.string().min(1).optional(),
    accessibility: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict()

export const ItemModule = moduleEnvelope
  .extend({
    kind: z.literal('ITEM'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    placeId: z.string().min(1).optional(),
    itemType: z.string().trim().min(1).max(100),
  })
  .strict()

export const KnowledgeModule = moduleEnvelope
  .extend({
    kind: z.literal('KNOWLEDGE'),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(50_000),
    topics: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  })
  .strict()

export const ServiceModule = moduleEnvelope
  .extend({
    kind: z.literal('SERVICE'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    availability: z.string().trim().max(2_000).optional(),
    placeId: z.string().min(1).optional(),
  })
  .strict()

export const PolicyModule = moduleEnvelope
  .extend({
    kind: z.literal('POLICY'),
    title: z.string().trim().min(1).max(200),
    rule: z.string().trim().min(1).max(20_000),
    appliesTo: z.array(z.string().min(1)).max(100).default([]),
  })
  .strict()

export const EventModule = moduleEnvelope
  .extend({
    kind: z.literal('EVENT'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    placeId: z.string().min(1).optional(),
  })
  .strict()

export const OperationalFactModule = moduleEnvelope
  .extend({
    kind: z.literal('OPERATIONAL_FACT'),
    label: z.string().trim().min(1).max(200),
    value: z.string().trim().min(1).max(5_000),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()

export const RelationshipModule = moduleEnvelope
  .extend({
    kind: z.literal('RELATIONSHIP'),
    fromId: z.string().min(1),
    toId: z.string().min(1),
    relationshipType: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2_000).optional(),
  })
  .strict()
  .superRefine((relationship, context) => {
    if (relationship.fromId === relationship.toId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toId'],
        message: 'A relationship must connect two different records.',
      })
    }
  })

export const ContentModule = z.union([
  PlaceModule,
  ItemModule,
  KnowledgeModule,
  ServiceModule,
  PolicyModule,
  EventModule,
  OperationalFactModule,
  RelationshipModule,
])
export type ContentModule = z.infer<typeof ContentModule>

export function groupContentModules(
  modules: readonly ContentModule[],
): Record<ContentModuleKind, ContentModule[]> {
  const grouped: Record<ContentModuleKind, ContentModule[]> = {
    PLACE: [],
    ITEM: [],
    KNOWLEDGE: [],
    SERVICE: [],
    POLICY: [],
    EVENT: [],
    OPERATIONAL_FACT: [],
    RELATIONSHIP: [],
  }

  for (const module of modules) grouped[module.kind].push(module)
  return grouped
}
