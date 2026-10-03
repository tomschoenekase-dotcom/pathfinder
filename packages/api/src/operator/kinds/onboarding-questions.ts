import { createHash } from 'node:crypto'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  ClientNotificationError,
  createClientNotificationIntent,
  createClientOnboardingQuestionAction,
  expireAgentQuestionIfDue,
  OnboardingQuestionActionError,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { operatorUntrustedText, redactAddresses } from '../crm-projection'
import { assertTenantInGrant, assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  dispatchNotificationEmail,
  dispatchQueuedForRequest,
  prepareNotificationEmail,
  type NotificationEmailLabel,
} from '../notifications'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorProposalKind,
} from '../proposals'

const input = OPERATOR_MCP_INPUTS['customers.propose_onboarding_questions']
type Args = ReturnType<typeof input.parse>

// Proposal identity is server-owned and globally unique; client operation IDs are only grant-unique.
export function onboardingQuestionOperationId(proposalId: string, questionId: string): string {
  const hex = createHash('sha256').update(`${proposalId}:${questionId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function questions(args: Args, database: OperatorDatabase) {
  return database.agentQuestion.findMany({
    where: {
      tenantId: args.tenantId,
      venueId: args.venueId,
      id: { in: args.questions.map((q) => q.questionId) },
    },
    select: {
      id: true,
      question: true,
      updatedAt: true,
      status: true,
      blocking: true,
      expiresAt: true,
      agentRun: { select: { status: true } },
      onboardingLink: { select: { id: true } },
    },
  })
}

const version = (items: { questionId: string; expectedUpdatedAt: string }[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        items.map((q) => [q.questionId, new Date(q.expectedUpdatedAt).toISOString()]).sort(),
      ),
    )
    .digest('hex')

function outcome(
  links: { id: string; agentQuestionId: string; supportRequestId: string }[],
  notification?: { intentId: string; email: NotificationEmailLabel },
) {
  const items = links.map((link) => ({
    linkId: link.id,
    questionId: link.agentQuestionId,
    requestId: link.supportRequestId,
  }))
  return {
    result: {
      items,
      // The portal post is immediate; the email follows only where the deployment allows it.
      portalOnly: false,
      portalPosted: true,
      ...(notification ? { notification: { ...notification, portal: 'portal_posted' } } : {}),
      workAuthorized: false,
    },
    after: { items },
  }
}

/** One reviewed group; each question retains its canonical support conversation and receipt. */
export const onboardingQuestionsKind: OperatorProposalKind<Args> = {
  kind: 'customers.onboarding-questions',
  tool: 'customers.propose_onboarding_questions',
  capability: 'customers:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context) => {
    await assertTenantInGrant(context.grant, args.tenantId, context.database)
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    const [rows, member] = await Promise.all([
      questions(args, context.database),
      context.database.tenantMembership.findFirst({
        where: { tenantId: args.tenantId, userId: args.recipientUserId, status: 'ACTIVE' },
        select: { id: true },
      }),
    ])
    if (rows.length !== args.questions.length || !member) throw new OperatorNotFoundError()
  },
  targetVersion: async (args) => version(args.questions),
  currentVersion: async (args, context) => {
    const [rows, member] = await Promise.all([
      questions(args, context.database),
      context.database.tenantMembership.findFirst({
        where: { tenantId: args.tenantId, userId: args.recipientUserId, status: 'ACTIVE' },
        select: { id: true },
      }),
    ])
    if (
      !member ||
      rows.length !== args.questions.length ||
      rows.some(
        (q) =>
          q.status !== 'PENDING' ||
          !q.blocking ||
          q.agentRun?.status !== 'AWAITING_INPUT' ||
          q.onboardingLink,
      )
    )
      return null
    return version(
      rows.map((q) => ({ questionId: q.id, expectedUpdatedAt: q.updatedAt.toISOString() })),
    )
  },
  describe: (args) => ({
    title: `Route ${args.questions.length} onboarding question(s) to the customer portal and, where the deployment allows it, to their verified email`,
    lines: [
      `venue ${args.venueId}`,
      `recipient ${args.recipientUserId}`,
      ...args.questions.flatMap((q) => [
        `question ${q.questionId}: ${q.subject}`,
        `why: ${q.why}`,
        `effect: ${q.effect}`,
        ...(q.whatWasFound ? [`found: ${q.whatWasFound}`] : []),
      ]),
    ],
  }),
  snapshot: async (args, context) => ({
    questions: (await questions(args, context.database)).map((q) => ({
      questionId: q.id,
      updatedAt: q.updatedAt.toISOString(),
      status: q.status,
      question: operatorUntrustedText(redactAddresses(q.question), 2000),
    })),
  }),
  apply: async (args, context: OperatorApplyContext) => {
    // The identity lookup runs before the transaction, never inside it.
    const mail = await prepareNotificationEmail(args.recipientUserId)
    const text = new Map(
      (await questions(args, context.database)).map((row) => [row.id, row.question]),
    )
    const applied = await context.database
      .$transaction(
        async (tx) => {
          // Reuse the canonical action in this transaction so a failed question rolls back the entire group.
          const client = {
            $transaction: (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
          } as Pick<OperatorDatabase, '$transaction'>
          const links: { id: string; agentQuestionId: string; supportRequestId: string }[] = []
          for (const question of args.questions) {
            const saved = await createClientOnboardingQuestionAction(
              {
                operationId: onboardingQuestionOperationId(context.proposalId, question.questionId),
                tenantId: args.tenantId,
                venueId: args.venueId,
                agentQuestionId: question.questionId,
                expectedQuestionUpdatedAt: new Date(question.expectedUpdatedAt),
                recipientUserId: args.recipientUserId,
                category: question.category,
                subject: question.subject,
                why: question.why,
                effect: question.effect,
                ...(question.whatWasFound !== undefined
                  ? { whatWasFound: question.whatWasFound }
                  : {}),
                actor: { actorId: context.actor.id, auditRole: 'PLATFORM_ADMIN' },
              },
              client,
            )
            links.push(saved.link)
          }
          // One intent for the whole approved group, anchored on its first conversation. Each
          // question keeps its own conversation, and the email links to every one of them.
          const first = args.questions[0]!
          const opening = await tx.supportMessage.findFirst({
            where: {
              tenantId: args.tenantId,
              submissionRequestId: onboardingQuestionOperationId(
                context.proposalId,
                first.questionId,
              ),
            },
            select: { id: true },
          })
          if (!opening)
            throw new OperatorStaleError('Onboarding questions changed; refresh the group')
          const { intent } = await createClientNotificationIntent(tx, {
            tenantId: args.tenantId,
            venueId: args.venueId,
            supportRequestId: links[0]!.supportRequestId,
            supportMessageId: opening.id,
            requestVersion: 1,
            questionIds: args.questions.map((question) => question.questionId),
            recipientUserId: args.recipientUserId,
            recipientEmail: mail.recipientEmail,
            emailRequested: true,
            emailEnabled: mail.emailEnabled,
            content: {
              version: 1,
              subject:
                args.questions.length === 1
                  ? 'One question to finish setting up your Torchiko guide'
                  : `${args.questions.length} questions to finish setting up your Torchiko guide`,
              intro:
                'Torchiko needs a few answers from you to finish setting up your venue guide. Each question below opens its own conversation in your dashboard.',
              items: args.questions.map((question, index) => ({
                text: operatorUntrustedText(
                  redactAddresses(text.get(question.questionId) ?? question.subject),
                  2000,
                ).text,
                why: question.why,
                effect: question.effect,
                requestId: links[index]!.supportRequestId,
                questionId: question.questionId,
              })),
            },
            actor: { actorId: context.actor.id, auditRole: 'PLATFORM_ADMIN' },
          })
          return { links, intent }
        },
        { timeout: 30_000 },
      )
      .catch(async (error: unknown) => {
        // These canonical refusals arise from work/recipient state moving after the preview.
        // The enclosing transaction has rolled back every conversation before this is recorded.
        if (error instanceof OnboardingQuestionActionError && error.code === 'EXPIRED') {
          // Preserve the canonical expiry evidence in a fresh transaction after group rollback.
          await context.database.$transaction(async (tx) => {
            for (const question of args.questions) {
              await expireAgentQuestionIfDue(tx, {
                tenantId: args.tenantId,
                venueId: args.venueId,
                questionId: question.questionId,
              })
            }
          })
        }
        if (
          error instanceof OnboardingQuestionActionError &&
          ['CONFLICT', 'EXPIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error.code)
        ) {
          throw new OperatorStaleError('Onboarding questions changed; refresh the group')
        }
        if (error instanceof ClientNotificationError && error.code === 'NOT_FOUND') {
          throw new OperatorStaleError('Onboarding questions changed; refresh the group')
        }
        throw error
      })
    const email = await dispatchNotificationEmail(context.database, applied.intent)
    return outcome(applied.links, { intentId: applied.intent.id, email })
  },
  reconcile: async (args, context) => {
    const links = await context.database.onboardingQuestionLink.findMany({
      where: {
        tenantId: args.tenantId,
        venueId: args.venueId,
        operationId: {
          in: args.questions.map((q) =>
            onboardingQuestionOperationId(context.proposalId, q.questionId),
          ),
        },
      },
      select: { id: true, agentQuestionId: true, supportRequestId: true },
    })
    if (links.length === 0) return { state: 'not_applied' }
    if (links.length !== args.questions.length) return { state: 'unknown' }
    // The group committed. If the apply was cut off before its email was handed to the queue,
    // do that now; the job is keyed by intent and generation, so this can never send twice.
    const email = await dispatchQueuedForRequest(context.database, {
      tenantId: args.tenantId,
      supportRequestId: links[0]!.supportRequestId,
    })
    const intent = await context.database.clientNotificationIntent.findFirst({
      where: { tenantId: args.tenantId, supportRequestId: links[0]!.supportRequestId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    return {
      state: 'applied',
      outcome: outcome(links, intent && email ? { intentId: intent.id, email } : undefined),
    }
  },
}
