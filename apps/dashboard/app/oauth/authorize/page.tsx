import { notFound, redirect } from 'next/navigation'

import { activeOperatorArming, validateAuthorizationRequest } from '@pathfinder/api/operator'
import { OperatorCapability } from '@pathfinder/contracts/operator-mcp'
import { db } from '@pathfinder/db'

import { resolveOperatorSession } from '../../../lib/operator-session'
import { ConsentForm } from './ConsentForm'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function single(params: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    // Repeated OAuth parameters are invalid; drop them so validation fails closed.
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-3 text-sm text-slate-600">{body}</p>
    </main>
  )
}

/** OAuth consent for connecting the Dot. Only an allowlisted platform admin can see it. */
export default async function OperatorAuthorizePage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const session = await resolveOperatorSession()
  if (session.status === 'disabled') notFound()
  if (session.status === 'misconfigured') {
    return (
      <Message title="Operator unavailable" body="The operator connection is not configured." />
    )
  }
  if (session.status === 'forbidden') {
    return <Message title="Not allowed" body="This account cannot connect operator tools." />
  }
  const params = single(await searchParams)
  const validation = await validateAuthorizationRequest(params, session.config, new Date(), db)
  if (validation.kind === 'show-error') {
    return (
      <Message
        title="This connection request is not valid"
        body="The app asking to connect is unknown, expired, or used an unregistered return address. Nothing was shared."
      />
    )
  }
  if (validation.kind === 'redirect-error') redirect(validation.redirectTo)
  if (!(await activeOperatorArming(session.userId, db))) {
    return (
      <Message
        title="Connection not started from Torchiko"
        body="Connections must be started from the Torchiko operator connect page within the last 10 minutes. If you did not just do that, close this page: someone else may be trying to connect their app. Nothing was shared."
      />
    )
  }
  const client = await db.operatorOAuthClient.findUnique({
    where: { id: validation.request.clientId },
    select: { createdAt: true },
  })
  const registeredMinutes = client
    ? Math.max(0, Math.round((Date.now() - client.createdAt.getTime()) / 60_000))
    : null
  const tenants = await db.tenant.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 500,
  })
  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-xl font-semibold text-slate-900">Connect the operator</h1>
      <p className="mt-2 text-sm text-slate-600">
        <strong className="text-slate-900">{validation.request.clientName}</strong> wants operator
        access. After approval you will be sent to{' '}
        <strong className="text-slate-900">{validation.request.redirectHost}</strong>.
      </p>
      {registeredMinutes !== null ? (
        <p className="mt-2 text-sm text-slate-600">
          This app registered {registeredMinutes} minute{registeredMinutes === 1 ? '' : 's'} ago.
          Approve only if you just added it yourself.
        </p>
      ) : null}
      <p className="mt-2 text-sm text-slate-600">
        Authorized routine CRM edits, imports, draft venues and appearance changes can apply without
        another approval. Existing Ask first settings still apply. External actions and other
        reviewed changes keep their separate approval steps.
      </p>
      <ConsentForm
        params={params}
        tenants={tenants}
        capabilities={[...OperatorCapability.options]}
      />
    </main>
  )
}
