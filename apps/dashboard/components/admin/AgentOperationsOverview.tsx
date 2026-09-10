import Link from 'next/link'
import type { ReactNode } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import {
  AGENT_DIRECT_EXECUTION_ROUTE,
  AgentIdentityConfigurationFields,
} from '@pathfinder/contracts'
import type { AppRouter } from '@pathfinder/api'

import { ApprovalDecisionForm } from './ApprovalDecisionForm'
import { CustomerAccessApprovalContext } from './CustomerAccessApprovalContext'
import { SupportCompletionApprovalContext } from './SupportCompletionApprovalContext'
import type { SupportCompletionOutcomeValue } from '../SupportCompletionOutcome'
import { AgentIdentityCreateEditor, AgentIdentityEditEditor } from './AgentIdentityEditor'
import { AgentQuestionAnswerForm } from './AgentQuestionAnswerForm'
import { AgentQuestionExpiryNotice } from './AgentQuestionExpiryNotice'
import { AgentQuestionDiscussion } from './AgentQuestionDiscussion'
import { AgentQuestionEvidence } from './AgentQuestionEvidence'
import { AgentTaskComposer } from './AgentTaskComposer'
import { IntakeSourceRoutingControl } from './IntakeSourceRoutingControl'
import { AgentBridgeSessionControl } from './AgentBridgeSessionControl'
import { AgentApprovalPolicyControl } from './AgentApprovalPolicyControl'
import {
  AgentWorkflowActivationLedger,
  type AgentWorkflowActivationLedgerPage,
} from './AgentWorkflowActivationLedger'
import {
  AgentWorkflowActivationReviewPanel,
  type AgentWorkflowActivationReviewPage,
} from './AgentWorkflowActivationReviewPanel'

type Cursor = { createdAt: string; id: string } | null

type Identity = {
  id: string
  identityKey: string
  name: string
  description: string | null
  agentType: string
  accessScope: string
  accessCapabilities: string[]
  autonomyLevel: string
  autonomousActions: string[]
  defaultProvider: string | null
  defaultModel: string | null
  enabled: boolean
  updatedAt: Date
  _count: { runs: number; approvalRequests: number }
}

type Run = {
  id: string
  runType: string
  requestedOperation: string
  requestPrompt: string | null
  status: string
  modelProvider: string | null
  modelName: string | null
  costE8Usd: bigint
  costStatus?: string
  errorCode: string | null
  createdAt: Date
  agentIdentity: { id: string; name: string; enabled: boolean }
  _count: { actions: number; timelineEvents: number; approvalRequests: number }
}

type Approval = {
  id: string
  agentRunId: string | null
  proposedAction: string
  reason: string
  riskCategory: string
  state: string
  createdAt: Date
  agentIdentity: { id: string; name: string }
  customerAccessRequest?: {
    id: string
    targetEmail: string
    requestedRole: string
    status: string
    supportRequestId: string
    sourceSupportMessageId: string
    providerInvitationId: string | null
    updatedAt: Date
  } | null
  supportCompletionProposal?: {
    completionOutcome: SupportCompletionOutcomeValue | null
    body: string
  } | null
}

type QuestionPage = inferRouterOutputs<AppRouter>['admin']['listAgentQuestions']
type Question = QuestionPage['items'][number]

export const agentQuestionStatusFilters = [
  'PENDING',
  'ANSWERED',
  'DISMISSED',
  'EXPIRED',
  'CANCELLED',
  'ALL',
] as const

export type AgentQuestionStatusFilter = (typeof agentQuestionStatusFilters)[number]

type ApprovalPolicy = {
  id: string
  policyKey: string | null
  agentIdentityId: string
  actionName: string
  capability: string
  issueReason: string | null
  constraints: unknown
  maxUses: number | null
  useCount: number
  expiresAt: Date | null
  revokedAt: Date | null
  revokeReason: string | null
  state: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'EXHAUSTED' | 'SCHEDULED'
  _count: { consumptions: number }
  authorityEvidence: Array<{
    createdAt: Date
    outcomeObservation: OutcomeObservation
  }>
}

type OutcomeObservation = {
  id: string
  agentRunId: string
  agentIdentityId: string
  signalKind: string
  verdict: string
  summary: string
  evidenceRef: string | null
  taskClass: string
  modelProvider: string | null
  modelName: string | null
  createdAt: Date
}

type Props = {
  actorId?: string | null | undefined
  tenantId: string
  venueId: string
  identities: { items: Identity[]; nextCursor: Cursor }
  runs: { items: Run[]; nextCursor: Cursor }
  approvals: { items: Approval[]; nextCursor: Cursor }
  questions: { items: Question[]; nextCursor: Cursor }
  questionStatus?: AgentQuestionStatusFilter
  approvalPolicies?: { items: ApprovalPolicy[]; nextCursor: Cursor }
  outcomeObservations?: OutcomeObservation[]
  questionRecipients?: Array<{
    userId: string
    role: string
    user: { fullName: string | null; email: string }
  }>
  runtime?: { agentRunnerEnabled: boolean }
  bridgeSessions?: Array<{
    id: string
    provider: string
    label: string
    runnerVersion: string
    supportedModels: string[]
    status: string
    lastHeartbeatAt: Date
    expiresAt: Date
    _count: { agentRuns: number }
  }>
  workflowActivations?: AgentWorkflowActivationLedgerPage
  workflowActivationReview?: AgentWorkflowActivationReviewPage
}

export function formatE8Usd(value: bigint) {
  const units = 100_000_000n
  const dollars = value / units
  const fractional = (value % units).toString().padStart(8, '0').replace(/0+$/, '')
  return `$${dollars.toString()}${fractional ? `.${fractional}` : '.00'}`
}

export function formatAgentRunCost(value: bigint, status?: string) {
  if (!status || status === 'UNREPORTED') return 'Not reported'
  const amount = formatE8Usd(value)
  return status === 'ESTIMATED' ? `${amount} estimated` : amount
}

const bridgeProviderForIdentityProvider: Record<string, string> = {
  'hermes-bridge': 'HERMES',
  'claude-bridge': 'CLAUDE_SUBSCRIPTION',
  'codex-bridge': 'CODEX_SUBSCRIPTION',
  'openai-compatible-bridge': 'OPENAI_COMPATIBLE',
}

function cursorHref(base: string, prefix: string, cursor: Exclude<Cursor, null>) {
  return `${base}?${prefix}CreatedAt=${encodeURIComponent(cursor.createdAt)}&${prefix}Id=${encodeURIComponent(cursor.id)}`
}

function questionHref(
  base: string,
  status: AgentQuestionStatusFilter,
  cursor?: Exclude<Cursor, null>,
) {
  const params = new URLSearchParams({ questionStatus: status })
  if (cursor) {
    params.set('questionCursorCreatedAt', cursor.createdAt)
    params.set('questionCursorId', cursor.id)
  }
  return `${base}?${params.toString()}#inbox`
}

function questionStatusLabel(status: AgentQuestionStatusFilter) {
  if (status === 'ALL') return 'All questions'
  return status.charAt(0) + status.slice(1).toLowerCase()
}

function questionBadgeTone(status: Question['status']): 'slate' | 'green' | 'amber' {
  if (status === 'ANSWERED') return 'green'
  if (status === 'PENDING' || status === 'EXPIRED') return 'amber'
  return 'slate'
}

function emptyQuestionMessage(status: AgentQuestionStatusFilter) {
  if (status === 'PENDING') return 'No pending questions are shown in this view.'
  if (status === 'ALL') return 'No questions are shown in this view.'
  return `No ${questionStatusLabel(status).toLowerCase()} questions are shown in this view.`
}

function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'slate' | 'green' | 'amber' | 'rose'
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-800',
    green: 'bg-emerald-100 text-emerald-900',
    amber: 'bg-amber-100 text-amber-950',
    rose: 'bg-rose-100 text-rose-900',
  }
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function AgentOperationsOverview({
  actorId,
  tenantId,
  venueId,
  identities,
  runs,
  approvals,
  questions,
  questionStatus = 'PENDING',
  approvalPolicies = { items: [], nextCursor: null },
  outcomeObservations = [],
  questionRecipients = [],
  runtime = { agentRunnerEnabled: false },
  bridgeSessions = [],
  workflowActivations = {
    heads: [],
    events: [],
    nextHeadAfterRegistryKey: null,
    nextEventBefore: null,
  },
  workflowActivationReview,
}: Props) {
  const base = `/admin/clients/${tenantId}/venues/${venueId}/agents`
  const now = new Date()
  const onlineBridgeProviders = new Set(
    bridgeSessions
      .filter((session) => session.status === 'ONLINE' && session.expiresAt > now)
      .map((session) => session.provider),
  )
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Agent workspace
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Work with your agents
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
          See what agents need, answer their questions, review approvals, and inspect every run from
          one operator inbox. Access describes where an agent may act; autonomy describes how
          independently it may act.
        </p>
        <p className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          Agent questions and cancellation intent are durable. A connected worker is still required
          to resume or execute work; answering a question never grants approval by itself.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Agent workspace sections">
        {[
          ['#new-task', 'New task'],
          ['#inbox', 'Inbox'],
          ['#team', 'Team & policies'],
          ['#runs', 'Runs'],
          [`${base}/integrations`, 'Integrations'],
          [`${base}/settings`, 'AI controls'],
          ['#approvals', 'Approvals'],
          ['#workflow-activations', 'Workflow ledger'],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="rounded-full border border-pf-light bg-white px-4 py-2 text-sm font-semibold text-pf-primary"
          >
            {label}
          </a>
        ))}
      </nav>

      <IntakeSourceRoutingControl
        key={`${tenantId}:${venueId}`}
        tenantId={tenantId}
        venueId={venueId}
        identities={identities.items}
      />

      <div id="new-task">
        <AgentTaskComposer tenantId={tenantId} venueId={venueId} identities={identities.items} />
      </div>

      <section id="inbox" className="space-y-4" aria-labelledby="agent-questions-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="agent-questions-heading" className="text-xl font-semibold text-pf-deep">
              {questionStatus === 'PENDING' ? 'Needs your input' : 'Question history'}
            </h3>
            <p className="mt-1 text-sm text-pf-deep/80">
              {questionStatus === 'PENDING'
                ? 'Questions that agents raised through Torchiko MCP.'
                : 'Saved questions, responses, and operator discussion notes.'}
            </p>
          </div>
          <Badge tone={questions.items.length && questionStatus === 'PENDING' ? 'amber' : 'slate'}>
            {questionStatus === 'PENDING'
              ? questions.items.length
                ? `${questions.items.length} waiting`
                : 'No questions shown'
              : `${questions.items.length} shown`}
          </Badge>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label="Question status">
          {agentQuestionStatusFilters.map((status) => (
            <Link
              key={status}
              href={questionHref(base, status)}
              aria-current={status === questionStatus ? 'page' : undefined}
              className={`rounded-full border px-3 py-1.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent ${
                status === questionStatus
                  ? 'border-pf-primary bg-pf-primary text-white'
                  : 'border-pf-light bg-white text-pf-primary hover:border-pf-primary'
              }`}
            >
              {questionStatusLabel(status)}
            </Link>
          ))}
        </nav>
        {questions.items.length === 0 ? (
          <Empty text={emptyQuestionMessage(questionStatus)} />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {questions.items.map((question) => (
              <article
                key={question.id}
                className="rounded-3xl border border-sky-200 bg-sky-50 p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={question.blocking ? 'amber' : 'slate'}>
                    {question.blocking
                      ? question.status === 'PENDING'
                        ? 'Run blocked'
                        : 'Blocking question'
                      : 'Non-blocking'}
                  </Badge>
                  <Badge tone={questionBadgeTone(question.status)}>
                    {question.status.toLowerCase()}
                  </Badge>
                  <span className="text-xs font-semibold text-sky-950">
                    {question.agentIdentity.name}
                  </span>
                  <span className="text-xs text-pf-deep/80">
                    {question.createdAt.toLocaleString()}
                  </span>
                </div>
                <h4 className="mt-3 text-lg font-semibold leading-7 text-pf-deep">
                  {question.question}
                </h4>
                {question.context ? (
                  <p className="mt-2 text-sm leading-6 text-pf-deep/65">{question.context}</p>
                ) : null}
                <AgentQuestionEvidence
                  evidence={question.evidence}
                  proposedAnswer={question.proposedAnswer}
                />
                {['ANSWERED', 'DISMISSED'].includes(question.status) && question.answer ? (
                  <div className="mt-4 border-l-2 border-slate-300 pl-4">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-deep/70">
                      Recorded response
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-pf-deep/80">
                      {question.answer}
                    </p>
                    {question.answeredAt ? (
                      <p className="mt-2 text-xs text-pf-deep/70">
                        Responded {question.answeredAt.toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {question.status === 'PENDING' ? (
                  <AgentQuestionAnswerForm
                    actorId={actorId}
                    tenantId={tenantId}
                    venueId={venueId}
                    questionId={question.id}
                    expectedUpdatedAt={question.updatedAt}
                    expiresAt={question.expiresAt}
                    agentRunId={question.agentRunId}
                    questionType={question.questionType}
                    choices={question.choices}
                    recipients={questionRecipients}
                    canRouteToClient={question.blocking && Boolean(question.agentRunId)}
                  />
                ) : null}
                {question.status === 'EXPIRED' ? (
                  <AgentQuestionExpiryNotice
                    tenantId={tenantId}
                    venueId={venueId}
                    agentRunId={question.agentRunId}
                  />
                ) : null}
                <AgentQuestionDiscussion
                  tenantId={tenantId}
                  venueId={venueId}
                  questionId={question.id}
                />
              </article>
            ))}
          </div>
        )}
        {questions.nextCursor ? (
          <Older
            href={questionHref(base, questionStatus, questions.nextCursor)}
            label="Older questions"
          />
        ) : null}
      </section>

      <AgentWorkflowActivationLedger
        tenantId={tenantId}
        venueId={venueId}
        initialPage={workflowActivations}
      />
      {workflowActivationReview ? (
        <AgentWorkflowActivationReviewPanel
          tenantId={tenantId}
          venueId={venueId}
          initialPage={workflowActivationReview}
        />
      ) : null}

      <section id="team" className="space-y-4" aria-labelledby="agent-identities-heading">
        <div>
          <h3 id="agent-identities-heading" className="text-xl font-semibold text-pf-deep">
            Agent identities
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Configured authority and operating boundaries.
          </p>
        </div>
        <AgentIdentityCreateEditor tenantId={tenantId} venueId={venueId} />
        {identities.items.length === 0 ? (
          <Empty text="No agent identities are configured for this venue." />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {identities.items.map((identity) => (
              <article
                key={identity.id}
                className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-pf-deep">{identity.name}</h4>
                    <p className="mt-1 font-mono text-xs text-pf-deep/55">{identity.identityKey}</p>
                  </div>
                  <Badge tone={identity.enabled ? 'green' : 'slate'}>
                    {identity.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                {identity.description ? (
                  <p className="mt-3 text-sm leading-6 text-pf-deep/65">{identity.description}</p>
                ) : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-pf-light bg-pf-surface/50 p-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/55">
                      Access scope
                    </p>
                    <p className="mt-1 font-semibold text-pf-deep">
                      {identity.accessScope.replace(/_/g, ' ')}
                    </p>
                    <p className="mt-2 text-xs text-pf-deep/60">
                      {identity.accessCapabilities.length
                        ? identity.accessCapabilities.join(' · ')
                        : 'No capabilities recorded'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-pf-light bg-pf-surface/50 p-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/55">
                      Autonomy
                    </p>
                    <p className="mt-1 font-semibold text-pf-deep">
                      {identity.autonomyLevel.replace(/_/g, ' ')}
                    </p>
                    <p className="mt-2 text-xs text-pf-deep/60">
                      {identity.autonomousActions.length
                        ? identity.autonomousActions.join(' · ')
                        : 'No autonomous actions recorded'}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-xs text-pf-deep/55">
                  {identity.agentType.replace(/_/g, ' ')} · {identity._count.runs} runs ·{' '}
                  {identity._count.approvalRequests} approvals ·{' '}
                  {identity.defaultModel === AGENT_DIRECT_EXECUTION_ROUTE
                    ? 'Torchiko managed AI / agent-run workload'
                    : [identity.defaultProvider, identity.defaultModel]
                        .filter(Boolean)
                        .join(' / ') || 'No execution route'}
                </p>
                <IdentityConfigurationEditor
                  tenantId={tenantId}
                  venueId={venueId}
                  identity={identity}
                />
                <div>
                  <AgentApprovalPolicyControl
                    tenantId={tenantId}
                    venueId={venueId}
                    identity={identity}
                    policies={approvalPolicies.items.filter(
                      (policy) => policy.agentIdentityId === identity.id,
                    )}
                    outcomeObservations={outcomeObservations.filter(
                      (observation) => observation.agentIdentityId === identity.id,
                    )}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
        {identities.nextCursor ? (
          <Older
            href={cursorHref(base, 'identityCursor', identities.nextCursor)}
            label="Older identities"
          />
        ) : null}
      </section>

      <section id="runs" className="space-y-4" aria-labelledby="agent-runs-heading">
        <div>
          <h3 id="agent-runs-heading" className="text-xl font-semibold text-pf-deep">
            Recent runs
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Lifecycle and bounded operational summaries.
          </p>
        </div>
        {runs.items.length === 0 ? (
          <Empty text="No agent runs are recorded for this venue." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-pf-light bg-white">
            <table className="min-w-[52rem] w-full text-left text-sm">
              <caption className="sr-only">Agent run history</caption>
              <thead className="border-b border-pf-light bg-pf-surface/50 text-xs uppercase tracking-wider text-pf-deep/55">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Run
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Evidence
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Cost
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.items.map((run) => (
                  <tr key={run.id} className="border-b border-pf-light last:border-0">
                    <td className="px-4 py-4">
                      <Link
                        href={`${base}/runs/${run.id}`}
                        className="font-semibold text-pf-primary hover:text-pf-accent"
                      >
                        {run.agentIdentity.name}
                      </Link>
                      <p className="mt-1 text-xs text-pf-deep/55">
                        {run.requestedOperation} · {run.runType}
                      </p>
                      {run.requestPrompt ? (
                        <p className="mt-2 max-w-md line-clamp-2 text-xs text-pf-deep/70">
                          {run.requestPrompt}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-4">
                      <Badge
                        tone={
                          run.status === 'COMPLETED'
                            ? 'green'
                            : run.status === 'FAILED'
                              ? 'rose'
                              : 'amber'
                        }
                      >
                        {run.status.replace(/_/g, ' ')}
                      </Badge>
                      {run.errorCode ? (
                        <p className="mt-2 text-xs text-rose-700">{run.errorCode}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-4 text-xs text-pf-deep/65">
                      {run._count.actions} actions · {run._count.timelineEvents} events ·{' '}
                      {run._count.approvalRequests} approvals
                    </td>
                    <td className="px-4 py-4 font-mono text-xs text-pf-deep">
                      {formatAgentRunCost(run.costE8Usd, run.costStatus)}
                    </td>
                    <td className="px-4 py-4 text-xs text-pf-deep/55">
                      {run.createdAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runs.nextCursor ? (
          <Older href={cursorHref(base, 'runCursor', runs.nextCursor)} label="Older runs" />
        ) : null}
      </section>

      <section id="integrations" className="space-y-4" aria-labelledby="agent-integrations-heading">
        <div>
          <h3 id="agent-integrations-heading" className="text-xl font-semibold text-pf-deep">
            AI integrations
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Choose a provider per specialist. Connection secrets stay outside this page; status
            never implies authentication.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[
            {
              name: 'Claude API',
              provider: 'anthropic',
              state: runtime.agentRunnerEnabled ? 'Runtime enabled' : 'Runtime paused',
              detail: 'Native budgeted text execution through the worker.',
            },
            {
              name: 'Hermes',
              provider: 'hermes-bridge',
              state: 'Bridge required',
              detail: 'For local specialists, skills, MCP tools, and Telegram-directed work.',
            },
            {
              name: 'Claude subscription',
              provider: 'claude-bridge',
              state: 'Bridge required',
              detail:
                'Uses a user-controlled local runner; Torchiko never borrows browser credentials.',
            },
            {
              name: 'Codex subscription',
              provider: 'codex-bridge',
              state: 'Bridge required',
              detail:
                'Routes coding tasks to an authenticated desktop runner with durable evidence.',
            },
            {
              name: 'Local / OpenAI-compatible',
              provider: 'openai-compatible-bridge',
              state: 'Bridge required',
              detail: 'For Ollama, llama.cpp, or another operator-approved local endpoint.',
            },
          ].map((integration) => {
            const expectedBridgeProvider = bridgeProviderForIdentityProvider[integration.provider]
            const connected =
              integration.provider === 'anthropic'
                ? runtime.agentRunnerEnabled
                : Boolean(
                    expectedBridgeProvider && onlineBridgeProviders.has(expectedBridgeProvider),
                  )
            const state = connected
              ? integration.provider === 'anthropic'
                ? 'Runtime enabled'
                : 'Runner online'
              : integration.state
            return (
              <article
                key={integration.provider}
                className="rounded-2xl border border-pf-light bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="font-semibold text-pf-deep">{integration.name}</h4>
                  <Badge tone={connected ? 'green' : 'amber'}>{state}</Badge>
                </div>
                <p className="mt-3 text-sm leading-6 text-pf-deep/65">{integration.detail}</p>
                <p className="mt-3 font-mono text-xs text-pf-deep/50">{integration.provider}</p>
              </article>
            )
          })}
        </div>
        <div className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="font-semibold text-pf-deep">Connected runner sessions</h4>
              <p className="mt-1 text-sm text-pf-deep/60">
                Short-lived presence records; expired heartbeats are treated as offline.
              </p>
            </div>
            <Badge
              tone={
                bridgeSessions.some(
                  (session) => session.status === 'ONLINE' && session.expiresAt > now,
                )
                  ? 'green'
                  : 'slate'
              }
            >
              {
                bridgeSessions.filter(
                  (session) => session.status === 'ONLINE' && session.expiresAt > now,
                ).length
              }{' '}
              online
            </Badge>
          </div>
          {bridgeSessions.length ? (
            <ul className="mt-4 divide-y divide-pf-light">
              {bridgeSessions.map((session) => {
                const online = session.status === 'ONLINE' && session.expiresAt > now
                return (
                  <li
                    key={session.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      <p className="font-semibold text-pf-deep">{session.label}</p>
                      <p className="mt-1 text-xs text-pf-deep/55">
                        {session.provider.replace(/_/g, ' ')} · runner {session.runnerVersion} ·{' '}
                        {session._count.agentRuns} claimed runs
                      </p>
                      <p className="mt-1 text-xs text-pf-deep/50">
                        {session.supportedModels.length
                          ? session.supportedModels.join(' · ')
                          : 'Any configured model'}
                      </p>
                    </div>
                    <div className="text-right">
                      <Badge tone={online ? 'green' : 'slate'}>
                        {online ? 'Online' : 'Offline'}
                      </Badge>
                      <p className="mt-2 text-xs text-pf-deep/50">
                        Heartbeat {session.lastHeartbeatAt.toLocaleString()}
                      </p>
                      <AgentBridgeSessionControl
                        tenantId={tenantId}
                        venueId={venueId}
                        sessionId={session.id}
                        revoked={session.status === 'REVOKED'}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="mt-4 rounded-2xl border border-dashed border-pf-light p-5 text-sm text-pf-deep/60">
              No authenticated local runner has registered for this venue.
            </p>
          )}
        </div>
        <Link
          href={`${base}/integrations`}
          className="inline-flex min-h-11 items-center rounded-2xl bg-pf-primary px-5 text-sm font-semibold text-white"
        >
          Open integration control room
        </Link>
      </section>

      <section id="approvals" className="space-y-4" aria-labelledby="approval-state-heading">
        <div>
          <h3 id="approval-state-heading" className="text-xl font-semibold text-pf-deep">
            Approval state
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Pending, resolved, and expired requests. This surface is observational only.
          </p>
        </div>
        {approvals.items.length === 0 ? (
          <Empty text="No approval requests are recorded for this venue." />
        ) : (
          <ul className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-white px-5">
            {approvals.items.map((approval) => (
              <li key={approval.id} className="py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      approval.state === 'PENDING'
                        ? 'amber'
                        : approval.state === 'APPROVED'
                          ? 'green'
                          : 'slate'
                    }
                  >
                    {approval.state.replace(/_/g, ' ')}
                  </Badge>
                  <Badge
                    tone={
                      approval.riskCategory === 'CRITICAL' || approval.riskCategory === 'HIGH'
                        ? 'rose'
                        : 'slate'
                    }
                  >
                    {approval.riskCategory} risk
                  </Badge>
                  <span className="text-xs text-pf-deep/55">{approval.agentIdentity.name}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-pf-deep">{approval.proposedAction}</p>
                <p className="mt-1 text-sm text-pf-deep/65">{approval.reason}</p>
                <CustomerAccessApprovalContext
                  tenantId={tenantId}
                  venueId={venueId}
                  request={approval.customerAccessRequest}
                />
                <SupportCompletionApprovalContext proposal={approval.supportCompletionProposal} />
                {approval.state === 'PENDING' ? (
                  <ApprovalDecisionForm
                    tenantId={tenantId}
                    venueId={venueId}
                    approvalRequestId={approval.id}
                    proposedAction={approval.proposedAction}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {approvals.nextCursor ? (
          <Older
            href={cursorHref(base, 'approvalCursor', approvals.nextCursor)}
            label="Older approvals"
          />
        ) : null}
      </section>
    </div>
  )
}

function IdentityConfigurationEditor({
  tenantId,
  venueId,
  identity,
}: {
  tenantId: string
  venueId: string
  identity: Identity
}) {
  const fields = AgentIdentityConfigurationFields.safeParse(identity)
  if (!fields.success) {
    return (
      <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
        This legacy identity uses authority values outside the staged allowlist. It can be reviewed
        here but requires a separate migration before it can use this editor.
      </p>
    )
  }
  return (
    <AgentIdentityEditEditor
      tenantId={tenantId}
      venueId={venueId}
      identity={{
        id: identity.id,
        enabled: identity.enabled,
        updatedAt: identity.updatedAt,
        ...fields.data,
        defaultProvider: fields.data.defaultProvider ?? null,
        defaultModel: fields.data.defaultModel ?? null,
      }}
    />
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-pf-light bg-white p-8 text-center text-sm text-pf-deep/65">
      {text}
    </div>
  )
}
function Older({ href, label }: { href: string; label: string }) {
  return (
    <div className="flex justify-end">
      <Link
        href={href}
        className="inline-flex min-h-11 items-center rounded-2xl border border-pf-light bg-white px-5 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
      >
        {label}
      </Link>
    </div>
  )
}
