'use client'

import { useCallback } from 'react'
import type { ComponentProps } from 'react'
import superjson from 'superjson'

import { ProspectDirectory } from '../../../components/admin/ProspectDirectory'
import { TRPCProvider } from '../../../lib/trpc'

type Props = NonNullable<ComponentProps<typeof ProspectDirectory>>
type LoadPage = NonNullable<Props['loadPage']>

export function LocalProspectResearchDirectory({
  territories,
}: {
  territories: NonNullable<Props['territories']>
}) {
  const loadPage = useCallback<LoadPage>(async (input, signal) => {
    const response = await fetch(
      `/dev-fixtures/prospect-research/data?input=${encodeURIComponent(JSON.stringify(input))}`,
      {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        ...(signal ? { signal } : {}),
      },
    )
    if (!response.ok)
      throw new Error('The local CRM read failed. Retry without changing any records.')
    return superjson.parse<Awaited<ReturnType<LoadPage>>>(await response.text())
  }, [])
  return (
    <TRPCProvider scopeKey="local-prospect-research-read-only">
      <ProspectDirectory
        loadPage={loadPage}
        territories={territories}
        readOnly
        directoryHref="/dev-fixtures/prospect-research"
        outreachAvailable={false}
      />
    </TRPCProvider>
  )
}
