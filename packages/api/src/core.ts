import superjson from 'superjson'
import { initTRPC } from '@trpc/server'

import type { TRPCContext } from './context'

const isDevelopment = process.env.NODE_ENV === 'development'

export const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ error, shape }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        stack: isDevelopment ? error.stack : undefined,
      },
    }
  },
})

export const router = t.router
