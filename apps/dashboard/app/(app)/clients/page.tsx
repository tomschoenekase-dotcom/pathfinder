import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { appRouter, createTRPCContext } from '@pathfinder/api'
import { ClientsPanel, type Client } from '../../../components/ClientsPanel'

export default async function ClientsPage() {
  const { sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as Record<string, unknown> | undefined)?.platform_role ===
    'PLATFORM_ADMIN'

  if (!isPlatformAdmin) {
    redirect('/')
  }

  const ctx = await createTRPCContext({ req: new Request('https://dashboard.pathfinder.local/') })
  const caller = appRouter.createCaller(ctx)
  const clients = (await caller.admin.listClients()) as Client[]

  return <ClientsPanel clients={clients} />
}
