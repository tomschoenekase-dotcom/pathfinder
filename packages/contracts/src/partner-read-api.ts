import { z } from 'zod'

export const PARTNER_READ_API_VERSION = 'v1' as const

const Identifier = z.string().trim().min(1).max(120)
const Cursor = z.string().trim().min(1).max(500)
const JsonValue: z.ZodType<PartnerJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValue),
    z.record(JsonValue),
  ]),
)

export type PartnerJsonValue =
  | null
  | boolean
  | number
  | string
  | PartnerJsonValue[]
  | { [key: string]: PartnerJsonValue }

export const PartnerReadCapability = z.enum([
  'clients:read',
  'venues:read',
  'approved-content:read',
  'configuration:read',
  'readiness:read',
  'updates:read',
])
export type PartnerReadCapability = z.infer<typeof PartnerReadCapability>

/** Server-created context from an already authenticated credential. Never accept this from input. */
export const PrevalidatedPartnerCredential = z
  .object({
    credentialId: Identifier,
    tenantId: Identifier,
    clientId: Identifier,
    venueIds: z.array(Identifier).max(500),
    capabilities: z.array(PartnerReadCapability).max(PartnerReadCapability.options.length),
  })
  .strict()
  .superRefine((credential, context) => {
    if (new Set(credential.venueIds).size !== credential.venueIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['venueIds'],
        message: 'Venue scope must be unique',
      })
    }
    if (new Set(credential.capabilities).size !== credential.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'Capabilities must be unique',
      })
    }
  })
export type PrevalidatedPartnerCredential = z.infer<typeof PrevalidatedPartnerCredential>

export const PartnerClientScopeInput = z.object({ clientId: Identifier }).strict()
export type PartnerClientScopeInput = z.infer<typeof PartnerClientScopeInput>
export const PartnerVenueScopeInput = PartnerClientScopeInput.extend({
  venueId: Identifier,
}).strict()
export type PartnerVenueScopeInput = z.infer<typeof PartnerVenueScopeInput>
const PageInput = z.object({
  cursor: Cursor.optional(),
  limit: z.number().int().min(1).max(100).default(25),
})

export const GetPartnerClientInput = PartnerClientScopeInput
export type GetPartnerClientInput = z.infer<typeof GetPartnerClientInput>
export const ListPartnerVenuesInput = PartnerClientScopeInput.merge(PageInput).strict()
export type ListPartnerVenuesInput = z.infer<typeof ListPartnerVenuesInput>
export const ListApprovedContentInput = PartnerVenueScopeInput.merge(PageInput).strict()
export type ListApprovedContentInput = z.infer<typeof ListApprovedContentInput>
export const GetPartnerConfigurationInput = PartnerVenueScopeInput
export type GetPartnerConfigurationInput = z.infer<typeof GetPartnerConfigurationInput>
export const GetPartnerReadinessInput = PartnerVenueScopeInput
export type GetPartnerReadinessInput = z.infer<typeof GetPartnerReadinessInput>
export const ListPartnerUpdatesInput = PartnerVenueScopeInput.merge(PageInput).strict()
export type ListPartnerUpdatesInput = z.infer<typeof ListPartnerUpdatesInput>

export const PartnerReadResult = z
  .object({
    data: JsonValue,
    nextCursor: Cursor.nullable().optional(),
    revision: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
export type PartnerReadResult = z.infer<typeof PartnerReadResult>

export type PartnerReadOperationName =
  | 'clients.get'
  | 'venues.list'
  | 'approved-content.list'
  | 'configuration.get'
  | 'readiness.get'
  | 'updates.list'

export type PartnerReadOperationDefinition = Readonly<{
  version: typeof PARTNER_READ_API_VERSION
  name: PartnerReadOperationName
  description: string
  scope: 'client' | 'venue'
  capability: PartnerReadCapability
  readOnly: true
  risk: 'low'
  public: false
}>

export const PARTNER_READ_OPERATIONS: readonly PartnerReadOperationDefinition[] = [
  {
    version: PARTNER_READ_API_VERSION,
    name: 'clients.get',
    description: 'Read the authorized client account.',
    scope: 'client',
    capability: 'clients:read',
    readOnly: true,
    risk: 'low',
    public: false,
  },
  {
    version: PARTNER_READ_API_VERSION,
    name: 'venues.list',
    description: 'List venues in the authorized client account.',
    scope: 'client',
    capability: 'venues:read',
    readOnly: true,
    risk: 'low',
    public: false,
  },
  {
    version: PARTNER_READ_API_VERSION,
    name: 'approved-content.list',
    description: 'List approved visitor-facing content for one authorized venue.',
    scope: 'venue',
    capability: 'approved-content:read',
    readOnly: true,
    risk: 'low',
    public: false,
  },
  {
    version: PARTNER_READ_API_VERSION,
    name: 'configuration.get',
    description: 'Read approved partner-safe configuration for one authorized venue.',
    scope: 'venue',
    capability: 'configuration:read',
    readOnly: true,
    risk: 'low',
    public: false,
  },
  {
    version: PARTNER_READ_API_VERSION,
    name: 'readiness.get',
    description: 'Read partner-safe readiness state for one authorized venue.',
    scope: 'venue',
    capability: 'readiness:read',
    readOnly: true,
    risk: 'low',
    public: false,
  },
  {
    version: PARTNER_READ_API_VERSION,
    name: 'updates.list',
    description: 'List published or scheduled partner-visible updates for one authorized venue.',
    scope: 'venue',
    capability: 'updates:read',
    readOnly: true,
    risk: 'low',
    public: false,
  },
]

export class PartnerScopeError extends Error {
  readonly code = 'PARTNER_SCOPE_DENIED'
}

export function assertPartnerReadScope(
  rawCredential: PrevalidatedPartnerCredential,
  rawInput: PartnerClientScopeInput & { venueId?: string | undefined },
  capability: PartnerReadCapability,
  scope: 'client' | 'venue',
): void {
  const credential = PrevalidatedPartnerCredential.parse(rawCredential)
  if (rawInput.clientId !== credential.clientId) throw new PartnerScopeError('Client scope denied')
  if (!credential.capabilities.includes(capability))
    throw new PartnerScopeError('Capability denied')
  if (scope === 'venue') {
    if (!rawInput.venueId) throw new PartnerScopeError('Venue scope is required')
    if (!credential.venueIds.includes(rawInput.venueId))
      throw new PartnerScopeError('Venue scope denied')
  }
}

export function validatePartnerReadCatalog(): void {
  const names = PARTNER_READ_OPERATIONS.map(({ name }) => name)
  if (new Set(names).size !== names.length)
    throw new Error('Partner API operation names must be unique')
  for (const operation of PARTNER_READ_OPERATIONS) {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(operation.name))
      throw new Error(`Invalid partner API operation name: ${operation.name}`)
    if (!operation.readOnly || operation.public)
      throw new Error(`Unsafe partner operation: ${operation.name}`)
  }
}
