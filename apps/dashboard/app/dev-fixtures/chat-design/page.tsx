import { notFound } from 'next/navigation'

import { ChatDesignFixtureClient } from './FixtureClient'

export default async function ChatDesignFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const params = await searchParams
  return <ChatDesignFixtureClient canEdit={params.role !== 'staff'} />
}
