import { createHash } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { ProspectActionError, type ProspectActor } from './prospect-actions'

type MergeClient = typeof db
type MergeTx = Parameters<Parameters<MergeClient['$transaction']>[0]>[0]

/** Every direct organization FK is accounted for here or in the special-case inventory below. */
const movableModels = [
  'prospectVenue',
  'prospectContact',
  'prospectCampaignMember',
  'prospectOutreachDraft',
  'prospectEmailThread',
  'prospectEmailMessage',
  'accountRelationshipNote',
  'accountMilestone',
  'accountOpenLoop',
  'accountCommitment',
  'accountSummary',
  'companyKnowledgeItem',
] as const

/** Immutable lineage retains original source FKs and is projected in canonical reads. */
const retainedModels = [
  'prospectActivity',
  'prospectSourceEvidence',
  'prospectInboundReplyReview',
  'prospectOnboardingDeliveryAttempt',
] as const

/** Guarded by a schema-contract test so a new organization FK cannot silently escape merge review. */
export const PROSPECT_MERGE_DIRECT_RELATION_MODELS = [
  ...movableModels,
  ...retainedModels,
  'prospectOrganizationTag',
  'prospectResearchJob',
  'prospectOpportunity',
  'prospectDuplicateCandidate',
  'prospectConversion',
  'prospectCustomerRelationship',
  'publicInterestProspectConversion',
  'prospectFollowup',
  'companyMeeting',
] as const

type MovableModel = (typeof movableModels)[number]
type AccountRelationModel = MovableModel | (typeof retainedModels)[number]
const modelsWithUpdatedAt: ReadonlySet<AccountRelationModel> = new Set([
  'prospectVenue',
  'prospectContact',
  'prospectCampaignMember',
  'prospectEmailThread',
  'prospectOnboardingDeliveryAttempt',
  'accountRelationshipNote',
  'accountOpenLoop',
  'accountCommitment',
  'accountSummary',
  'companyKnowledgeItem',
])
type RelationDelegate = {
  findMany(input: unknown): Promise<Array<{ id: string; updatedAt?: Date }>>
  updateMany(input: unknown): Promise<{ count: number }>
  count(input: unknown): Promise<number>
}

function delegate(tx: MergeTx, model: AccountRelationModel): RelationDelegate {
  return (tx as unknown as Record<AccountRelationModel, RelationDelegate>)[model]
}

export type ProspectOrganizationMergePlan = {
  sourceOrganizationId: string
  targetOrganizationId: string
  planHash: string
  sourceName: string
  targetName: string
  counts: Record<string, number>
  blockers: string[]
  sourceOpportunity: { id: string; stage: string } | null
  targetOpportunity: { id: string; stage: string } | null
}

async function inventory(
  tx: MergeTx,
  sourceOrganizationId: string,
  targetOrganizationId: string,
): Promise<ProspectOrganizationMergePlan> {
  if (sourceOrganizationId === targetOrganizationId) {
    throw new ProspectActionError('INVALID_INPUT', 'Merge source and target must differ')
  }
  const [source, target] = await Promise.all([
    tx.prospectOrganization.findUnique({ where: { id: sourceOrganizationId } }),
    tx.prospectOrganization.findUnique({ where: { id: targetOrganizationId } }),
  ])
  if (!source || !target) throw new ProspectActionError('NOT_FOUND', 'Merge account not found')
  const blockers: string[] = []
  if (source.archivedAt || source.mergedIntoOrganizationId)
    blockers.push('source-is-archived-or-already-merged')
  if (target.archivedAt || target.mergedIntoOrganizationId)
    blockers.push('target-is-archived-or-already-merged')
  if (
    !Array.isArray(source.aliases) ||
    !source.aliases.every((alias) => typeof alias === 'string') ||
    !Array.isArray(target.aliases) ||
    !target.aliases.every((alias) => typeof alias === 'string')
  ) {
    blockers.push('account-aliases-require-review')
  }
  if (
    (await tx.prospectOrganizationMerge.count({
      where: { targetOrganizationId: sourceOrganizationId },
    })) > 0
  ) {
    blockers.push('source-already-has-merged-accounts')
  }

  const counts: Record<string, number> = {}
  const hash = createHash('sha256')
  hash.update(
    JSON.stringify({
      sourceOrganizationId,
      targetOrganizationId,
      sourceUpdatedAt: source.updatedAt,
      targetUpdatedAt: target.updatedAt,
      sourceAliases: source.aliases,
      targetAliases: target.aliases,
    }),
  )
  for (const model of [...movableModels, ...retainedModels]) {
    const relation = delegate(tx, model)
    const select = { id: true, ...(modelsWithUpdatedAt.has(model) ? { updatedAt: true } : {}) }
    const [rows, targetRows] = await Promise.all([
      relation.findMany({
        where: { organizationId: sourceOrganizationId },
        select,
        orderBy: { id: 'asc' },
        take: 10_001,
      }),
      relation.findMany({
        where: { organizationId: targetOrganizationId },
        select,
        orderBy: { id: 'asc' },
        take: 10_001,
      }),
    ])
    counts[model] = rows.length
    if (rows.length > 10_000 || targetRows.length > 10_000)
      blockers.push(`${model}:review-limit-exceeded`)
    hash.update(JSON.stringify([model, rows, targetRows]))
  }
  if (counts.prospectInboundReplyReview)
    blockers.push('inbound-reviews-require-source-bound-message-history')
  if (counts.prospectOnboardingDeliveryAttempt)
    blockers.push('onboarding-attempts-require-source-bound-message-history')
  const [
    inboundMessages,
    activeDrafts,
    activeSendItems,
    activeOutboxes,
    tenantLinked,
    sourceContacts,
    targetContacts,
  ] = await Promise.all([
    tx.prospectEmailMessage.findMany({
      where: {
        organizationId: sourceOrganizationId,
        OR: [
          { direction: 'INBOUND' },
          { direction: 'OUTBOUND', status: { in: ['STAGED', 'QUEUED'] } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    }),
    tx.prospectOutreachDraft.findMany({
      where: {
        organizationId: sourceOrganizationId,
        status: { in: ['NEEDS_REVIEW', 'APPROVED', 'QUEUED'] },
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    }),
    tx.prospectSendItem.findMany({
      where: {
        member: { organizationId: sourceOrganizationId },
        status: { in: ['STAGED', 'QUEUED', 'SENDING', 'AMBIGUOUS'] },
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    }),
    tx.prospectSendOutbox.findMany({
      where: {
        sendItem: { member: { organizationId: sourceOrganizationId } },
        status: { in: ['PENDING', 'CLAIMED', 'RETRYABLE', 'AMBIGUOUS'] },
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    }),
    Promise.all(
      [
        'accountRelationshipNote',
        'accountMilestone',
        'accountOpenLoop',
        'accountCommitment',
        'accountSummary',
        'companyKnowledgeItem',
      ].map(async (model) => ({
        model,
        count: await (tx as unknown as Record<string, RelationDelegate>)[model]!.count({
          where: {
            organizationId: sourceOrganizationId,
            OR: [
              { tenantId: { not: null } },
              ...(model === 'accountSummary' ? [] : [{ venueId: { not: null } }]),
            ],
          },
        }),
      })),
    ),
    tx.prospectContact.findMany({
      where: { organizationId: sourceOrganizationId, normalizedEmail: { not: null } },
      select: {
        id: true,
        normalizedEmail: true,
        doNotContact: true,
        permissionState: true,
        unsubscribedAt: true,
        complainedAt: true,
        lastHardBounceAt: true,
      },
    }),
    tx.prospectContact.findMany({
      where: { organizationId: targetOrganizationId, normalizedEmail: { not: null } },
      select: {
        id: true,
        normalizedEmail: true,
        doNotContact: true,
        permissionState: true,
        unsubscribedAt: true,
        complainedAt: true,
        lastHardBounceAt: true,
      },
    }),
  ])
  hash.update(
    JSON.stringify([
      'active-lineage',
      inboundMessages,
      activeDrafts,
      activeSendItems,
      activeOutboxes,
      tenantLinked,
      sourceContacts,
      targetContacts,
    ]),
  )
  if (inboundMessages.length)
    blockers.push(
      `inbound-or-unsettled-messages-require-source-bound-history:${inboundMessages.length}`,
    )
  if (activeDrafts.length) blockers.push(`active-outreach-drafts:${activeDrafts.length}`)
  if (activeSendItems.length) blockers.push(`active-send-items:${activeSendItems.length}`)
  if (activeOutboxes.length) blockers.push(`active-send-outbox:${activeOutboxes.length}`)
  for (const row of tenantLinked)
    if (row.count) blockers.push(`${row.model}:tenant-linked-context:${row.count}`)
  // Two contacts with one email can carry different suppression/permission histories. A
  // physical account merge must not make the weaker identity available for later outreach.
  for (const sourceContact of sourceContacts) {
    const collision = targetContacts.find(
      (targetContact) => targetContact.normalizedEmail === sourceContact.normalizedEmail,
    )
    if (collision) blockers.push(`contact-email-collision:${sourceContact.id}:${collision.id}`)
  }
  const [sourceOpportunity, targetOpportunity] = await Promise.all([
    tx.prospectOpportunity.findUnique({
      where: { organizationId: sourceOrganizationId },
    }),
    tx.prospectOpportunity.findUnique({
      where: { organizationId: targetOrganizationId },
    }),
  ])
  counts.prospectOpportunity = sourceOpportunity ? 1 : 0
  hash.update(JSON.stringify(['opportunities', sourceOpportunity, targetOpportunity]))
  if (
    sourceOpportunity &&
    targetOpportunity &&
    ['DO_NOT_CONTACT', 'LOST', 'PARKED'].includes(sourceOpportunity.stage) &&
    targetOpportunity.stage !== sourceOpportunity.stage
  ) {
    blockers.push(
      `source-stop-stage-would-be-weakened:${sourceOpportunity.stage}:${targetOpportunity.stage}`,
    )
  }
  if (sourceOpportunity && targetOpportunity) {
    const [history, followups] = await Promise.all([
      tx.prospectStageHistory.findMany({
        where: { opportunityId: sourceOpportunity.id },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
      tx.prospectFollowup.findMany({
        where: { organizationId: sourceOrganizationId },
        select: { id: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ])
    counts.prospectStageHistory = history.length
    counts.prospectFollowup = followups.length
    hash.update(JSON.stringify(['stageHistory', history, 'followups', followups]))
    const nonterminal = await tx.prospectFollowup.findMany({
      where: {
        organizationId: sourceOrganizationId,
        status: { notIn: ['CANCELLED', 'COMPLETED', 'SENT'] },
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    })
    hash.update(JSON.stringify(['nonterminalFollowups', nonterminal]))
    if (nonterminal.length) blockers.push(`active-followups:${nonterminal.length}`)
  } else {
    counts.prospectStageHistory = 0
    counts.prospectFollowup = await tx.prospectFollowup.count({
      where: { organizationId: sourceOrganizationId },
    })
    if (counts.prospectFollowup) blockers.push('opportunity-required-for-followups')
  }

  const specialModels = [
    'prospectResearchJob',
    'prospectConversion',
    'prospectCustomerRelationship',
    'publicInterestProspectConversion',
  ] as const
  for (const model of specialModels) {
    const count = await (tx as unknown as Record<string, RelationDelegate>)[model]!.count({
      where: { organizationId: sourceOrganizationId },
    })
    counts[model] = count
    if (count) blockers.push(`${model}:requires-separate-reviewed-resolution`)
    hash.update(JSON.stringify([model, count]))
  }
  const [
    candidateA,
    candidateB,
    sourceTags,
    targetTags,
    sourceSummaries,
    targetSummaries,
    sourceMembers,
    targetMembers,
  ] = await Promise.all([
    tx.prospectDuplicateCandidate.count({ where: { organizationAId: sourceOrganizationId } }),
    tx.prospectDuplicateCandidate.count({ where: { organizationBId: sourceOrganizationId } }),
    tx.prospectOrganizationTag.findMany({
      where: { organizationId: sourceOrganizationId },
      select: { tagId: true },
    }),
    tx.prospectOrganizationTag.findMany({
      where: { organizationId: targetOrganizationId },
      select: { tagId: true },
    }),
    tx.accountSummary.findMany({
      where: { organizationId: sourceOrganizationId },
      select: { version: true },
    }),
    tx.accountSummary.findMany({
      where: { organizationId: targetOrganizationId },
      select: { version: true },
    }),
    tx.prospectCampaignMember.findMany({
      where: { organizationId: sourceOrganizationId },
      select: { id: true, campaignId: true, contactId: true },
    }),
    tx.prospectCampaignMember.findMany({
      where: { organizationId: targetOrganizationId },
      select: { id: true, campaignId: true, contactId: true },
    }),
  ])
  counts.prospectDuplicateCandidate = candidateA + candidateB
  counts.prospectOrganizationTag = sourceTags.length
  const sourceMeetings = await tx.companyMeeting.findMany({
    where: { organizationId: sourceOrganizationId },
    select: { id: true, updatedAt: true },
    orderBy: { id: 'asc' },
  })
  counts.companyMeeting = sourceMeetings.length
  hash.update(JSON.stringify(['companyMeetings', sourceMeetings]))
  hash.update(JSON.stringify(['special', candidateA, candidateB, sourceTags, targetTags]))
  hash.update(JSON.stringify(['summaryVersions', sourceSummaries, targetSummaries]))
  hash.update(JSON.stringify(['campaignMemberships', sourceMembers, targetMembers]))
  const tagCollisions = sourceTags.filter((tag) =>
    targetTags.some((existing) => existing.tagId === tag.tagId),
  )
  if (tagCollisions.length)
    blockers.push(`tag-collision:${tagCollisions.map((tag) => tag.tagId).join(',')}`)
  const summaryCollisions = sourceSummaries.filter((summary) =>
    targetSummaries.some((existing) => existing.version === summary.version),
  )
  if (summaryCollisions.length)
    blockers.push(
      `summary-version-collision:${summaryCollisions.map((row) => row.version).join(',')}`,
    )
  const memberCollisions = sourceMembers.filter(
    (member) =>
      member.contactId !== null &&
      targetMembers.some(
        (existing) =>
          existing.campaignId === member.campaignId && existing.contactId === member.contactId,
      ),
  )
  if (memberCollisions.length)
    blockers.push(`campaign-member-collision:${memberCollisions.map((row) => row.id).join(',')}`)
  const activeMembers = await tx.prospectCampaignMember.findMany({
    where: {
      organizationId: sourceOrganizationId,
      status: { in: ['SELECTED', 'DRAFTED', 'NEEDS_REVIEW', 'APPROVED', 'QUEUED'] },
    },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
  })
  const tenantLinkedMeetings = await tx.companyMeeting.findMany({
    where: {
      organizationId: sourceOrganizationId,
      OR: [{ tenantId: { not: null } }, { venueId: { not: null } }],
    },
    select: { id: true, updatedAt: true },
    orderBy: { id: 'asc' },
  })
  hash.update(
    JSON.stringify(['activeMembers', activeMembers, 'tenantLinkedMeetings', tenantLinkedMeetings]),
  )
  if (activeMembers.length) blockers.push(`active-campaign-members:${activeMembers.length}`)
  if (tenantLinkedMeetings.length)
    blockers.push(`companyMeeting:tenant-linked-context:${tenantLinkedMeetings.length}`)

  return {
    sourceOrganizationId,
    targetOrganizationId,
    planHash: hash.digest('hex'),
    sourceName: source.canonicalName,
    targetName: target.canonicalName,
    counts,
    blockers,
    sourceOpportunity: sourceOpportunity
      ? { id: sourceOpportunity.id, stage: sourceOpportunity.stage }
      : null,
    targetOpportunity: targetOpportunity
      ? { id: targetOpportunity.id, stage: targetOpportunity.stage }
      : null,
  }
}

export async function previewProspectOrganizationMergeAction(
  input: { sourceOrganizationId: string; targetOrganizationId: string },
  client: MergeClient = db,
): Promise<ProspectOrganizationMergePlan> {
  try {
    return await client.$transaction(
      (tx) => inventory(tx, input.sourceOrganizationId, input.targetOrganizationId),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'P2034') {
      throw new ProspectActionError('CONFLICT', 'Accounts changed during merge; review again')
    }
    throw error
  }
}

export async function mergeProspectOrganizationsAction(
  input: {
    sourceOrganizationId: string
    targetOrganizationId: string
    expectedPlanHash: string
    note: string
    actor: ProspectActor
  },
  client: MergeClient = db,
) {
  if (input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN' || !input.actor.id) {
    throw new ProspectActionError('INVALID_INPUT', 'A platform administrator must approve merge')
  }
  if (!input.note.trim() || input.note.length > 2000) {
    throw new ProspectActionError('INVALID_INPUT', 'A bounded review note is required')
  }
  if (!/^[a-f0-9]{64}$/u.test(input.expectedPlanHash)) {
    throw new ProspectActionError('INVALID_INPUT', 'Expected merge plan hash is invalid')
  }
  try {
    return await client.$transaction(
      async (tx) => {
        const replay = await tx.prospectOrganizationMerge.findUnique({
          where: { sourceOrganizationId: input.sourceOrganizationId },
        })
        if (replay) {
          if (
            replay.targetOrganizationId !== input.targetOrganizationId ||
            replay.planHash !== input.expectedPlanHash
          ) {
            throw new ProspectActionError('CONFLICT', 'Source was merged under another review')
          }
          return { receipt: replay, replayed: true }
        }
        const plan = await inventory(tx, input.sourceOrganizationId, input.targetOrganizationId)
        if (plan.planHash !== input.expectedPlanHash) {
          throw new ProspectActionError(
            'CONFLICT',
            'Merge preview is stale; review the accounts again',
          )
        }
        if (plan.blockers.length) {
          throw new ProspectActionError(
            'UNSAFE_MERGE',
            `Merge blocked: ${plan.blockers.join('; ')}`,
          )
        }
        const [source, target, sourceOpportunity, targetOpportunity] = await Promise.all([
          tx.prospectOrganization.findUniqueOrThrow({
            where: { id: input.sourceOrganizationId },
          }),
          tx.prospectOrganization.findUniqueOrThrow({
            where: { id: input.targetOrganizationId },
          }),
          tx.prospectOpportunity.findUnique({
            where: { organizationId: input.sourceOrganizationId },
          }),
          tx.prospectOpportunity.findUnique({
            where: { organizationId: input.targetOrganizationId },
          }),
        ])
        const movedCounts: Record<string, number> = {}
        for (const model of movableModels) {
          const moved = await delegate(tx, model).updateMany({
            where: { organizationId: input.sourceOrganizationId },
            data: { organizationId: input.targetOrganizationId },
          })
          movedCounts[model] = moved.count
          if (moved.count !== plan.counts[model]) {
            throw new ProspectActionError('CONFLICT', `${model} changed during merge`)
          }
        }
        for (const model of retainedModels) {
          const retained = await delegate(tx, model).count({
            where: { organizationId: input.sourceOrganizationId },
          })
          if (retained !== plan.counts[model]) {
            throw new ProspectActionError('CONFLICT', `${model} history changed during merge`)
          }
          movedCounts[`${model}Retained`] = retained
        }
        const movedTags = await tx.prospectOrganizationTag.updateMany({
          where: { organizationId: input.sourceOrganizationId },
          data: { organizationId: input.targetOrganizationId },
        })
        movedCounts.prospectOrganizationTag = movedTags.count
        if (movedTags.count !== plan.counts.prospectOrganizationTag) {
          throw new ProspectActionError('CONFLICT', 'Tags changed during merge')
        }
        if (sourceOpportunity && targetOpportunity) {
          // Historical stages remain attached to the archived source opportunity. The
          // account read projects them beside the target history without falsifying its
          // current pipeline state or destroying the original opportunity identity.
          movedCounts.sourceStageHistoryRetained = plan.counts.prospectStageHistory ?? 0
          movedCounts.prospectFollowup = (
            await tx.prospectFollowup.updateMany({
              where: { organizationId: input.sourceOrganizationId },
              data: {
                organizationId: input.targetOrganizationId,
                opportunityId: targetOpportunity.id,
              },
            })
          ).count
          await tx.companyMeeting.updateMany({
            where: { opportunityId: sourceOpportunity.id },
            data: { opportunityId: targetOpportunity.id },
          })
        } else if (sourceOpportunity) {
          await tx.prospectOpportunity.update({
            where: { id: sourceOpportunity.id },
            data: { organizationId: input.targetOrganizationId },
          })
        }
        movedCounts.companyMeeting = (
          await tx.companyMeeting.updateMany({
            where: { organizationId: input.sourceOrganizationId },
            data: { organizationId: input.targetOrganizationId },
          })
        ).count
        if (movedCounts.companyMeeting !== plan.counts.companyMeeting) {
          throw new ProspectActionError('CONFLICT', 'Meetings changed during merge')
        }

        if (
          (await tx.prospectOrganizationTag.count({
            where: { organizationId: input.sourceOrganizationId },
          })) !== 0 ||
          (await tx.prospectFollowup.count({
            where: { organizationId: input.sourceOrganizationId },
          })) !== 0 ||
          (await tx.companyMeeting.count({
            where: { organizationId: input.sourceOrganizationId },
          })) !== 0
        ) {
          throw new ProspectActionError('CONFLICT', 'Account relations remain on merge source')
        }

        for (const model of movableModels) {
          if (
            (await delegate(tx, model).count({
              where: { organizationId: input.sourceOrganizationId },
            })) !== 0
          ) {
            throw new ProspectActionError('CONFLICT', `${model} still points to merge source`)
          }
        }
        const aliases = [...(target.aliases as string[]), ...(source.aliases as string[])]
        const names = new Set(
          [...aliases, source.canonicalName].filter(
            (name): name is string => typeof name === 'string',
          ),
        )
        await tx.prospectOrganization.update({
          where: { id: target.id },
          data: { aliases: [...names], updatedBy: input.actor.id },
        })
        const mergedAt = new Date()
        await tx.prospectOrganization.update({
          where: { id: source.id },
          data: {
            archivedAt: mergedAt,
            mergedAt,
            mergedBy: input.actor.id,
            mergedIntoOrganizationId: target.id,
            updatedBy: input.actor.id,
          },
        })
        await tx.prospectActivity.create({
          data: {
            organizationId: target.id,
            type: 'IMPORTED',
            summary: `Reviewed duplicate account merge from ${source.canonicalName}`,
            evidence: {
              sourceOrganizationId: source.id,
              targetOrganizationId: target.id,
              planHash: plan.planHash,
              sourceOpportunityId: sourceOpportunity?.id ?? null,
            },
            actorId: input.actor.id,
          },
        })
        const receipt = await tx.prospectOrganizationMerge.create({
          data: {
            sourceOrganizationId: source.id,
            targetOrganizationId: target.id,
            planHash: plan.planHash,
            sourceSnapshot: JSON.parse(
              JSON.stringify({ organization: source, opportunity: sourceOpportunity }),
            ),
            movedCounts,
            note: input.note.trim(),
            actorId: input.actor.id,
          },
        })
        await writeAuditLogStrict(
          {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: 'admin.prospect_organization.merged',
            targetType: 'ProspectOrganizationMerge',
            targetId: receipt.id,
            beforeState: { sourceOrganizationId: source.id, targetOrganizationId: target.id },
            afterState: { planHash: plan.planHash, movedCounts },
          },
          tx,
        )
        return { receipt, replayed: false }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      },
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'P2034') {
      throw new ProspectActionError('CONFLICT', 'Accounts changed during merge; review again')
    }
    throw error
  }
}
