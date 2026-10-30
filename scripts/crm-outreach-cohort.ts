/** Metadata-only observation cohort. Dry-run default; exact staging identity and plan hash required. */
import { readFile, writeFile } from 'node:fs/promises'
import { PrismaClient, type Prisma } from '@prisma/client'
import {
  reconcileProspectObservedMessageAction,
  recordProspectOutreachEvidenceAction,
  planProspectOutreachEvidence,
} from '../packages/db/src/helpers/prospect-outreach-history'
import {
  bytesDigest,
  COHORT_ACTOR,
  digest,
  operationId,
  stableId,
  stagingGuard,
  validatePlan,
  type CohortPlan,
} from '../packages/db/src/helpers/prospect-outreach-cohort-plan'

const actor = {
  type: 'AGENT' as const,
  id: COHORT_ACTOR,
  capabilities: ['prospects:outreach-history:reconcile'],
}
async function main() {
  stagingGuard(process.env)
  const args = process.argv.slice(2)
  const path = args[args.indexOf('--plan') + 1]
  if (!args.includes('--plan') || !path) throw new Error('PLAN_REQUIRED')
  const raw = await readFile(path, 'utf8'),
    plan = validatePlan(JSON.parse(raw)),
    planSha256 = bytesDigest(raw)
  const apply = args.includes('--apply')
  if (apply && args[args.indexOf('--plan-sha256') + 1] !== planSha256)
    throw new Error('EXACT_PLAN_HASH_REQUIRED')
  const db = new PrismaClient({ log: [] })
  const client = db as unknown as NonNullable<
    Parameters<typeof reconcileProspectObservedMessageAction>[1]
  >
  try {
    const mailboxId = stableId('mailbox', plan.mailboxAddress.toLowerCase())
    const existingMailbox = await db.correspondenceProviderAccount.findUnique({
      where: {
        provider_mailboxAddress: { provider: 'GMAIL', mailboxAddress: plan.mailboxAddress },
      },
    })
    if (
      existingMailbox &&
      (existingMailbox.id !== mailboxId ||
        existingMailbox.connectionStatus !== 'DISCONNECTED' ||
        existingMailbox.deliveryEnabled ||
        existingMailbox.credentialReferenceId ||
        existingMailbox.capabilities.length)
    )
      throw new Error('OBSERVATION_MAILBOX_CONFLICT')
    type Original = Prisma.ProspectOrganizationGetPayload<{
      include: { opportunity: true; contacts: true; activities: true }
    }>
    const resolved: {
      cohort: CohortPlan['cohort'][number]
      id: string
      existing: Original | null
    }[] = []
    for (const cohort of plan.cohort) {
      const t = cohort.target
      const id = t.kind === 'existing' ? t.id : stableId('org', t.normalizedDomain)
      const existing = await db.prospectOrganization.findUnique({
        where: { id },
        include: { opportunity: true, contacts: true, activities: true },
      })
      if (
        t.kind === 'existing' &&
        (!existing ||
          existing.canonicalName !== t.expectedCanonicalName ||
          existing.mergedIntoOrganizationId ||
          existing.archivedAt)
      )
        throw new Error('EXACT_STAGING_ACCOUNT_IDENTITY_CHANGED')
      if (t.kind === 'createObservation') {
        const conflicts = await db.prospectOrganization.findMany({
          where: {
            OR: [
              { normalizedDomain: t.normalizedDomain },
              { canonicalName: { equals: t.canonicalName, mode: 'insensitive' } },
              { contacts: { some: { normalizedEmail: t.verifiedRecipient } } },
            ],
          },
          select: { id: true, canonicalName: true, normalizedDomain: true },
        })
        if (
          conflicts.some((o) => o.id !== id) ||
          (existing &&
            (existing.canonicalName !== t.canonicalName ||
              existing.normalizedDomain !== t.normalizedDomain))
        )
          throw new Error('NEW_OBSERVATION_ACCOUNT_IDENTITY_CONFLICT')
      }
      resolved.push({ cohort, id, existing })
    }
    const originals = resolved
      .filter((r) => r.existing)
      .map((r) => ({
        id: r.id,
        organization: r.existing!,
        contactIds: r.existing!.contacts.map((c) => c.id),
        activityIds: r.existing!.activities.map((a) => a.id),
      }))
    const beforeHashes = originals.map((o) => ({ id: o.id, hash: digest(o.organization) }))
    const counts = async () => ({
      organizations: await db.prospectOrganization.count(),
      contacts: await db.prospectContact.count(),
      messages: await db.prospectEmailMessage.count(),
      threads: await db.prospectEmailThread.count(),
      activities: await db.prospectActivity.count(),
      mailboxes: await db.correspondenceProviderAccount.count(),
    })
    const beforeCounts = await counts()
    const run = async () => {
      await db.correspondenceProviderAccount.upsert({
        where: { id: mailboxId },
        create: {
          id: mailboxId,
          provider: 'GMAIL',
          externalAccountId: mailboxId,
          mailboxAddress: plan.mailboxAddress,
          displayName: 'Staging metadata observation only',
          capabilities: [],
          connectionStatus: 'DISCONNECTED',
          deliveryEnabled: false,
          createdBy: COHORT_ACTOR,
          updatedBy: COHORT_ACTOR,
        },
        update: {},
      })
      for (const { cohort, id } of resolved) {
        const t = cohort.target
        if (t.kind === 'createObservation')
          await db.prospectOrganization.upsert({
            where: { id },
            create: {
              id,
              canonicalName: t.canonicalName,
              normalizedName: t.canonicalName.toLowerCase(),
              normalizedDomain: t.normalizedDomain,
              source: `staging-observation:${plan.sourceReceiptId}`,
              createdBy: COHORT_ACTOR,
              updatedBy: COHORT_ACTOR,
            },
            update: {},
          })
        const contactAddresses = [
          ...new Set(
            cohort.messages
              .flatMap((m) =>
                m.fromAddress === plan.mailboxAddress
                  ? m.toAddresses
                  : m.classification === 'bounce'
                    ? []
                    : [m.fromAddress],
              )
              .filter((a) => a !== plan.mailboxAddress),
          ),
        ]
        for (const address of contactAddresses) {
          const existing = await db.prospectContact.findMany({
            where: { organizationId: id, normalizedEmail: address.toLowerCase() },
          })
          if (existing.length > 1) throw new Error('AMBIGUOUS_CONTACT_IDENTITY')
          if (!existing.length)
            await db.prospectContact.upsert({
              where: { id: stableId('contact', `${id}:${address.toLowerCase()}`) },
              create: {
                id: stableId('contact', `${id}:${address.toLowerCase()}`),
                organizationId: id,
                email: address,
                normalizedEmail: address.toLowerCase(),
                emailReadiness: 'UNKNOWN',
                permissionState: 'UNKNOWN',
                source: `staging-observation:${plan.sourceReceiptId}`,
                createdBy: COHORT_ACTOR,
                updatedBy: COHORT_ACTOR,
              },
              update: {},
            })
        }
        for (const m of cohort.messages)
          await reconcileProspectObservedMessageAction(
            {
              organizationId: id,
              providerAccountId: mailboxId,
              providerMessageId: m.providerMessageId,
              providerThreadId: m.providerThreadId,
              direction: m.fromAddress === plan.mailboxAddress ? 'OUTBOUND' : 'INBOUND',
              occurredAt: new Date(m.occurredAt),
              fromAddress: m.fromAddress,
              toAddresses: m.toAddresses,
              subject: m.subject,
              internetMessageId: m.internetMessageId ?? null,
              inReplyTo: m.inReplyTo ?? null,
              providerLabelIds: m.labels,
              sourceReceiptId: plan.sourceReceiptId,
              sourceReceiptSha256: plan.sourceReceiptSha256,
              classification: m.classification,
              actor,
              dryRun: false,
            },
            client,
          )
        const base = {
          schema: 'prospect-outreach-history/v1',
          reviewerId: COHORT_ACTOR,
          reason: `Observed provider evidence ${plan.sourceReceiptId}; sha256 ${plan.sourceReceiptSha256}`,
        }
        if (cohort.relationship === 'declined')
          await recordProspectOutreachEvidenceAction(
            {
              organizationId: id,
              operationId: operationId(`${planSha256}:${cohort.key}:declined`),
              actor,
              evidence: {
                ...base,
                kind: 'relationship',
                relationship: 'declined',
                deferUntil: null,
              },
            },
            client,
          )
        if (cohort.bounce) {
          const b = cohort.bounce
          const contact = await db.prospectContact.findFirstOrThrow({
            where: { organizationId: id, normalizedEmail: b.recipientAddress.toLowerCase() },
          })
          const observed = await planProspectOutreachEvidence(client, id)
          const m = observed.messages.find(
            (m) => m.providerMessageId === b.originalProviderMessageId,
          )
          if (!m?.providerAccountId || !m.providerMessageId)
            throw new Error('BOUNCE_ORIGINAL_NOT_RECONCILED')
          await recordProspectOutreachEvidenceAction(
            {
              organizationId: id,
              operationId: operationId(`${planSha256}:${cohort.key}:bounce`),
              actor,
              evidence: {
                ...base,
                reason: `${base.reason}; DSN ${b.dsnProviderMessageId}`,
                kind: 'contactHealth',
                contactId: contact.id,
                recipientAddress: b.recipientAddress,
                health: 'bounced',
                binding: {
                  messageId: m.messageId,
                  providerAccountId: m.providerAccountId,
                  providerMessageId: m.providerMessageId,
                  fingerprint: m.fingerprint,
                },
              },
            },
            client,
          )
        }
      }
    }
    let firstCounts = beforeCounts,
      secondCounts = beforeCounts
    if (apply) {
      await run()
      firstCounts = await counts()
      await run()
      secondCounts = await counts()
      if (digest(firstCounts) !== digest(secondCounts)) throw new Error('RERUN_NOT_IDEMPOTENT')
    }
    const afterHashes = []
    for (const original of originals) {
      const reread = await db.prospectOrganization.findUniqueOrThrow({
        where: { id: original.id },
        include: {
          opportunity: true,
          contacts: { where: { id: { in: original.contactIds } } },
          activities: { where: { id: { in: original.activityIds } } },
        },
      })
      // Relation ordering is stabilized before comparing full original records.
      const normalized = (value: typeof reread) => ({
        ...value,
        contacts: [...value.contacts].sort((a, b) => a.id.localeCompare(b.id)),
        activities: [...value.activities].sort((a, b) => a.id.localeCompare(b.id)),
      })
      if (digest(normalized(original.organization)) !== digest(normalized(reread)))
        throw new Error('ORIGINAL_RECORD_CHANGED')
      afterHashes.push({ id: original.id, hash: digest(original.organization), unchanged: true })
    }
    const cohortResults = []
    for (const r of resolved) {
      const projection = apply
        ? (await planProspectOutreachEvidence(client, r.id)).projection
        : null
      if (
        projection &&
        (projection.historyComplete ||
          projection.coldEmailCount !== null ||
          projection.eligibility === 'eligible')
      )
        throw new Error('INCOMPLETE_HISTORY_BECAME_ELIGIBLE')
      cohortResults.push({
        key: r.cohort.key,
        organizationId: r.id,
        createObservation: !r.existing,
        messageCount: r.cohort.messages.length,
        globalHistoryComplete: false,
        coldEmailCount: null,
        projection,
        limitations: r.cohort.limitations,
      })
    }
    const result = {
      schema: 'staging-outreach-cohort-result/v1',
      dryRun: !apply,
      planSha256,
      sourceHashes: plan.sourceHashes,
      mailboxId,
      originalsUnchanged: true,
      beforeHashes,
      afterHashes,
      beforeCounts,
      firstCounts,
      secondCounts,
      idempotent: apply ? digest(firstCounts) === digest(secondCounts) : null,
      cohort: cohortResults,
    }
    const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined
    if (output) await writeFile(output, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally {
    await db.$disconnect()
  }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : 'UNKNOWN'
  console.error(
    JSON.stringify({
      error: 'STAGING_COHORT_FAILED',
      reason: /^[A-Z_]+$/.test(message) ? message : 'DATABASE_OR_EVIDENCE_VALIDATION_FAILED',
    }),
  )
  process.exitCode = 1
})
