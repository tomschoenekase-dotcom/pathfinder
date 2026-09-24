'use client'
import { useCallback } from 'react'
import type { ComponentProps } from 'react'
import superjson from 'superjson'
import { ChicagoVenueDirectory } from '../../../../components/admin/ChicagoVenueDirectory'
import { TRPCProvider } from '../../../../lib/trpc'

type Props = NonNullable<ComponentProps<typeof ChicagoVenueDirectory>>
const endpoint = '/dev-fixtures/prospect-research/chicago/data'
async function request<T>(
  operation: string,
  input: unknown,
  signal: AbortSignal,
  mutation = false,
): Promise<T> {
  const response = await fetch(
    mutation
      ? endpoint
      : `${endpoint}?operation=${operation}&input=${encodeURIComponent(JSON.stringify(input))}`,
    {
      method: mutation ? 'POST' : 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
      ...(mutation
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operation, input }),
          }
        : {}),
    },
  )
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    const failure = new Error(
      payload?.error?.message ?? 'The local Chicago request did not return a result.',
    ) as Error & { data: { code: string } }
    failure.data = { code: payload?.error?.code ?? 'INTERNAL_SERVER_ERROR' }
    throw failure
  }
  return superjson.parse<T>(await response.text())
}
export function LocalChicagoIntelligenceWorkspace({ territoryId }: { territoryId: string }) {
  const loadPage = useCallback<NonNullable<Props['loadPage']>>(
    (input, signal) => request('list', input, signal),
    [],
  )
  const loadDetail = useCallback<NonNullable<Props['loadDetail']>>(
    (venueId, signal) => request('read', { venueId }, signal),
    [],
  )
  const loadHealth = useCallback<NonNullable<Props['loadHealth']>>(
    (signal) => request('health', {}, signal),
    [],
  )
  const act = useCallback<NonNullable<Props['act']>>(
    (action, signal) => request(action.kind, action.input, signal, true),
    [],
  )
  return (
    <TRPCProvider scopeKey="local-chicago-disposable-fixture">
      <ChicagoVenueDirectory
        territoryId={territoryId}
        loadPage={loadPage}
        loadDetail={loadDetail}
        loadHealth={loadHealth}
        act={act}
        directoryHref="/dev-fixtures/prospect-research"
      />
    </TRPCProvider>
  )
}
