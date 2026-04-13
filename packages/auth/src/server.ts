import { currentUser as clerkCurrentUser } from '@clerk/nextjs/server'
import { TRPCError } from '@trpc/server'

export async function currentUser() {
  return clerkCurrentUser()
}

export async function requireAuth() {
  const user = await clerkCurrentUser()

  if (user === null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    })
  }

  return user
}
