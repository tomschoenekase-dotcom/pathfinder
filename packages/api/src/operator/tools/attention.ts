import {
  OPERATOR_ATTENTION_CATEGORIES,
  OPERATOR_MCP_INPUTS,
  type OperatorCapability,
} from '@pathfinder/contracts/operator-mcp'

import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant } from '../grants'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import { tenantOrganizationWhere } from './mail'
import { reconcileGeneratingReports } from './reports'

type Key = (typeof OPERATOR_ATTENTION_CATEGORIES)[number]

type Item = {
  recordType: string
  recordId: string
  venueId: string | null
  summary: ReturnType<typeof operatorUntrustedText>
  since: string | null
  nextAction: string
}

/** What one category measured. `unknown` carries its reason; it is never folded into clear. */
type Measured =
  | { kind: 'measured'; count: number; items: Item[]; unknownReason?: string }
  | { kind: 'unknown'; reason: string }

const DAY_MS = 24 * 60 * 60 * 1000
const STALE_SOURCE_DAYS = 180
const NOTICE_WINDOW_HOURS = 72
const STUCK_JOB_HOURS = 6
const REPORT_MIN_AGE_MINUTES = 60

const item = (
  recordType: string,
  recordId: string,
  venueId: string | null,
  summary: string,
  since: Date | null,
  nextAction: string,
): Item => ({
  recordType,
  recordId,
  venueId,
  summary: operatorUntrustedText(summary, 300),
  since: since?.toISOString() ?? null,
  nextAction,
})

type Measure = (context: OperatorCallContext, tenantId: string, limit: number) => Promise<Measured>

const measures: Record<Key, { label: string; capability: OperatorCapability; measure: Measure }> = {
  pending_decisions: {
    label: 'Pending decisions',
    capability: 'operator:read',
    async measure(context, tenantId, limit) {
      const where = {
        grantId: context.grant.grantId,
        targetTenantId: tenantId,
        status: 'PENDING' as const,
        expiresAt: { gt: context.now },
      }
      const [count, rows] = await Promise.all([
        context.database.operatorProposal.count({ where }),
        context.database.operatorProposal.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: limit,
          select: { id: true, planId: true, kind: true, targetVenueId: true, createdAt: true },
        }),
      ])
      return {
        kind: 'measured',
        count,
        items: rows.map((row) =>
          item(
            row.planId ? 'operator_plan' : 'operator_proposal',
            row.planId ?? row.id,
            row.targetVenueId,
            `${row.kind} is waiting for a person`,
            row.createdAt,
            'Show the approve link to the person. Do not retry; it applies only when they approve.',
          ),
        ),
      }
    },
  },
  blocking_questions: {
    label: 'Unanswered blocking questions',
    capability: 'support:read',
    async measure(context, tenantId, limit) {
      const where = {
        tenantId,
        status: 'PENDING' as const,
        blocking: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: context.now } }],
      }
      const [count, rows] = await Promise.all([
        context.database.agentQuestion.count({ where }),
        context.database.agentQuestion.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: limit,
          select: { id: true, venueId: true, question: true, createdAt: true },
        }),
      ])
      return {
        kind: 'measured',
        count,
        items: rows.map((row) =>
          item(
            'agent_question',
            row.id,
            row.venueId,
            row.question,
            row.createdAt,
            'The blocked work waits for an answer from the customer or an operator; do not answer for them.',
          ),
        ),
      }
    },
  },
  failed_operations: {
    label: 'Failed or unknown operations',
    capability: 'operator:read',
    async measure(context, tenantId, limit) {
      const where = {
        grantId: context.grant.grantId,
        targetTenantId: tenantId,
        OR: [
          {
            status: 'FAILED' as const,
            createdAt: { gte: new Date(context.now.getTime() - 14 * DAY_MS) },
          },
          {
            status: 'APPROVED' as const,
            applyStartedAt: { not: null },
            leaseExpiresAt: { lt: context.now },
          },
        ],
      }
      const [count, rows] = await Promise.all([
        context.database.operatorProposal.count({ where }),
        context.database.operatorProposal.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit,
          select: {
            id: true,
            kind: true,
            status: true,
            failureCode: true,
            targetVenueId: true,
            createdAt: true,
          },
        }),
      ])
      return {
        kind: 'measured',
        count,
        items: rows.map((row) =>
          row.status === 'FAILED'
            ? item(
                'operator_proposal',
                row.id,
                row.targetVenueId,
                `${row.kind} failed (${row.failureCode ?? 'no code'})`,
                row.createdAt,
                'Read it with operator.get_operation. Propose a new change only if it is still wanted.',
              )
            : item(
                'operator_proposal',
                row.id,
                row.targetVenueId,
                `${row.kind} was interrupted mid-apply; its effect is unknown`,
                row.createdAt,
                'Run operator.recover_operation so reconciliation decides, not a guess.',
              ),
        ),
      }
    },
  },
  failed_jobs: {
    label: 'Failed or stuck jobs',
    capability: 'operator:read',
    async measure(context, tenantId, limit) {
      const where = {
        tenantId,
        createdAt: { gte: new Date(context.now.getTime() - 7 * DAY_MS) },
        OR: [
          { status: 'FAILED' as const, failureDisposition: null },
          {
            status: 'FAILED' as const,
            failureDisposition: { in: ['ATTEMPTS_EXHAUSTED' as const, 'UNRECOVERABLE' as const] },
          },
          {
            status: 'RUNNING' as const,
            startedAt: { lt: new Date(context.now.getTime() - STUCK_JOB_HOURS * 3_600_000) },
          },
        ],
      }
      const [count, rows] = await Promise.all([
        context.database.jobRecord.count({ where }),
        context.database.jobRecord.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit,
          select: {
            id: true,
            queue: true,
            jobName: true,
            status: true,
            venueId: true,
            startedAt: true,
          },
        }),
      ])
      return {
        kind: 'measured',
        count,
        items: rows.map((row) =>
          item(
            'job_record',
            row.id,
            row.venueId,
            row.status === 'FAILED'
              ? `${row.queue} ${row.jobName} failed with no retry left`
              : `${row.queue} ${row.jobName} has been running over ${STUCK_JOB_HOURS} hours; whether it is alive is unknown`,
            row.startedAt,
            row.status === 'FAILED'
              ? 'Read the job error, then retry through the owning workflow if it is still wanted.'
              : 'Check the worker; do not assume it failed or that it is working.',
          ),
        ),
      }
    },
  },
  stale_sources: {
    label: 'Stale sources',
    capability: 'venues:read',
    async measure(context, tenantId, limit) {
      const cutoff = new Date(context.now.getTime() - STALE_SOURCE_DAYS * DAY_MS)
      const entry = { tenantId, isEnabled: true }
      const place = { tenantId, isActive: true }
      const [staleEntries, staleLimit, unreviewedEntries, stalePlaces, unreviewedPlaces] =
        await Promise.all([
          context.database.venueKnowledgeEntry.count({
            where: { ...entry, lastReviewedAt: { lt: cutoff } },
          }),
          context.database.venueKnowledgeEntry.findMany({
            where: { ...entry, lastReviewedAt: { lt: cutoff } },
            orderBy: [{ lastReviewedAt: 'asc' }, { id: 'asc' }],
            take: limit,
            select: { id: true, venueId: true, title: true, lastReviewedAt: true },
          }),
          context.database.venueKnowledgeEntry.count({ where: { ...entry, lastReviewedAt: null } }),
          context.database.place.count({ where: { ...place, lastReviewedAt: { lt: cutoff } } }),
          context.database.place.count({ where: { ...place, lastReviewedAt: null } }),
        ])
      const unreviewed = unreviewedEntries + unreviewedPlaces
      return {
        kind: 'measured',
        count: staleEntries + stalePlaces,
        items: staleLimit.map((row) =>
          item(
            'venue_knowledge_entry',
            row.id,
            row.venueId,
            `${row.title} was last reviewed over ${STALE_SOURCE_DAYS} days ago`,
            row.lastReviewedAt,
            'Have a person review it, or propose an update with venues.propose_knowledge.',
          ),
        ),
        ...(unreviewed > 0
          ? {
              unknownReason: `${unreviewed} enabled source(s) have never recorded a review date, so their freshness is unknown.`,
            }
          : {}),
      }
    },
  },
  expiring_notices: {
    label: 'Expiring notices',
    capability: 'venues:read',
    async measure(context, tenantId, limit) {
      const where = {
        tenantId,
        status: 'PUBLISHED' as const,
        isActive: true,
        expiresAt: {
          gt: context.now,
          lte: new Date(context.now.getTime() + NOTICE_WINDOW_HOURS * 3_600_000),
        },
      }
      const [count, rows] = await Promise.all([
        context.database.operationalUpdate.count({ where }),
        context.database.operationalUpdate.findMany({
          where,
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          take: limit,
          select: { id: true, venueId: true, title: true, expiresAt: true },
        }),
      ])
      return {
        kind: 'measured',
        count,
        items: rows.map((row) =>
          item(
            'operational_update',
            row.id,
            row.venueId,
            `${row.title} expires ${row.expiresAt.toISOString()}`,
            row.expiresAt,
            'Decide before it lapses: end it with venues.propose_operational_update_end or replace it.',
          ),
        ),
      }
    },
  },
  mail_reconciliation: {
    label: 'Mail reconciliation failures',
    capability: 'crm:read',
    async measure(context, tenantId, limit) {
      const where = {
        organization: tenantOrganizationWhere(tenantId),
        direction: 'OUTBOUND' as const,
        OR: [
          {
            status: {
              in: [
                'FAILED' as const,
                'BOUNCED' as const,
                'COMPLAINED' as const,
                'DELAYED' as const,
              ],
            },
            occurredAt: { gte: new Date(context.now.getTime() - 14 * DAY_MS) },
          },
          {
            status: { in: ['STAGED' as const, 'QUEUED' as const] },
            createdAt: { lt: new Date(context.now.getTime() - DAY_MS) },
          },
        ],
      }
      const [count, rows] = await Promise.all([
        context.database.prospectEmailMessage.count({ where }),
        context.database.prospectEmailMessage.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: limit,
          select: { id: true, status: true, occurredAt: true },
        }),
      ])
      return {
        kind: 'measured',
        count,
        items: rows.map((row) =>
          item(
            'mail_message',
            row.id,
            null,
            `An outbound message is ${row.status} and has not reconciled to a delivered state`,
            row.occurredAt,
            'Read it with crm.list_mail_messages and crm.list_mail_receipts. Do not resend until the outcome is known.',
          ),
        ),
      }
    },
  },
  generating_reports: {
    label: 'Long-running reports',
    capability: 'reports:read',
    async measure(context, tenantId, limit) {
      const cutoff = new Date(context.now.getTime() - REPORT_MIN_AGE_MINUTES * 60_000)
      const [count, page] = await Promise.all([
        context.database.weeklyReport.count({
          where: { tenantId, status: 'GENERATING', createdAt: { lte: cutoff } },
        }),
        reconcileGeneratingReports(context, {
          tenantId,
          minAgeMinutes: REPORT_MIN_AGE_MINUTES,
          limit,
        }),
      ])
      return {
        kind: 'measured',
        count,
        items: page.items.map((row) =>
          item(
            'weekly_report',
            row.reportId,
            row.venueId,
            `GENERATING ${row.ageMinutes} minutes: ${row.classification}. ${row.reason}`,
            new Date(row.createdAt),
            row.nextAction,
          ),
        ),
      }
    },
  },
  billing_exceptions: {
    label: 'Billing exceptions',
    capability: 'billing:read',
    async measure(context, tenantId) {
      const account = await context.database.billingAccount.findFirst({
        where: { tenantId },
        select: { id: true, status: true, reconciliationHealth: true, updatedAt: true },
      })
      if (!account) return { kind: 'unknown', reason: 'This tenant has no billing account record.' }
      const exceptionStatus = ['PAST_DUE', 'UNPAID', 'MANUAL_REVIEW'].includes(account.status)
      const exceptionHealth = ['STALE', 'DRIFT', 'ERROR'].includes(account.reconciliationHealth)
      if (exceptionStatus || exceptionHealth) {
        return {
          kind: 'measured',
          count: 1,
          items: [
            item(
              'billing_account',
              account.id,
              null,
              `Billing is ${account.status} and reconciliation is ${account.reconciliationHealth}`,
              account.updatedAt,
              'Read it with billing.get_status. A person resolves billing; no tool changes it.',
            ),
          ],
        }
      }
      if (account.reconciliationHealth === 'UNKNOWN') {
        return { kind: 'unknown', reason: 'Billing reconciliation has never been measured.' }
      }
      return { kind: 'measured', count: 0, items: [] }
    },
  },
}

/** Pure projection so the unknown / clear / attention rule is tested in one place. */
export function attentionState(measured: Measured): 'clear' | 'attention' | 'unknown' {
  if (measured.kind === 'unknown') return 'unknown'
  if (measured.count > 0) return 'attention'
  return measured.unknownReason ? 'unknown' : 'clear'
}

const getAttention: OperatorReadTool = {
  name: 'operator.get_attention',
  capability: 'operator:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['operator.get_attention'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const categories = await Promise.all(
      OPERATOR_ATTENTION_CATEGORIES.map(async (key) => {
        const spec = measures[key]
        let measured: Measured
        if (!context.grant.capabilities.includes(spec.capability)) {
          measured = {
            kind: 'unknown',
            reason: `This connection was not granted ${spec.capability}, so this was not measured.`,
          }
        } else {
          try {
            measured = await spec.measure(context, input.tenantId, input.limit)
          } catch {
            measured = { kind: 'unknown', reason: 'The measurement failed; try again.' }
          }
        }
        const state = attentionState(measured)
        return {
          key,
          label: spec.label,
          state,
          count: measured.kind === 'measured' ? measured.count : null,
          unknownReason:
            measured.kind === 'unknown' ? measured.reason : (measured.unknownReason ?? null),
          items: measured.kind === 'measured' ? measured.items : [],
          itemsComplete:
            measured.kind === 'measured' ? measured.count <= measured.items.length : false,
        }
      }),
    )
    const total = (state: 'clear' | 'attention' | 'unknown') =>
      categories.filter((category) => category.state === state).length
    return {
      tenantId: input.tenantId,
      asOf: context.now.toISOString(),
      categories,
      totals: { attention: total('attention'), unknown: total('unknown'), clear: total('clear') },
    }
  },
}

export const attentionReadTools: readonly OperatorReadTool[] = [getAttention]
