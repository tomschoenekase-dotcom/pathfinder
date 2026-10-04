import { z } from 'zod'

import { checkLiveDataEndpoint } from './live-data'
import { isValidIanaTimeZone } from './operational-update-lifecycle'

export const SOURCE_CONNECTION_PROVIDER = 'source_connection_v1' as const
export const SOURCE_CONNECTION_VERSION = 1 as const

export const SOURCE_CONNECTION_LIMITS = {
  maxAllowedUrls: 8,
  maxBodyBytes: 1_000_000,
  maxRecords: 100,
  maxRedirects: 2,
  maxAttempts: 2,
  deadlineMs: 20_000,
  maxTextLength: 2_000,
  maxShowtimes: 24,
  maxExceptions: 31,
  maxMappings: 8,
  maxUrlLength: 2_000,
} as const

export const SourceConnectionKindSchema = z.enum(['description', 'showtime', 'closure', 'event'])
export type SourceConnectionKind = z.infer<typeof SourceConnectionKindSchema>

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const instant = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value
  }, 'Invalid calendar date')
const isoInstant = z.string().datetime({ offset: true })
const selector = z
  .string()
  .trim()
  .min(1)
  .max(100)
  // Up to three simple descendant tokens. No pseudo classes, combinators, attributes or wildcards.
  .regex(
    /^[a-z][a-z0-9-]*(?:[.#][a-z][a-z0-9_-]*)?(?: [a-z][a-z0-9-]*(?:[.#][a-z][a-z0-9_-]*)?){0,2}$/u,
  )
const jsonPointer = z
  .string()
  .max(160)
  .regex(/^(?:\/(?:[^~/]|~[01])*){1,6}$/u)

export const SourceConnectionHtmlFieldSchema = z
  .object({
    selector,
    attribute: z.enum(['text', 'datetime', 'content', 'href']).default('text'),
  })
  .strict()

const dateFormat = z.enum(['iso', 'english_month_day_year', 'english_month_day'])

export const SourceConnectionHtmlMappingSchema = z
  .object({
    type: z.literal('html'),
    kind: SourceConnectionKindSchema,
    recordSelector: selector,
    id: SourceConnectionHtmlFieldSchema,
    title: SourceConnectionHtmlFieldSchema,
    text: SourceConnectionHtmlFieldSchema,
    pageDate: SourceConnectionHtmlFieldSchema.optional(),
    startDate: SourceConnectionHtmlFieldSchema.optional(),
    endDate: SourceConnectionHtmlFieldSchema.optional(),
    showtime: SourceConnectionHtmlFieldSchema.optional(),
    showtimeEnd: SourceConnectionHtmlFieldSchema.optional(),
    allowCrossMidnight: z.boolean().default(false),
    cancelled: SourceConnectionHtmlFieldSchema.optional(),
    link: SourceConnectionHtmlFieldSchema.optional(),
    dateFormat,
    // An explicitly approved boundary for a season-long notice. No inferred year end.
    fixedEndDate: isoDate.optional(),
  })
  .strict()

export const SourceConnectionJsonMappingSchema = z
  .object({
    type: z.literal('json_feed'),
    kind: SourceConnectionKindSchema,
    itemsPointer: jsonPointer,
    idPointer: jsonPointer,
    titlePointer: jsonPointer,
    textPointer: jsonPointer,
    startDatePointer: jsonPointer.optional(),
    endDatePointer: jsonPointer.optional(),
    showtimesPointer: jsonPointer.optional(),
    showtimeEndsPointer: jsonPointer.optional(),
    cancelledPointer: jsonPointer.optional(),
    exceptionsPointer: jsonPointer.optional(),
    linksPointer: jsonPointer.optional(),
    dateFormat,
    fixedEndDate: isoDate.optional(),
  })
  .strict()

export const SourceConnectionMappingSchema = z.discriminatedUnion('type', [
  SourceConnectionHtmlMappingSchema,
  SourceConnectionJsonMappingSchema,
])
export type SourceConnectionMapping = z.infer<typeof SourceConnectionMappingSchema>

export const SourceConnectionApprovalSchema = z
  .object({
    approvedConfigHash: z.string().regex(/^[a-f0-9]{64}$/u),
    approvedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
    approvedAt: isoInstant,
    approvedBy: z.string().min(1).max(191),
  })
  .strict()

export const SourceConnectionConfigSchema = z
  .object({
    version: z.literal(SOURCE_CONNECTION_VERSION),
    sourceUrl: z.string().max(SOURCE_CONNECTION_LIMITS.maxUrlLength),
    // Exact fully qualified URLs, including paths. Every redirect must be listed here.
    allowedUrls: z
      .array(z.string().max(SOURCE_CONNECTION_LIMITS.maxUrlLength))
      .min(1)
      .max(SOURCE_CONNECTION_LIMITS.maxAllowedUrls),
    mappings: z
      .array(SourceConnectionMappingSchema)
      .min(1)
      .max(SOURCE_CONNECTION_LIMITS.maxMappings),
    timezone: z.string().min(1).max(100),
    refreshIntervalSeconds: z.number().int().min(300).max(86_400),
    freshnessSeconds: z.number().int().min(60).max(2_592_000),
    validation: z
      .object({
        minRecords: z.number().int().min(1).max(SOURCE_CONNECTION_LIMITS.maxRecords),
        maxRecords: z.number().int().min(1).max(SOURCE_CONNECTION_LIMITS.maxRecords),
        maxChangedFraction: z.number().min(0).max(1),
        maxRequestsPerDay: z.number().int().min(1).max(48),
      })
      .strict(),
    publicationPolicy: z.enum(['review_required', 'auto_verified']),
    approval: SourceConnectionApprovalSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (!isValidIanaTimeZone(config.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timezone'],
        message: 'Unknown IANA timezone',
      })
    }
    if (new Set(config.allowedUrls).size !== config.allowedUrls.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedUrls'], message: 'Duplicate URL' })
    }
    if (!config.allowedUrls.includes(config.sourceUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedUrls'],
        message: 'Source URL must be approved',
      })
    }
    for (const [index, value] of config.allowedUrls.entries()) {
      const check = checkLiveDataEndpoint(value)
      if (!check.ok || !isCanonicalSourceUrl(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allowedUrls', index],
          message: 'Canonical public HTTPS URL required',
        })
      }
    }
    if (config.validation.minRecords > config.validation.maxRecords) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validation'],
        message: 'Minimum exceeds maximum',
      })
    }
    if (
      config.mappings.some((mapping) => mapping.kind !== 'description') &&
      config.freshnessSeconds > 86_400
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshnessSeconds'],
        message: 'Dated source freshness exceeds one day',
      })
    }
    if (new Set(config.mappings.map((mapping) => mapping.type)).size !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mappings'],
        message: 'One resource has one structured format',
      })
    }
    for (const [index, mapping] of config.mappings.entries()) {
      if (
        mapping.type === 'html' &&
        mapping.dateFormat === 'english_month_day' &&
        !mapping.pageDate
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mappings', index, 'pageDate'],
          message: 'Page date required for year context',
        })
      }
    }
  })

export type SourceConnectionConfig = z.infer<typeof SourceConnectionConfigSchema>

export const SourceConnectionRecordSchema = z
  .object({
    id: z.string().min(1).max(191),
    kind: SourceConnectionKindSchema,
    title: z.string().min(1).max(240),
    text: z.string().min(1).max(SOURCE_CONNECTION_LIMITS.maxTextLength),
    sourceUrl: z.string().url().max(SOURCE_CONNECTION_LIMITS.maxUrlLength),
    startDate: isoDate.nullable(),
    endDate: isoDate.nullable(),
    showtimes: z
      .array(z.object({ startAt: isoInstant, endAt: isoInstant }).strict())
      .max(SOURCE_CONNECTION_LIMITS.maxShowtimes),
    effectiveFrom: isoInstant.nullable(),
    effectiveUntil: isoInstant.nullable(),
    timezone: z.string().min(1).max(100).refine(isValidIanaTimeZone, 'Unknown IANA timezone'),
    cancelled: z.boolean(),
    exceptions: z.array(isoDate).max(SOURCE_CONNECTION_LIMITS.maxExceptions),
    links: z
      .array(z.string().url().max(SOURCE_CONNECTION_LIMITS.maxUrlLength))
      .max(SOURCE_CONNECTION_LIMITS.maxAllowedUrls),
  })
  .strict()

export type SourceConnectionRecord = z.infer<typeof SourceConnectionRecordSchema>

export const SourceConnectionSnapshotSchema = z
  .object({
    version: z.literal(SOURCE_CONNECTION_VERSION),
    configHash: z.string().regex(/^[a-f0-9]{64}$/u),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceUrl: z.string().url().max(SOURCE_CONNECTION_LIMITS.maxUrlLength),
    observedAt: isoInstant,
    freshnessExpiresAt: isoInstant,
    // Source validity is separate from the last fetch/check time. A 304 cannot extend it.
    validUntil: isoInstant.nullable(),
    records: z.array(SourceConnectionRecordSchema).max(SOURCE_CONNECTION_LIMITS.maxRecords),
    publicationIds: z
      .array(
        z
          .object({
            recordId: z.string().min(1).max(191),
            moduleId: z.string().min(1).max(191),
            revisionId: z.string().min(1).max(191),
            publicationId: z.string().min(1).max(191),
            knowledgeEntryId: z.string().min(1).max(191),
          })
          .strict(),
      )
      .max(SOURCE_CONNECTION_LIMITS.maxRecords),
    cost: z
      .object({
        fetches: z
          .number()
          .int()
          .min(0)
          .max(SOURCE_CONNECTION_LIMITS.maxAttempts * (SOURCE_CONNECTION_LIMITS.maxRedirects + 1)),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(
            SOURCE_CONNECTION_LIMITS.maxBodyBytes *
              SOURCE_CONNECTION_LIMITS.maxAttempts *
              (SOURCE_CONNECTION_LIMITS.maxRedirects + 1),
          ),
      })
      .strict(),
  })
  .strict()

export type SourceConnectionSnapshot = z.infer<typeof SourceConnectionSnapshotSchema>

export function isApprovedSourceUrl(config: SourceConnectionConfig, rawUrl: string): boolean {
  return isCanonicalSourceUrl(rawUrl) && config.allowedUrls.includes(rawUrl)
}

/** No fragments, encoded path separators/control bytes, or double encoding that a server can
 * interpret as a different path. Approval identifies the exact resource sent on the wire. */
function isCanonicalSourceUrl(value: string): boolean {
  const check = checkLiveDataEndpoint(value)
  return (
    check.ok &&
    check.url.toString() === value &&
    check.url.hash === '' &&
    !check.url.hostname.endsWith('.') &&
    !/[\\\p{Cc}\s]/u.test(value) &&
    !/%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(check.url.pathname)
  )
}
