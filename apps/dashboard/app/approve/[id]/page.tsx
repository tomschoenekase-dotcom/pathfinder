import { notFound } from 'next/navigation'

import { createOperatorRegistry, type OperatorKindRegistry } from '@pathfinder/api/operator'
import { db } from '@pathfinder/db'

import { resolveOperatorSession } from '../../../lib/operator-session'
import { ApprovePanel } from './ApprovePanel'

export const dynamic = 'force-dynamic'

type Step = {
  index: number
  tool: string
  status: string
  title: string
  lines: string[]
  args: string
}

function describe(kinds: OperatorKindRegistry, tool: string, args: unknown) {
  const kind = kinds.get(tool)
  if (!kind) return { title: tool, lines: [] as string[] }
  try {
    const described = kind.describe(kind.parse(args))
    return { title: described.title, lines: [...described.lines] }
  } catch {
    // Steps that reference earlier results are shown as raw arguments only.
    return { title: tool, lines: [] as string[] }
  }
}

/** One-tap approval page for a proposal or a plan: the full change, then Approve or Reject. */
export default async function OperatorApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await resolveOperatorSession()
  if (session.status === 'disabled') notFound()
  if (session.status !== 'ok') {
    return (
      <main className="mx-auto max-w-lg px-4 py-12">
        <h1 className="text-xl font-semibold text-slate-900">Not allowed</h1>
      </main>
    )
  }
  const { id } = await params
  const kinds = createOperatorRegistry().kinds
  const plan = await db.operatorPlan.findUnique({ where: { id } })
  let title: string
  let status: string
  let argsHash: string
  let expiresAt: Date
  let steps: Step[]
  if (plan) {
    const rows = await db.operatorProposal.findMany({
      where: { planId: plan.id },
      orderBy: { planStepIndex: 'asc' },
    })
    title = plan.title
    status = plan.status
    argsHash = plan.argsHash
    expiresAt = plan.expiresAt
    steps = rows.map((row) => ({
      index: row.planStepIndex ?? 0,
      tool: row.tool,
      status: row.status,
      ...describe(kinds, row.tool, row.args),
      args: JSON.stringify(row.args, null, 2),
    }))
  } else {
    const row = await db.operatorProposal.findUnique({ where: { id } })
    if (!row || row.planId !== null) notFound()
    const described =
      row.kind === 'operator.revert'
        ? { title: 'Undo an applied change', lines: [`Reverts proposal ${row.revertOfId ?? ''}`] }
        : describe(kinds, row.tool, row.args)
    title = described.title
    status = row.status
    argsHash = row.argsHash
    expiresAt = row.expiresAt
    steps = [
      {
        index: 0,
        tool: row.tool,
        status: row.status,
        ...described,
        args: JSON.stringify(row.args, null, 2),
      },
    ]
  }
  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Operator request</p>
      <h1 className="mt-1 text-xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-1 text-sm text-slate-600">
        Status: <strong>{status}</strong> · expires{' '}
        {expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((step) => (
          <li key={step.index} className="rounded-md border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">
              {steps.length > 1 ? `${step.index + 1}. ` : ''}
              {step.title}
            </p>
            {step.lines.length ? (
              <ul className="mt-1 list-disc pl-5 text-sm text-slate-700">
                {step.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-slate-500">Exact arguments</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs text-slate-700">
                {step.args}
              </pre>
            </details>
          </li>
        ))}
      </ol>
      {status === 'PENDING' ? <ApprovePanel id={id} argsHash={argsHash} /> : null}
    </main>
  )
}
