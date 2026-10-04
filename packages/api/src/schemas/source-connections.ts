import { z } from 'zod'

import { SourceConnectionConfigSchema } from '@pathfinder/contracts/source-connections'

const identifier = z.string().trim().min(1).max(191)
const version = z.string().datetime({ offset: true })
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const draftConfig = SourceConnectionConfigSchema.refine((config) => config.approval === undefined, {
  path: ['approval'],
  message: 'Approval is recorded only after preview review.',
})

export const ListSourceConnectionsInput = z.object({ venueId: identifier }).strict()
export const GetSourceConnectionInput = z
  .object({ venueId: identifier, connectorId: identifier })
  .strict()
export const CreateSourceConnectionInput = z
  .object({
    venueId: identifier,
    name: z.string().trim().min(1).max(120),
    config: draftConfig,
    operationId: z.string().uuid().optional(),
  })
  .strict()
export const UpdateSourceConnectionInput = z
  .object({
    venueId: identifier,
    connectorId: identifier,
    expectedUpdatedAt: version,
    config: draftConfig,
  })
  .strict()
export const VersionedSourceConnectionInput = GetSourceConnectionInput.extend({
  expectedUpdatedAt: version,
}).strict()
export const ApproveSourceConnectionInput = VersionedSourceConnectionInput.extend({
  previewId: identifier,
  previewHash: hash,
}).strict()
