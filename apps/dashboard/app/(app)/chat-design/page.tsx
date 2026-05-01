import { TRPCError } from '@trpc/server'

import { appRouter, createTRPCContext } from '@pathfinder/api'

import { ChatDesignForm } from '../../../components/ChatDesignForm'

export default async function ChatDesignPage() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/chat-design'),
  })
  const caller = appRouter.createCaller(ctx)

  let venues: Awaited<ReturnType<typeof caller.venue.list>> = []
  try {
    venues = await caller.venue.list()
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error
  }

  return (
    <div className="px-6 py-10">
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Chatbot Design</h1>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Customise how your guest chat looks: colours, logo, and header image.
          </p>
        </div>
        <ChatDesignForm venues={venues} />
      </div>
    </div>
  )
}
