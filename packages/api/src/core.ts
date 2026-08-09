import superjson from 'superjson'
import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server'

import type { TRPCContext } from './context'

const isDevelopment = process.env.NODE_ENV === 'development'
const GENERIC_SERVER_ERROR_MESSAGE = 'Internal server error'
const PUBLIC_ERROR_MESSAGE = Symbol('pathfinder.public-error-message')

type PublicTRPCError = TRPCError & { [PUBLIC_ERROR_MESSAGE]?: true }

/** Creates a tRPC error whose message is intentionally safe to expose to clients. */
export function publicTRPCError(options: {
  code: TRPC_ERROR_CODE_KEY
  message: string
  cause?: unknown
}): TRPCError {
  const error: PublicTRPCError = new TRPCError(options)
  Object.defineProperty(error, PUBLIC_ERROR_MESSAGE, { value: true })
  return error
}

export const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ error, shape }) {
    const isPublicMessage = (error as PublicTRPCError)[PUBLIC_ERROR_MESSAGE] === true
    const message = isDevelopment || isPublicMessage ? shape.message : GENERIC_SERVER_ERROR_MESSAGE
    return {
      ...shape,
      message,
      data: isDevelopment
        ? { ...shape.data, stack: error.stack }
        : { code: shape.data.code, httpStatus: shape.data.httpStatus },
    }
  },
})

export const router = t.router
export const mergeRouters = t.mergeRouters
