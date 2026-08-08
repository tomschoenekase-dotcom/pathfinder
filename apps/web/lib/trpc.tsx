'use client'

import React, { createContext, useContext, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink, loggerLink, type TRPCClient } from '@trpc/client'
import { createTRPCReact } from '@trpc/react-query'
import superjson from 'superjson'

import type { AppRouter } from '@pathfinder/api'

export const TRPC_ENDPOINT = '/api/trpc'

export const trpc = createTRPCReact<AppRouter>()

export type WebTRPCClient = TRPCClient<AppRouter>

function createBrowserTRPCClient(): WebTRPCClient {
  return trpc.createClient({
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

const TRPCClientContext = createContext<WebTRPCClient | null>(null)

function TRPCProviderBoundary({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const [trpcClient] = useState(createBrowserTRPCClient)

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TRPCClientContext.Provider value={trpcClient}>{children}</TRPCClientContext.Provider>
      </QueryClientProvider>
    </trpc.Provider>
  )
}

export function TRPCProvider({ children, scopeKey }: { children: ReactNode; scopeKey: string }) {
  return <TRPCProviderBoundary key={scopeKey}>{children}</TRPCProviderBoundary>
}

export function useTRPCClient(): WebTRPCClient {
  const client = useContext(TRPCClientContext)

  if (!client) {
    throw new Error('useTRPCClient must be used within a TRPCProvider')
  }

  return client
}
