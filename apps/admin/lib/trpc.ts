import { createTRPCClient as createTRPCCoreClient, httpBatchLink, loggerLink } from '@trpc/client'
import { QueryClient } from '@tanstack/react-query'
import { createTRPCReact } from '@trpc/react-query'
import type { CreateTRPCReact } from '@trpc/react-query'
import superjson from 'superjson'

import type { AppRouter } from '@pathfinder/api'

export const TRPC_ENDPOINT = '/api/trpc'

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>()

export function createQueryClient() {
  return new QueryClient()
}

export function createTRPCClient() {
  return createTRPCCoreClient<AppRouter>({
    links: [
      loggerLink({
        enabled: (options) =>
          process.env.NODE_ENV === 'development' ||
          (options.direction === 'down' && options.result instanceof Error),
      }),
      httpBatchLink({
        transformer: superjson,
        url: TRPC_ENDPOINT,
      }),
    ],
  })
}
