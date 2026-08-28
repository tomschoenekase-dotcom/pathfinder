'use client'

import React, { createContext, useContext, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink, loggerLink, splitLink, type TRPCClient, type TRPCLink } from '@trpc/client'
import { createTRPCReact } from '@trpc/react-query'
import { observable } from '@trpc/server/observable'
import superjson from 'superjson'

import type { AppRouter } from '@pathfinder/api'

export const TRPC_ENDPOINT = '/api/trpc'

export const trpc = createTRPCReact<AppRouter>()

export type WebTRPCClient = TRPCClient<AppRouter>

function privatePostStreamingLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        const controller = new AbortController()
        void (async () => {
          const response = await fetch('/api/chat-stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(op.input),
            signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new Error('Chat stream could not start.')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffered = ''
          const acceptLine = (line: string) => {
            if (!line) return
            const event = JSON.parse(line) as { type?: string; code?: string }
            if (event.type === 'error') {
              throw Object.assign(new Error('Chat stream failed.'), {
                data: { code: event.code ?? 'INTERNAL_SERVER_ERROR' },
              })
            }
            observer.next({ result: { data: event } })
          }
          let streamComplete = false
          while (!streamComplete) {
            const { done, value } = await reader.read()
            buffered += decoder.decode(value, { stream: !done })
            const lines = buffered.split('\n')
            buffered = lines.pop() ?? ''
            for (const line of lines) acceptLine(line)
            streamComplete = done
          }
          acceptLine(buffered)
          observer.complete()
        })().catch((error: unknown) => {
          if (!controller.signal.aborted)
            observer.error(error as Parameters<typeof observer.error>[0])
        })
        return () => controller.abort()
      })
}

function createBrowserTRPCClient(): WebTRPCClient {
  return trpc.createClient({
    links: [
      loggerLink({
        enabled: (options) =>
          process.env.NODE_ENV === 'development' ||
          (options.direction === 'down' && options.result instanceof Error),
      }),
      splitLink({
        condition: (operation) => operation.type === 'subscription',
        true: privatePostStreamingLink(),
        false: httpBatchLink({
          transformer: superjson,
          url: TRPC_ENDPOINT,
        }),
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
