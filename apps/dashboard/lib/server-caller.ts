import { headers } from 'next/headers'

import { appRouter, createTRPCContext } from '@pathfinder/api'

export async function createDashboardCaller(
  pathname: string,
): Promise<ReturnType<typeof appRouter.createCaller>> {
  const incomingHeaders = await headers()
  const cookie = incomingHeaders.get('cookie')
  const requestHeaders = new Headers()

  if (cookie) {
    requestHeaders.set('cookie', cookie)
  }

  const ctx = await createTRPCContext({
    req: new Request(`https://dashboard.pathfinder.local${pathname}`, {
      headers: requestHeaders,
    }),
  })

  return appRouter.createCaller(ctx)
}
