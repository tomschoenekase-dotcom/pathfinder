import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { KnowledgeManager } from '../../../../../components/KnowledgeManager'

type KnowledgePageProps = {
  params: Promise<{ venueId: string }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues/knowledge'),
  })

  return appRouter.createCaller(ctx)
}

export default async function KnowledgePage({ params }: KnowledgePageProps) {
  const { venueId } = await params
  const caller = await createCaller()

  try {
    const [venue, entries] = await Promise.all([
      caller.venue.getById({ id: venueId }),
      caller.knowledge.list({ venueId }),
    ])

    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10">
        <div className="mx-auto max-w-5xl space-y-6">
          <Link
            href={`/venues/${venueId}`}
            className="text-sm font-medium text-pf-primary hover:text-pf-accent"
          >
            Back to venue
          </Link>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-pf-accent">
              Venue content
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">
              Knowledge Base
            </h1>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              {venue.name} entries are embedded and retrieved semantically at chat time.
            </p>
          </div>
          <KnowledgeManager venueId={venueId} initialEntries={entries} />
        </div>
      </main>
    )
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      notFound()
    }

    throw error
  }
}
