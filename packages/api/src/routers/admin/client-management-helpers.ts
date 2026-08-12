import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'

import { ClientAccountActionError, ClientCreateIntentError } from '@pathfinder/db'

import type { CreateVenueRequestInput } from '../../schemas/venue'

export function platformAdminActor(userId: string) {
  return { type: 'HUMAN', id: userId, role: 'PLATFORM_ADMIN' } as const
}

export function clientCreateHash(input: {
  clientName: string
  clientSlug?: string | undefined
  venue: z.infer<typeof CreateVenueRequestInput>
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export function mapClientCreateIntentError(error: unknown): never {
  if (error instanceof ClientCreateIntentError) {
    throw new TRPCError({ code: 'CONFLICT', message: error.message })
  }
  throw error
}

export function mapClientActionError(error: unknown): never {
  if (error instanceof ClientAccountActionError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
  throw error
}
