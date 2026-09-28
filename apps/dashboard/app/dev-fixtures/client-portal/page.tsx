import { notFound } from 'next/navigation'

import { ClientPortalFixture, type FixturePage } from './ClientPortalFixture'
import type { FixtureOptions } from './fixture-client'

export const metadata = { title: 'Client portal fixture' }

type Params = Record<string, string | string[] | undefined>

function pick<T extends string>(value: Params[string], allowed: readonly T[], fallback: T): T {
  const candidate = Array.isArray(value) ? value[0] : value
  return allowed.includes(candidate as T) ? (candidate as T) : fallback
}

/**
 * Development-only: the real portal pages rendered against an in-memory client so layout,
 * states and journeys can be inspected without accounts, storage, billing or models.
 */
export default async function ClientPortalFixturePage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const params = await searchParams
  const page = pick<FixturePage>(
    params.page,
    ['home', 'look', 'help', 'updates', 'account'],
    'home',
  )
  const options: FixtureOptions = {
    payment: pick(params.payment, ['paid', 'due', 'past-due', 'loading', 'error', 'none'], 'paid'),
    uploads: pick(params.uploads, ['ok', 'fail-once', 'checking'], 'ok'),
    send: pick(params.send, ['ok', 'fail-once'], 'ok'),
    save: pick(params.save, ['ok', 'fail'], 'ok'),
  }
  const state = Array.isArray(params.state) ? (params.state[0] ?? '') : (params.state ?? '')
  return (
    <ClientPortalFixture
      page={page}
      state={state.slice(0, 40)}
      role={pick(params.role, ['owner', 'manager', 'staff'], 'owner')}
      options={options}
      webOrigin={process.env.NEXT_PUBLIC_WEB_URL?.trim() || 'http://localhost:3000'}
    />
  )
}
