import { notFound } from 'next/navigation'

import { resolveOperatorSession } from '../../../lib/operator-session'
import { ArmButton } from './ArmButton'

export const dynamic = 'force-dynamic'

/** Step one of connecting the Dot: arm, then add the connector in ChatGPT within ten minutes. */
export default async function OperatorArmPage() {
  const session = await resolveOperatorSession()
  if (session.status === 'disabled') notFound()
  if (session.status !== 'ok') {
    return (
      <main className="mx-auto max-w-lg px-4 py-12">
        <h1 className="text-xl font-semibold text-slate-900">Not allowed</h1>
      </main>
    )
  }
  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <h1 className="text-xl font-semibold text-slate-900">Connect the operator</h1>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>Tap the button below. It asks for Face ID or your passkey.</li>
        <li>Within 10 minutes, add the connector in ChatGPT and choose OAuth.</li>
        <li>Approve the connection page that ChatGPT opens.</li>
      </ol>
      <p className="mt-3 text-sm text-slate-600">
        A connection page you did not start this way is refused, so a link someone else sends you
        cannot connect their app.
      </p>
      <ArmButton />
    </main>
  )
}
