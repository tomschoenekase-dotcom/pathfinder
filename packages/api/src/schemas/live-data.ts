import { z } from 'zod'

import {
  LIVE_DATA_KINDS,
  LIVE_DATA_LIMITS,
  liveDataMappingSchema,
} from '@pathfinder/contracts/live-data'

const identifier = z.string().trim().min(1).max(191)

export const LiveDataKindInput = z.enum(LIVE_DATA_KINDS)

const resourceId = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, 'Use lowercase letters, digits, dot, dash or underscore')

const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'Use an IANA time zone such as America/New_York')

const connectorFields = {
  name: z.string().trim().min(1).max(120),
  kind: LiveDataKindInput,
  provider: z.string().trim().min(1).max(80),
  resourceId,
  resourceLabel: z.string().trim().min(1).max(120),
  endpointUrl: z.string().trim().min(1).max(2048),
  mapping: liveDataMappingSchema,
  pollIntervalSeconds: z
    .number()
    .int()
    .min(LIVE_DATA_LIMITS.minPollIntervalSeconds)
    .max(LIVE_DATA_LIMITS.maxPollIntervalSeconds)
    .default(LIVE_DATA_LIMITS.defaultPollIntervalSeconds),
  freshnessBudgetSeconds: z
    .number()
    .int()
    .min(LIVE_DATA_LIMITS.minFreshnessBudgetSeconds)
    .max(LIVE_DATA_LIMITS.maxFreshnessBudgetSeconds)
    .default(LIVE_DATA_LIMITS.defaultFreshnessBudgetSeconds),
  timezone,
}

export const ListLiveDataConnectorsInput = z.object({ venueId: identifier }).strict()
export const LiveDataPolicyInput = z.object({ venueId: identifier }).strict()

export const CreateLiveDataConnectorInput = z
  .object({ venueId: identifier, ...connectorFields })
  .strict()
  .refine((value) => value.freshnessBudgetSeconds >= value.pollIntervalSeconds, {
    path: ['freshnessBudgetSeconds'],
    message: 'The freshness budget must be at least the poll interval.',
  })

export const UpdateLiveDataConnectorInput = z
  .object({
    connectorId: identifier,
    name: connectorFields.name.optional(),
    provider: connectorFields.provider.optional(),
    resourceLabel: connectorFields.resourceLabel.optional(),
    endpointUrl: connectorFields.endpointUrl.optional(),
    mapping: connectorFields.mapping.optional(),
    pollIntervalSeconds: connectorFields.pollIntervalSeconds.optional(),
    freshnessBudgetSeconds: connectorFields.freshnessBudgetSeconds.optional(),
    timezone: connectorFields.timezone.optional(),
  })
  .strict()

export const LiveDataConnectorIdInput = z.object({ connectorId: identifier }).strict()
