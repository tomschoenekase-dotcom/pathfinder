import { z } from 'zod'

export const GUEST_GENERAL_WEB_TENANT_FLAG_KEY = 'guest-general-web-fallback-v1' as const
export const GUEST_GENERAL_WEB_MAX_RESULTS = 3 as const
export const GUEST_GENERAL_WEB_MAX_TOOL_CALLS = 1 as const

const PRIVATE_SUFFIXES = new Set([
  'local',
  'localhost',
  'internal',
  'test',
  'example',
  'invalid',
  'home',
  'lan',
])

function isNormalizedPublicDomain(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) return false
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      value,
    )
  )
    return false
  const labels = value.split('.')
  if (labels.length === 4 && labels.every((label) => /^\d+$/u.test(label))) return false
  return !PRIVATE_SUFFIXES.has(labels.at(-1)!)
}

const metadataSchema = z
  .object({
    venueIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
    allowedDomains: z
      .array(z.string().trim().min(1).max(253).refine(isNormalizedPublicDomain))
      .min(1)
      .max(20),
    modelKey: z.literal('guest-chat-openai'),
    maxOutputTokens: z.number().int().min(1).max(1024),
    timeoutMs: z.number().int().min(1).max(5000),
    requestBudgetCeilingE8Usd: z
      .string()
      .max(32)
      .regex(/^[1-9][0-9]*$/u),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.venueIds).size !== value.venueIds.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['venueIds'],
        message: 'Venue IDs must be unique.',
      })
    if (new Set(value.allowedDomains).size !== value.allowedDomains.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedDomains'],
        message: 'Allowed domains must be unique and normalized.',
      })
  })

const inputSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    globalEnabled: z.boolean().default(false),
  })
  .strict()

export type GuestGeneralWebConfigurationClient = {
  tenantFeatureFlag: {
    findUnique(input: {
      where: { tenantId_flagKey: { tenantId: string; flagKey: string } }
      select: { enabled: true; metadata: true }
    }): Promise<{ enabled: boolean; metadata: unknown } | null>
  }
}

export type GuestGeneralWebConfiguration = Readonly<{
  tenantId: string
  venueId: string
  allowedDomains: readonly string[]
  modelKey: 'guest-chat-openai'
  maxOutputTokens: number
  timeoutMs: number
  requestBudgetCeilingE8Usd: string
  maxResults: typeof GUEST_GENERAL_WEB_MAX_RESULTS
  maxToolCalls: typeof GUEST_GENERAL_WEB_MAX_TOOL_CALLS
}>

/**
 * Resolves only server-owned feature state. A null result grants no fallback,
 * and callers must re-check their global flag immediately before dispatch.
 * Domain checks are deliberately structural; a provider adapter must validate
 * its final requested destination again.
 */
export async function resolveGuestGeneralWebConfiguration(
  rawInput: unknown,
  client: GuestGeneralWebConfigurationClient,
): Promise<GuestGeneralWebConfiguration | null> {
  const input = inputSchema.safeParse(rawInput)
  if (!input.success || input.data.globalEnabled !== true) return null

  const flag = await client.tenantFeatureFlag.findUnique({
    where: {
      tenantId_flagKey: {
        tenantId: input.data.tenantId,
        flagKey: GUEST_GENERAL_WEB_TENANT_FLAG_KEY,
      },
    },
    select: { enabled: true, metadata: true },
  })
  if (!flag?.enabled) return null

  const metadata = metadataSchema.safeParse(flag.metadata)
  if (!metadata.success || !metadata.data.venueIds.includes(input.data.venueId)) return null

  return Object.freeze({
    tenantId: input.data.tenantId,
    venueId: input.data.venueId,
    allowedDomains: Object.freeze([...metadata.data.allowedDomains]),
    modelKey: metadata.data.modelKey,
    maxOutputTokens: metadata.data.maxOutputTokens,
    timeoutMs: metadata.data.timeoutMs,
    requestBudgetCeilingE8Usd: metadata.data.requestBudgetCeilingE8Usd,
    maxResults: GUEST_GENERAL_WEB_MAX_RESULTS,
    maxToolCalls: GUEST_GENERAL_WEB_MAX_TOOL_CALLS,
  })
}
