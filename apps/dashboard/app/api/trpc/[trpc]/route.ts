import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

import { appRouter, createTRPCContext } from '@pathfinder/api'
import { gmailOAuthRuntime } from '../../../../lib/gmail-oauth-runtime'

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => {
      const runtime = gmailOAuthRuntime()
      return createTRPCContext({
        req,
        gmailDraftReader: runtime ? (input) => runtime.readDraft(input) : null,
      })
    },
  })

export { handler as GET, handler as POST }
