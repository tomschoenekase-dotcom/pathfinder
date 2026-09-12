import { TRPCError } from '@trpc/server'

import { SupportPortableExportInput } from '@pathfinder/contracts'
import {
  db,
  readSupportPortableExport,
  SupportPortableExportReadError,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function mapPortableExportError(error: unknown): never {
  if (!(error instanceof SupportPortableExportReadError)) throw error
  throw new TRPCError({
    code:
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code === 'PRECONDITION_FAILED'
            ? 'PRECONDITION_FAILED'
            : error.code === 'LIMIT_EXCEEDED'
              ? 'PAYLOAD_TOO_LARGE'
              : 'CONFLICT',
    message: error.message,
    cause: error,
  })
}

export const adminSupportPortableExportRouter = router({
  prepareSupportPortableExport: adminProcedure
    .input(SupportPortableExportInput)
    .query(async ({ input }) => {
      try {
        return await withTenantIsolationBypass(() => readSupportPortableExport(input, db))
      } catch (error) {
        mapPortableExportError(error)
      }
    }),
})
