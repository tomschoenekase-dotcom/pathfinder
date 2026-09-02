'use client'

import React, { createContext, useContext, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink, loggerLink, splitLink, type TRPCClient, type TRPCLink } from '@trpc/client'
import { createTRPCReact } from '@trpc/react-query'
import { observable } from '@trpc/server/observable'
import superjson from 'superjson'

import type { AppRouter } from '@pathfinder/api'

export const TRPC_ENDPOINT = '/api/trpc'

const CHAT_STREAM_MAX_BYTES = 1024 * 1024
const CHAT_STREAM_READ_TIMEOUT_MS = 30_000

export const trpc = createTRPCReact<AppRouter>()

export type WebTRPCClient = TRPCClient<AppRouter>

function privatePostStreamingLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        const controller = new AbortController()
        let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null
        void (async () => {
          const response = await fetch('/api/chat-stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(op.input),
            signal: controller.signal,
          })
          if (!response.ok || !response.body) {
            await response.body?.cancel('invalid-chat-stream').catch(() => undefined)
            throw new Error('Chat stream could not start.')
          }
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
          const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? ''
          const declaredLength = Number(response.headers.get('content-length') ?? 0)
          if (
            !contentType.startsWith('application/x-ndjson') ||
            !cacheControl.includes('no-store') ||
            (Number.isFinite(declaredLength) && declaredLength > CHAT_STREAM_MAX_BYTES)
          ) {
            await response.body.cancel('invalid-chat-stream').catch(() => undefined)
            throw new Error('Chat stream could not start.')
          }
          const reader = response.body.getReader()
          activeReader = reader
          const decoder = new TextDecoder()
          let buffered = ''
          let receivedBytes = 0
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
          try {
            while (!streamComplete) {
              let timeout: ReturnType<typeof setTimeout> | undefined
              const read = reader.read()
              const deadline = new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error('Chat stream timed out.')),
                  CHAT_STREAM_READ_TIMEOUT_MS,
                )
              })
              const { done, value } = await Promise.race([read, deadline]).finally(() => {
                if (timeout !== undefined) clearTimeout(timeout)
              })
              receivedBytes += value?.byteLength ?? 0
              if (receivedBytes > CHAT_STREAM_MAX_BYTES) {
                throw new Error('Chat stream exceeded its safety limit.')
              }
              buffered += decoder.decode(value, { stream: !done })
              const lines = buffered.split('\n')
              buffered = lines.pop() ?? ''
              for (const line of lines) acceptLine(line)
              streamComplete = done
            }
            acceptLine(buffered)
            observer.complete()
          } catch (error) {
            await reader.cancel('chat-stream-failed').catch(() => undefined)
            throw error
          } finally {
            activeReader = null
          }
        })().catch((error: unknown) => {
          if (!controller.signal.aborted)
            observer.error(error as Parameters<typeof observer.error>[0])
        })
        return () => {
          controller.abort()
          void activeReader?.cancel('subscription-cancelled').catch(() => undefined)
        }
      })
}

function createBrowserTRPCClient(): WebTRPCClient {
  return trpc.createClient({
    links: [
      loggerLink({
        enabled: (options) =>
          (!('type' in options) || options.type !== 'subscription') &&
          (process.env.NODE_ENV === 'development' ||
            (options.direction === 'down' && options.result instanceof Error)),
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
