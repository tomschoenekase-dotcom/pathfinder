'use client'

import React, { createContext, type ReactNode, useContext, useState } from 'react'
import { httpBatchLink, loggerLink, type TRPCClient } from '@trpc/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCReact, type CreateTRPCReact } from '@trpc/react-query'
import superjson from 'superjson'

import type { AppRouter } from '@pathfinder/api'

export const TRPC_ENDPOINT = '/api/trpc'

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>()

export type DashboardTRPCClient = TRPCClient<AppRouter>

const TRPCClientContext = createContext<DashboardTRPCClient | null>(null)

function createBrowserTRPCClient(): DashboardTRPCClient {
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

function TRPCProviderBoundary({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const [client] = useState(createBrowserTRPCClient)

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TRPCClientContext.Provider value={client}>{children}</TRPCClientContext.Provider>
      </QueryClientProvider>
    </trpc.Provider>
  )
}

export function TRPCProvider({ children, scopeKey }: { children: ReactNode; scopeKey: string }) {
  return <TRPCProviderBoundary key={scopeKey}>{children}</TRPCProviderBoundary>
}

export function useTRPCClient(): DashboardTRPCClient {
  const client = useContext(TRPCClientContext)

  if (client === null) {
    throw new Error('useTRPCClient must be used within a TRPCProvider')
  }

  return client
}
