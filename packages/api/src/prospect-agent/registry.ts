import { VenueLaunchAssetSelectionSchema } from '@pathfinder/contracts/venue-launch-asset'
import { z } from 'zod'
import { AnyVenueLaunchAssetSelectionSchema } from '@pathfinder/contracts/venue-launch-asset'
import { venueLaunchAssetDescriptor } from '@pathfinder/contracts/venue-launch-asset'
import {
  ResearchTerritorySearchInput,
  GeographyRecordSearchInput,
  ProposeProspectGeographyInput,
  GeographyProposalListInput,
} from '@pathfinder/db/prospect-territories'
import {
  readProspectGeographyHolds,
  proposeProspectGeography,
  listProspectGeographyProposals,
} from '@pathfinder/db'

import {
  askAgentQuestionAction,
  claimNextProspectResearchJobAction,
  db,
  readResearchTerritories,
  readProspectPhysicalGeography,
  finishProspectResearchJobAction,
  issueNativeSalesWriterAgentActor,
  revalidateNativeSalesWriterAgentBound,
  readNativeSalesSnapshot,
  saveProspectOutreachDraftAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import prospectToolContracts from './tool-contracts.json'
import { createOutreachCohortService } from '../prospect-outreach-cohort'
import {
  chicagoLifecycleInput,
  chicagoRankingRefreshInput,
} from '../chicago-intelligence-maintenance-contract'
import {
  maintainChicagoVenue,
  refreshChicagoVenueRankings,
} from '../chicago-intelligence-maintenance'
import {
  chicagoResearchPreviewInput,
  chicagoResearchQueueInput,
  chicagoResearchClaimInput,
  chicagoResearchCompleteInput,
  chicagoResearchReleaseInput,
} from '../chicago-intelligence-research-contract'
import {
  previewChicagoResearch,
  queueChicagoResearch,
  claimChicagoResearch,
  completeChicagoResearch,
  releaseChicagoResearch,
} from '../chicago-intelligence-research'
import { validateProspectCopyHandoff } from './copy-assistant'
import { prospectLaunchAssetView, selectProspectLaunchAsset } from '../prospect-launch-assets'
import { readProspectReplyContentForAgent } from '../prospect-reply-content'
import {
  applyNativeSalesAction,
  getNativeSalesWorkflow,
  readAuthenticatedSalesReadiness,
} from '../prospect-sales-workflow'
import { nativeWriterResult, writerImportInput } from '../prospect-writer-contract'
import {
  chicagoAddInput,
  chicagoAppendEvidenceInput,
  chicagoChangeInput,
  chicagoDirectoryInput,
  chicagoDuplicateInput,
  chicagoVenueInput,
} from '../chicago-intelligence-contract'
import {
  addChicagoVenue,
  appendChicagoEvidence,
  changeChicagoVenue,
  getChicagoHealth,
  getChicagoVenue,
  listChicagoVenues,
  proposeChicagoDuplicate,
} from '../chicago-intelligence-service'

const prospectCapability = z.enum([
  'prospects.read',
  'prospects.maintain',
  'prospects.correspondence.read',
  'prospects.native-writer',
  'prospects.research',
  'prospects.draft',
  'prospects.question',
])
const prospectScope = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ALL') }).strict(),
  z
    .object({
      mode: z.literal('TERRITORIES'),
      territoryIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
    })
    .strict(),
])

export type VerifiedProspectAgentContext = Readonly<{
  tenantId: string
  venueId: string
  agentRunId: string
  actorId: string
  initiatorId: string
  capabilities: readonly z.infer<typeof prospectCapability>[]
  scope: z.infer<typeof prospectScope>
  modelProvider: string | null
  modelName: string | null
  promptIdentity: string
  requestedOperation: string
  correlationId: string
}>

export type ProspectAgentInvocation = Readonly<{
  tenantId: string
  venueId: string
  sessionId: string
  agentRunId: string
  leaseToken: string
  credentialId: string
  correlationId: string
}>

const searchInput = z
  .object({
    query: z.string().trim().max(200).optional(),
    stage: z
      .enum([
        'DISCOVERED',
        'RESEARCHED',
        'NEEDS_REVIEW',
        'READY_FOR_OUTREACH',
        'CONTACTED',
        'FOLLOW_UP_DUE',
        'REPLIED',
        'CONVERSATION',
        'QUALIFIED',
        'PROPOSAL_DECISION',
        'WON',
        'LOST',
        'PARKED',
        'DO_NOT_CONTACT',
      ])
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
const organizationInput = z.object({ organizationId: z.string().min(1).max(191) }).strict()
const launchAssetsInput = z
  .object({
    organizationId: z.string().min(1).max(191),
    prospectVenueId: z.string().min(1).max(191),
  })
  .strict()
const selectLaunchAssetInput = launchAssetsInput
  .extend({
    selection: AnyVenueLaunchAssetSelectionSchema,
  })
  .strict()
const selectedReplyInput = z
  .object({
    organizationId: z.string().min(1).max(191),
    threadId: z.string().min(1).max(191),
    messageId: z.string().min(1).max(191),
  })
  .strict()
const nativeWriterId = z.string().trim().min(1).max(191)
const nativeWriterHash = z.string().regex(/^[a-f0-9]{64}$/u)
const nativeWriterScopeInput = z
  .object({
    organizationId: nativeWriterId,
    venueId: nativeWriterId,
  })
  .strict()
const nativeWriterPrepareInput = z
  .object({
    organizationId: nativeWriterId,
    venueId: nativeWriterId,
    expectedSnapshotHash: nativeWriterHash,
    answerText: z.string().min(12).max(2000).optional(),
    selectedThreadId: nativeWriterId.optional(),
    launchAssetSelection: VenueLaunchAssetSelectionSchema.optional(),
    savedWritingGuide: z.literal('torchiko-v0.2').optional(),
    expectedWritingGuideSha256: nativeWriterHash.optional(),
  })
  .strict()
const nativeWriterImportInput = z
  .object({
    organizationId: nativeWriterId,
    venueId: nativeWriterId,
    expectedSnapshotHash: nativeWriterHash,
    result: nativeWriterResult,
  })
  .strict()
const campaignInput = z
  .object({
    campaignId: z.string().min(1).max(191),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
const evidenceReference = z
  .object({
    kind: z.enum(['CRM_FIELD', 'SOURCE_EVIDENCE', 'WEBSITE_RESEARCH', 'CORRESPONDENCE']),
    reference: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
const draftInput = z
  .object({
    memberId: z.string().min(1).max(191),
    launchAssetSelection: AnyVenueLaunchAssetSelectionSchema.optional(),
    subject: z.string().trim().min(1).max(998),
    textBody: z.string().trim().min(1).max(50_000),
    htmlBody: z.string().max(100_000).optional(),
    evidence: z.array(evidenceReference).min(1).max(50),
    template: z
      .object({ id: z.string().trim().min(1).max(191), version: z.string().trim().min(1).max(100) })
      .strict(),
    prompt: z
      .object({ id: z.string().trim().min(1).max(191), version: z.string().trim().min(1).max(100) })
      .strict(),
    warnings: z.array(z.string().trim().min(1).max(500)).max(25).default([]),
    claims: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(2_000),
            evidenceReferences: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
          })
          .strict(),
      )
      .max(25)
      .default([]),
    copySources: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            version: z
              .string()
              .trim()
              .regex(/^\d{1,9}$/u),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict()
const questionInput = z
  .object({
    operationId: z.string().uuid(),
    question: z.string().trim().min(1).max(2_000),
    context: z.string().trim().min(1).max(2_000).optional(),
    urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    blocking: z.boolean().default(true),
    evidence: z.array(evidenceReference).max(20).default([]),
  })
  .strict()
const claimResearchInput = z
  .object({ leaseSeconds: z.number().int().min(60).max(1_800).default(900) })
  .strict()
const finishResearchInput = z
  .object({
    claimToken: z.string().uuid(),
    outcome: z.enum(['RESEARCHED', 'NEEDS_REVIEW', 'BLOCKED', 'CAP_REACHED', 'SKIPPED']),
    reason: z.string().trim().min(1).max(2_000),
    usage: z.record(z.unknown()).default({}),
    costUsd: z.number().min(0).max(10_000).optional(),
  })
  .strict()
const releaseResearchInput = z
  .object({ claimToken: z.string().uuid(), reason: z.string().trim().min(1).max(2_000) })
  .strict()

export const PROSPECT_AGENT_TOOL_DEFINITIONS = [
  ...(
    [
      [
        'list_outreach_cohorts',
        'List retained native preparation groups in complete authorized scope, with explicit pagination',
        'prospects.read',
        'read',
        false,
      ],
      [
        'preview_outreach_cohort',
        'Preview up to 50 source-bound outreach preparations; hold unknown size/contact/history and exclude every prior group',
        'prospects.read',
        'read',
        false,
      ],
      [
        'reserve_outreach_cohort',
        'Retain the exact reviewed preparation set on native campaign members with an immutable request identity; no send',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'read_outreach_cohort',
        'Read every selected venue, exact current message/version, hold, send state and reply coverage; not sending approval',
        'prospects.read',
        'read',
        false,
      ],
      [
        'claim_outreach_window',
        'Claim at most five exact native preparation members; replay the same request key after a lost response',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'checkpoint_outreach_member',
        'Checkpoint an exact native writer task/import receipt, hold or recovery without a second CRM or delivery owner',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'read_outreach_review',
        'Read one current native draft, research needs and correspondence state through live native writer authority',
        'prospects.native-writer',
        'read',
        false,
      ],
    ] as const
  ).map(([suffix, title, capability, effect, mutates]) => ({
    ...prospectToolContracts.tools[`torchiko.prospects.${suffix}`],
    name: `torchiko.prospects.${suffix}` as const,
    title,
    description: title,
    capability,
    effect,
    mutates,
    idempotent: true,
    humanReviewRequired: false,
  })),
  ...(
    [
      [
        'search_geography_records',
        'Find current location checks and assigned venues',
        'prospects.read',
        'read',
        false,
      ],
      [
        'propose_physical_geography',
        'Submit county evidence to the existing human review queue',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'read_geography_proposals',
        'Read source-bound county proposals and decisions',
        'prospects.read',
        'read',
        false,
      ],
    ] as const
  ).map(([suffix, title, capability, effect, mutates]) => ({
    ...prospectToolContracts.tools[`torchiko.prospects.${suffix}`],
    name: `torchiko.prospects.${suffix}` as const,
    title,
    description: title,
    capability,
    effect,
    mutates,
    idempotent: true,
    humanReviewRequired: mutates,
  })),
  {
    ...prospectToolContracts.tools['torchiko.prospects.list_research_territories'],
    name: 'torchiko.prospects.list_research_territories',
    title: 'Read canonical research territories',
    description:
      'Read the locked county membership, native territory IDs and discovery contract within the current grant. This does not start research.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.read_physical_geography'],
    name: 'torchiko.prospects.read_physical_geography',
    title: 'Read physical venue geography',
    description:
      'Read the native venue county, evidence, version and explicit unresolved state; never infer ownership from the old sheet.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  ...(
    [
      [
        'maintain_venue_lifecycle',
        'Archive, restore or supersede a scoped venue without deleting history',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'refresh_venue_rankings',
        'Refresh an explicit version-checked ranking batch',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'preview_venue_research',
        'Preview bounded Chicago research',
        'prospects.read',
        'read',
        false,
      ],
      [
        'queue_venue_research',
        'Queue explicit Chicago evidence gaps',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'claim_venue_research',
        'Claim one scoped Chicago research lease',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'complete_venue_research',
        'Complete research with exact sources and unresolved gaps',
        'prospects.maintain',
        'execute',
        true,
      ],
      [
        'release_venue_research',
        'Release a research lease with preserved attempt history',
        'prospects.maintain',
        'execute',
        true,
      ],
    ] as const
  ).map(([suffix, title, capability, effect, mutates]) => ({
    ...prospectToolContracts.tools[`torchiko.prospects.${suffix}`],
    name: `torchiko.prospects.${suffix}` as const,
    title,
    description: title,
    capability,
    effect,
    mutates,
    idempotent: true,
    humanReviewRequired: false,
  })),
  {
    ...prospectToolContracts.tools['torchiko.prospects.search_venues'],
    name: 'torchiko.prospects.search_venues',
    title: 'Search Chicago venues',
    description:
      'Search and paginate the Chicago directory using the same filters and ranking sorts as the operator.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.read_venue'],
    name: 'torchiko.prospects.read_venue',
    title: 'Read Chicago venue intelligence',
    description:
      'Read one canonical venue, organization, field evidence, rankings, contact claims, reviews and audit history.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.explain_venue'],
    name: 'torchiko.prospects.explain_venue',
    title: 'Explain Chicago venue ranking',
    description:
      'Explain ranking components, version, evidence, uncertainty and ordered research gaps for one venue.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.read_data_health'],
    name: 'torchiko.prospects.read_data_health',
    title: 'Read Chicago data health',
    description:
      'Inspect scoped coverage, source imports, reconciliation, quarantine reviews and research leases.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.add_venue'],
    name: 'torchiko.prospects.add_venue',
    title: 'Add a source-backed Chicago venue',
    description:
      'Admit a Chicago candidate with first-party evidence, explicit territory rationale, duplicate signals and a retry-safe receipt.',
    capability: 'prospects.maintain',
    effect: 'execute',
    mutates: true,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.change_venue'],
    name: 'torchiko.prospects.change_venue',
    title: 'Maintain verified Chicago venue evidence',
    description:
      'Propose or apply one evidence-backed field change with expected version, audit lineage and idempotent retry.',
    capability: 'prospects.maintain',
    effect: 'execute',
    mutates: true,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.append_venue_evidence'],
    name: 'torchiko.prospects.append_venue_evidence',
    title: 'Append Chicago venue evidence',
    description:
      'Append a first-party source, a supported fit or attainability observation, or a published public route with an expected version and immutable receipt. Never infer a private contact or change a human override.',
    capability: 'prospects.maintain',
    effect: 'execute',
    mutates: true,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.propose_venue_relationship'],
    name: 'torchiko.prospects.propose_venue_relationship',
    title: 'Propose venue identity review',
    description:
      'Record a possible duplicate or same-operator relationship for review without merging or deleting either venue.',
    capability: 'prospects.maintain',
    effect: 'execute',
    mutates: true,
    idempotent: true,
    humanReviewRequired: true,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.search'],
    name: 'torchiko.prospects.search',
    title: 'Search prospects',
    description: 'Search bounded prospect organizations inside the frozen run scope.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.get_intelligence'],
    name: 'torchiko.prospects.get_intelligence',
    title: 'Get prospect intelligence',
    description: 'Read grounded CRM and linked live-venue intelligence for one prospect.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.list_launch_assets'],
    name: 'torchiko.prospects.list_launch_assets',
    title: 'List current venue QR assets',
    description: 'List server-verified QR asset descriptors for active prospect venue conversions.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.select_launch_asset'],
    name: 'torchiko.prospects.select_launch_asset',
    title: 'Select current venue QR asset',
    description:
      'Verify one exact current SVG, PNG, or PDF venue QR selection and return its descriptor.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.list_campaign_members'],
    name: 'torchiko.prospects.list_campaign_members',
    title: 'List campaign members',
    description: 'List bounded campaign membership inside the frozen prospect scope.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.read_selected_reply_content'],
    name: 'torchiko.prospects.read_selected_reply_content',
    title: 'Read selected prospect reply',
    description: 'Read one exact inbound reply through the native mailbox without retaining it.',
    capability: 'prospects.correspondence.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.prepare_native_writer'],
    name: 'torchiko.prospects.prepare_native_writer',
    title: 'Prepare one native prospect writer task',
    description: 'Explicitly persist current no-send writing context for one scoped native venue.',
    capability: 'prospects.native-writer',
    effect: 'draft',
    mutates: true,
    idempotent: false,
    humanReviewRequired: true,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.read_native_writer_task'],
    name: 'torchiko.prospects.read_native_writer_task',
    title: 'Read exact native writer task',
    description: 'Export the current source-bound no-send writer task for one scoped venue.',
    capability: 'prospects.native-writer',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: true,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.import_native_writer_result'],
    name: 'torchiko.prospects.import_native_writer_result',
    title: 'Import attributed native writer result',
    description:
      'Retain one exact model draft and immutable receipt without assessment or approval.',
    capability: 'prospects.native-writer',
    effect: 'draft',
    mutates: true,
    idempotent: true,
    humanReviewRequired: true,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.claim_research_job'],
    name: 'torchiko.prospects.claim_research_job',
    title: 'Claim next prospect research job',
    description: 'Claim one unfinished in-scope prospect under a bounded durable lease.',
    capability: 'prospects.research',
    effect: 'execute',
    mutates: true,
    idempotent: false,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.complete_research_job'],
    name: 'torchiko.prospects.complete_research_job',
    title: 'Complete prospect research job',
    description: 'Record a bounded research outcome, usage, cost, and exact attempt lineage.',
    capability: 'prospects.research',
    effect: 'execute',
    mutates: true,
    idempotent: false,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.release_research_job'],
    name: 'torchiko.prospects.release_research_job',
    title: 'Release prospect research job',
    description: 'Release an unfinished claim back to the queue without changing prospect facts.',
    capability: 'prospects.research',
    effect: 'execute',
    mutates: true,
    idempotent: false,
    humanReviewRequired: false,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.save_outreach_draft'],
    name: 'torchiko.prospects.save_outreach_draft',
    title: 'Save outreach draft',
    description: 'Save a grounded, versioned outreach draft that cannot be sent or approved.',
    capability: 'prospects.draft',
    effect: 'draft',
    mutates: true,
    idempotent: false,
    humanReviewRequired: true,
  },
  {
    ...prospectToolContracts.tools['torchiko.prospects.ask_operator'],
    name: 'torchiko.prospects.ask_operator',
    title: 'Ask prospect operator',
    description: 'Create or replay a durable scoped question without granting approval.',
    capability: 'prospects.question',
    effect: 'interaction',
    mutates: true,
    idempotent: true,
    humanReviewRequired: false,
  },
] as const

type ToolName = (typeof PROSPECT_AGENT_TOOL_DEFINITIONS)[number]['name']

export class ProspectAgentRegistryError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_TOOL'
      | 'CAPABILITY_REQUIRED'
      | 'INVALID_CONTEXT'
      | 'SCOPE_REQUIRED'
      | 'OUT_OF_SCOPE'
      | 'STATE_HELD',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectAgentRegistryError'
  }
}

export type ProspectAgentRegistry = Readonly<{
  listTools: () => typeof PROSPECT_AGENT_TOOL_DEFINITIONS
  callTool: (name: string, input: unknown, invocation: ProspectAgentInvocation) => Promise<unknown>
}>

type Resolver = (invocation: ProspectAgentInvocation) => Promise<VerifiedProspectAgentContext>

const frozenScopeSchema = z
  .object({
    accessCapabilities: z.array(z.string()),
    prospectScope,
    promptIdentity: z.string().trim().min(1).max(191),
  })
  .passthrough()

/** Resolve authority from the authenticated bridge's live, leased AgentRun. Caller-supplied
 * identities, capability arrays, or prospect scopes are never accepted as authority. */
export async function resolveVerifiedProspectAgentContext(
  invocation: ProspectAgentInvocation,
): Promise<VerifiedProspectAgentContext> {
  const parsed = z
    .object({
      tenantId: z.string().trim().min(1).max(191),
      venueId: z.string().trim().min(1).max(191),
      sessionId: z.string().uuid(),
      agentRunId: z.string().trim().min(1).max(191),
      leaseToken: z.string().uuid(),
      credentialId: z.string().trim().min(1).max(191),
      correlationId: z.string().uuid(),
    })
    .strict()
    .parse(invocation)
  const now = new Date()
  const run = await db.agentRun.findFirst({
    where: {
      id: parsed.agentRunId,
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      status: 'RUNNING',
      executionLeaseToken: parsed.leaseToken,
      executionLeaseExpiresAt: { gt: now },
      executionBridgeSessionId: parsed.sessionId,
      executionBridgeSession: {
        credentialId: parsed.credentialId,
        status: 'ONLINE',
        expiresAt: { gt: now },
      },
      agentIdentity: { enabled: true },
    },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      initiatedById: true,
      requestedOperation: true,
      scopeSnapshot: true,
      modelProvider: true,
      modelName: true,
      agentIdentity: { select: { id: true, accessCapabilities: true } },
    },
  })
  if (!run || !run.venueId) {
    throw new ProspectAgentRegistryError(
      'INVALID_CONTEXT',
      'A live bridge-owned AgentRun is required',
    )
  }
  const frozen = frozenScopeSchema.safeParse(run.scopeSnapshot)
  if (!frozen.success) {
    throw new ProspectAgentRegistryError(
      'SCOPE_REQUIRED',
      'AgentRun has no explicit frozen prospect scope',
    )
  }
  const live = new Set(run.agentIdentity.accessCapabilities)
  const capabilities = frozen.data.accessCapabilities
    .filter(
      (capability): capability is z.infer<typeof prospectCapability> =>
        prospectCapability.safeParse(capability).success,
    )
    .filter((capability) => live.has(capability))
  return {
    tenantId: run.tenantId,
    venueId: run.venueId,
    agentRunId: run.id,
    actorId: run.agentIdentity.id,
    initiatorId: run.initiatedById,
    capabilities,
    scope: frozen.data.prospectScope,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    promptIdentity: frozen.data.promptIdentity,
    requestedOperation: run.requestedOperation,
    correlationId: parsed.correlationId,
  }
}

function authorize(name: ToolName, context: VerifiedProspectAgentContext) {
  const definition = PROSPECT_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name)!
  if (!context.capabilities.includes(definition.capability)) {
    throw new ProspectAgentRegistryError(
      'CAPABILITY_REQUIRED',
      `${definition.capability} capability is required by both the live identity and frozen run`,
    )
  }
}

function organizationScope(context: VerifiedProspectAgentContext) {
  if (context.scope.mode === 'ALL') return {}
  const territoryId = { in: [...new Set(context.scope.territoryIds)] }
  // Organization-level reads include contacts, sources and relationship history.
  // They therefore require the ENTIRE native organization footprint, not just a
  // legacy organization label or one granted branch. Venue-scoped reads remain
  // available separately. Old Chicago grants do not inherit new county grants.
  return {
    AND: [
      {
        OR: [
          { venues: { some: { archivedAt: null, territoryId } } },
          { territoryId, venues: { none: {} } },
        ],
      },
      { venues: { every: { AND: [{ territoryId: { not: null } }, { territoryId }] } } },
    ],
  }
}

async function nativeWriterActor(
  input: { organizationId: string; venueId: string },
  invocation: ProspectAgentInvocation,
  context: VerifiedProspectAgentContext,
) {
  if (!context.capabilities.includes('prospects.correspondence.read'))
    throw new ProspectAgentRegistryError(
      'CAPABILITY_REQUIRED',
      'Native writer context also requires live and frozen correspondence read access',
    )
  const actor = await issueNativeSalesWriterAgentActor({
    invocation,
    venueId: input.venueId,
    organizationId: input.organizationId,
  })
  if (actor.id !== context.actorId)
    throw new ProspectAgentRegistryError(
      'INVALID_CONTEXT',
      'Agent identity changed while establishing native writer authority',
    )
  return actor
}

async function requireScopedProspectVenue(
  organizationId: string,
  prospectVenueId: string,
  context: VerifiedProspectAgentContext,
) {
  const venue = await db.prospectVenue.findFirst({
    where: {
      id: prospectVenueId,
      organizationId,
      archivedAt: null,
      organization: organizationScope(context),
    },
    select: { id: true },
  })
  if (!venue)
    throw new ProspectAgentRegistryError(
      'OUT_OF_SCOPE',
      'Prospect venue is outside the frozen scope',
    )
}

export function createProspectAgentRegistry(
  dependencies: Readonly<{ resolveContext?: Resolver }> = {},
): ProspectAgentRegistry {
  const resolveContext = dependencies.resolveContext ?? resolveVerifiedProspectAgentContext
  return {
    listTools: () => PROSPECT_AGENT_TOOL_DEFINITIONS,
    async callTool(rawName, rawInput, invocation) {
      const definition = PROSPECT_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === rawName)
      if (!definition)
        throw new ProspectAgentRegistryError('UNKNOWN_TOOL', `Unknown tool: ${rawName}`)
      const name = definition.name
      const context = await resolveContext(invocation)
      authorize(name, context)
      return withTenantIsolationBypass(async () => {
        switch (name) {
          case 'torchiko.prospects.list_outreach_cohorts':
          case 'torchiko.prospects.preview_outreach_cohort':
          case 'torchiko.prospects.reserve_outreach_cohort':
          case 'torchiko.prospects.read_outreach_cohort':
          case 'torchiko.prospects.claim_outreach_window':
          case 'torchiko.prospects.checkpoint_outreach_member': {
            const revalidate = async () => {
              const live = await resolveContext(invocation)
              authorize(name, live)
              if (
                live.actorId !== context.actorId ||
                live.agentRunId !== context.agentRunId ||
                JSON.stringify(live.scope) !== JSON.stringify(context.scope) ||
                JSON.stringify([...live.capabilities].sort()) !==
                  JSON.stringify([...context.capabilities].sort())
              )
                throw new ProspectAgentRegistryError(
                  'INVALID_CONTEXT',
                  'Live run scope or capabilities changed during the native cohort operation',
                )
            }
            const service = createOutreachCohortService({ revalidate })
            const actor = {
              id: context.actorId,
              type: 'AGENT' as const,
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            }
            if (name === 'torchiko.prospects.list_outreach_cohorts')
              return service.list(rawInput, actor)
            if (name === 'torchiko.prospects.preview_outreach_cohort')
              return service.preview(rawInput, actor)
            if (name === 'torchiko.prospects.reserve_outreach_cohort')
              return service.reserve(rawInput, actor)
            if (name === 'torchiko.prospects.read_outreach_cohort')
              return service.read(rawInput, actor)
            if (name === 'torchiko.prospects.claim_outreach_window')
              return service.claimWindow(rawInput, actor)
            return service.checkpoint(rawInput, actor)
          }
          case 'torchiko.prospects.read_outreach_review': {
            const input = nativeWriterScopeInput.parse(rawInput)
            const actor = await nativeWriterActor(input, invocation, context)
            const view = await getNativeSalesWorkflow(input.venueId, 'authenticated-admin')
            await revalidateNativeSalesWriterAgentBound(actor, input.venueId)
            if (view.organizationId !== input.organizationId)
              throw new ProspectAgentRegistryError(
                'OUT_OF_SCOPE',
                'Native venue organization changed',
              )
            return {
              venueId: view.venueId,
              organizationId: view.organizationId,
              name: view.name,
              snapshotHash: view.snapshotHash,
              gate: view.gate,
              sourceState: view.sourceState,
              sourceCount: view.sourceCount,
              routing: view.routing,
              suppression: view.suppression,
              draft: view.draft,
              revisions: view.revisions,
              preparation: view.preparation
                ? {
                    id: view.preparation.id,
                    stale: view.preparation.stale,
                    writingReferenceSha256: view.preparation.writingReference?.sha256 ?? null,
                  }
                : null,
              writerHold: view.writerHold,
              blocker: view.blocker,
              claimReview: view.claimReview,
              outreachState: view.outreachState,
              correspondenceState: view.correspondenceState,
              threadCandidates: view.threadCandidates,
              operational: view.operational ?? null,
              SEND_AUTHORIZED: false,
            }
          }
          case 'torchiko.prospects.search_geography_records':
            return readProspectGeographyHolds(
              GeographyRecordSearchInput.parse(rawInput),
              context.scope.mode === 'ALL' ? undefined : context.scope.territoryIds,
            )
          case 'torchiko.prospects.propose_physical_geography':
            return proposeProspectGeography(ProposeProspectGeographyInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.read_geography_proposals':
            return listProspectGeographyProposals(GeographyProposalListInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.list_research_territories': {
            const input = ResearchTerritorySearchInput.parse(rawInput)
            return readResearchTerritories(
              input,
              context.scope.mode === 'ALL' ? undefined : context.scope.territoryIds,
            )
          }
          case 'torchiko.prospects.read_physical_geography': {
            const input = z
              .object({ venueId: z.string().min(1).max(191) })
              .strict()
              .parse(rawInput)
            const view = await readProspectPhysicalGeography(
              input.venueId,
              context.scope.mode === 'ALL' ? undefined : context.scope.territoryIds,
            )
            if (!view.venue)
              throw new ProspectAgentRegistryError(
                'OUT_OF_SCOPE',
                'Native venue is absent or outside the current territory grant',
              )
            return view
          }
          case 'torchiko.prospects.maintain_venue_lifecycle':
            return maintainChicagoVenue(chicagoLifecycleInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.refresh_venue_rankings':
            return refreshChicagoVenueRankings(chicagoRankingRefreshInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.preview_venue_research':
            return previewChicagoResearch(
              chicagoResearchPreviewInput.parse(rawInput),
              context.scope,
            )
          case 'torchiko.prospects.queue_venue_research':
            return queueChicagoResearch(chicagoResearchQueueInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.claim_venue_research':
            return claimChicagoResearch(chicagoResearchClaimInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.complete_venue_research':
            return completeChicagoResearch(chicagoResearchCompleteInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.release_venue_research':
            return releaseChicagoResearch(chicagoResearchReleaseInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.search_venues':
            return listChicagoVenues(chicagoDirectoryInput.parse(rawInput), context.scope)
          case 'torchiko.prospects.read_venue':
            return getChicagoVenue(chicagoVenueInput.parse(rawInput).venueId, context.scope)
          case 'torchiko.prospects.explain_venue': {
            const detail = await getChicagoVenue(
              chicagoVenueInput.parse(rawInput).venueId,
              context.scope,
            )
            return {
              venueId: detail.venueId,
              ranking: detail.ranking,
              researchGaps: detail.researchGaps,
            }
          }
          case 'torchiko.prospects.read_data_health':
            z.object({}).strict().parse(rawInput)
            return getChicagoHealth(context.scope)
          case 'torchiko.prospects.add_venue':
            return addChicagoVenue(chicagoAddInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.change_venue':
            return changeChicagoVenue(chicagoChangeInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.append_venue_evidence':
            return appendChicagoEvidence(chicagoAppendEvidenceInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.propose_venue_relationship':
            return proposeChicagoDuplicate(chicagoDuplicateInput.parse(rawInput), {
              id: context.actorId,
              type: 'AGENT',
              runId: context.agentRunId,
              scope: context.scope,
              capabilities: context.capabilities,
            })
          case 'torchiko.prospects.search': {
            const input = searchInput.parse(rawInput)
            return db.prospectOrganization.findMany({
              where: {
                ...organizationScope(context),
                archivedAt: null,
                ...(input.query
                  ? {
                      OR: [
                        { canonicalName: { contains: input.query, mode: 'insensitive' as const } },
                        {
                          venues: {
                            some: { name: { contains: input.query, mode: 'insensitive' as const } },
                          },
                        },
                        { normalizedDomain: { contains: input.query.toLowerCase() } },
                      ],
                    }
                  : {}),
                ...(input.stage ? { opportunity: { stage: input.stage } } : {}),
              },
              orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
              take: input.limit,
              select: {
                id: true,
                canonicalName: true,
                organizationType: true,
                relationshipTier: true,
                priority: true,
                territory: { select: { name: true } },
                opportunity: { select: { stage: true, nextAction: true, nextActionAt: true } },
                venues: {
                  where: { archivedAt: null },
                  take: 3,
                  select: { id: true, name: true, city: true, region: true },
                },
                contacts: {
                  where: { archivedAt: null },
                  take: 3,
                  select: {
                    id: true,
                    fullName: true,
                    title: true,
                    email: true,
                    doNotContact: true,
                  },
                },
              },
            })
          }
          case 'torchiko.prospects.get_intelligence': {
            const input = organizationInput.parse(rawInput)
            const prospect = await db.prospectOrganization.findFirst({
              where: { id: input.organizationId, ...organizationScope(context) },
              include: {
                venues: { where: { archivedAt: null } },
                contacts: { where: { archivedAt: null } },
                sources: true,
                opportunity: true,
                activities: { orderBy: { occurredAt: 'desc' }, take: 100 },
                customerRelationships: {
                  // A territory grant is not a grant to all live client locations
                  // under the organization. Use the separately scoped venue tools.
                  where: {
                    status: 'ACTIVE',
                    tenantId: context.tenantId,
                    ...(context.scope.mode === 'ALL' ? {} : { id: { in: [] as string[] } }),
                  },
                  take: 5,
                  include: {
                    locationConversions: {
                      where: { status: 'ACTIVE' },
                      take: 20,
                      orderBy: { convertedAt: 'desc' },
                    },
                  },
                },
              },
            })
            if (!prospect) return null
            const location = prospect.customerRelationships[0]?.locationConversions[0]
            if (!location) return { prospect, liveVenue: null }
            const scope = {
              tenantId: context.tenantId,
              venueId: location.venueId,
            }
            const [venue, places, knowledge] = await Promise.all([
              db.venue.findFirst({
                where: { id: scope.venueId, tenantId: scope.tenantId },
                select: { id: true, name: true, category: true, isActive: true, updatedAt: true },
              }),
              db.place.findMany({
                where: { ...scope, isActive: true },
                take: 100,
                orderBy: { importanceScore: 'desc' },
                select: {
                  id: true,
                  name: true,
                  type: true,
                  shortDescription: true,
                  areaName: true,
                  tags: true,
                  updatedAt: true,
                },
              }),
              db.venueKnowledgeEntry.findMany({
                where: { ...scope, isEnabled: true },
                take: 100,
                orderBy: { updatedAt: 'desc' },
                select: {
                  id: true,
                  title: true,
                  category: true,
                  content: true,
                  humanConfirmedAt: true,
                  updatedAt: true,
                },
              }),
            ])
            return { prospect, liveVenue: venue ? { ...venue, places, knowledge } : null }
          }
          case 'torchiko.prospects.list_launch_assets': {
            const input = launchAssetsInput.parse(rawInput)
            await requireScopedProspectVenue(input.organizationId, input.prospectVenueId, context)
            return prospectLaunchAssetView(input.prospectVenueId)
          }
          case 'torchiko.prospects.select_launch_asset': {
            const input = selectLaunchAssetInput.parse(rawInput)
            await requireScopedProspectVenue(input.organizationId, input.prospectVenueId, context)
            try {
              const asset = await selectProspectLaunchAsset(input.prospectVenueId, input.selection)
              return venueLaunchAssetDescriptor(asset)
            } catch {
              throw new ProspectAgentRegistryError(
                'STATE_HELD',
                'Selected venue QR is stale or unavailable; list current assets and choose again',
              )
            }
          }
          case 'torchiko.prospects.list_campaign_members': {
            const input = campaignInput.parse(rawInput)
            return db.prospectCampaignMember.findMany({
              where: { campaignId: input.campaignId, organization: organizationScope(context) },
              orderBy: { createdAt: 'asc' },
              take: input.limit,
              include: {
                organization: true,
                venue: true,
                contact: true,
                drafts: { orderBy: { version: 'desc' }, take: 1 },
              },
            })
          }
          case 'torchiko.prospects.read_selected_reply_content': {
            const input = selectedReplyInput.parse(rawInput)
            return readProspectReplyContentForAgent(input, context.actorId, context.scope)
          }
          case 'torchiko.prospects.prepare_native_writer': {
            const input = nativeWriterPrepareInput.parse(rawInput)
            if (Boolean(input.savedWritingGuide) !== Boolean(input.expectedWritingGuideSha256))
              throw new ProspectAgentRegistryError(
                'STATE_HELD',
                'Exact saved-guide selection and its current hash must be supplied together',
              )
            const actor = await nativeWriterActor(input, invocation, context)
            const view = await applyNativeSalesAction(
              {
                action: 'prepare',
                input: {
                  venueId: input.venueId,
                  expectedSnapshotHash: input.expectedSnapshotHash,
                  ...(input.launchAssetSelection
                    ? { launchAssetSelection: input.launchAssetSelection }
                    : {}),
                  ...(input.answerText ? { answerText: input.answerText } : {}),
                  ...(input.selectedThreadId ? { selectedThreadId: input.selectedThreadId } : {}),
                  ...(input.savedWritingGuide
                    ? {
                        savedWritingGuide: input.savedWritingGuide,
                        expectedWritingGuideSha256: input.expectedWritingGuideSha256!,
                      }
                    : {}),
                },
              },
              actor,
              'authenticated-admin',
            )
            await revalidateNativeSalesWriterAgentBound(actor, input.venueId)
            if (
              'schema' in view ||
              view.organizationId !== input.organizationId ||
              !view.preparation
            )
              throw new ProspectAgentRegistryError(
                'STATE_HELD',
                'Current scoped native preparation is unavailable',
              )
            return {
              venueId: input.venueId,
              preparationId: view.preparation.id,
              snapshotHash: view.snapshotHash,
              stale: view.preparation.stale,
              SEND_AUTHORIZED: false,
            }
          }
          case 'torchiko.prospects.read_native_writer_task': {
            const input = nativeWriterScopeInput.parse(rawInput)
            const actor = await nativeWriterActor(input, invocation, context)
            const initial = await readNativeSalesSnapshot(input.venueId)
            if (initial.organization.id !== input.organizationId)
              throw new ProspectAgentRegistryError(
                'OUT_OF_SCOPE',
                'Native venue does not belong to the selected organization',
              )
            const readiness = await readAuthenticatedSalesReadiness()
            let view: Awaited<ReturnType<typeof getNativeSalesWorkflow>> | null = null
            if (readiness.component.state === 'paths-present-runtime-unverified') {
              try {
                view = await getNativeSalesWorkflow(input.venueId, 'authenticated-admin')
              } catch {
                /* Safe hold, preserving the exact native snapshot below. */
              }
            }
            const current = await readNativeSalesSnapshot(input.venueId)
            await revalidateNativeSalesWriterAgentBound(actor, input.venueId)
            if (
              current.organization.id !== input.organizationId ||
              (view && view.organizationId !== input.organizationId)
            )
              throw new ProspectAgentRegistryError(
                'OUT_OF_SCOPE',
                'Native venue scope changed during writer task read',
              )
            const snapshotChanged = Boolean(view && view.snapshotHash !== current.snapshotHash)
            const task =
              !snapshotChanged && !view?.preparation?.stale && !view?.writerHold
                ? (view?.writerTask ?? null)
                : null
            const hold = task
              ? null
              : snapshotChanged
                ? 'SNAPSHOT_CHANGED_RELOAD'
                : readiness.component.state !== 'paths-present-runtime-unverified'
                  ? 'COMPONENT_UNAVAILABLE'
                  : !view
                    ? 'WORKFLOW_UNAVAILABLE'
                    : !view.preparation
                      ? 'PREPARATION_REQUIRED'
                      : view.preparation.stale
                        ? 'STALE_PREPARATION'
                        : 'WRITER_TASK_HELD'
            return {
              organizationId: input.organizationId,
              venueId: input.venueId,
              snapshotHash: current.snapshotHash,
              preparationId: view?.preparation?.id ?? null,
              task,
              hold,
              writingGuide: readiness.writingGuide,
              launchAssets: view?.launchAssets ?? { available: [], hold: 'WORKFLOW_UNAVAILABLE' },
              componentState: readiness.component.state,
              SEND_AUTHORIZED: false,
            }
          }
          case 'torchiko.prospects.import_native_writer_result': {
            const input = nativeWriterImportInput.parse(rawInput)
            const exact = writerImportInput.parse({
              venueId: input.venueId,
              expectedSnapshotHash: input.expectedSnapshotHash,
              result: input.result,
            })
            if (
              exact.result.binding.organizationId !== input.organizationId ||
              exact.result.assessment !== null
            )
              throw new ProspectAgentRegistryError(
                'OUT_OF_SCOPE',
                'Agent import requires the exact organization and an unassessed model result',
              )
            const actor = await nativeWriterActor(input, invocation, context)
            const accepted = await applyNativeSalesAction(
              { action: 'importWriterResult', input: exact },
              actor,
              'authenticated-admin',
            )
            await revalidateNativeSalesWriterAgentBound(actor, input.venueId)
            const receipt = accepted.writerImportReceipt
            if (!receipt?.id || !receipt.draftId)
              throw new ProspectAgentRegistryError(
                'STATE_HELD',
                'Native writer import did not return an immutable receipt',
              )
            return {
              receiptId: receipt.id,
              draftId: receipt.draftId,
              replayed: receipt.replayed,
              pendingOperatorReview: true,
              SEND_AUTHORIZED: false,
            }
          }
          case 'torchiko.prospects.claim_research_job': {
            const input = claimResearchInput.parse(rawInput)
            return claimNextProspectResearchJobAction({
              leaseSeconds: input.leaseSeconds,
              context: {
                agentRunId: context.agentRunId,
                agentIdentityId: context.actorId,
                ...(context.scope.mode === 'TERRITORIES'
                  ? { territoryIds: context.scope.territoryIds }
                  : {}),
                modelProvider: context.modelProvider,
                modelName: context.modelName,
                promptIdentity: context.promptIdentity,
              },
            })
          }
          case 'torchiko.prospects.complete_research_job': {
            const input = finishResearchInput.parse(rawInput)
            return finishProspectResearchJobAction({
              claimToken: input.claimToken,
              outcome: input.outcome,
              reason: input.reason,
              usage: input.usage,
              ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
              context: {
                agentRunId: context.agentRunId,
                agentIdentityId: context.actorId,
                modelProvider: context.modelProvider,
                modelName: context.modelName,
                promptIdentity: context.promptIdentity,
              },
            })
          }
          case 'torchiko.prospects.release_research_job': {
            const input = releaseResearchInput.parse(rawInput)
            return finishProspectResearchJobAction({
              ...input,
              outcome: 'RELEASED',
              context: {
                agentRunId: context.agentRunId,
                agentIdentityId: context.actorId,
                modelProvider: context.modelProvider,
                modelName: context.modelName,
                promptIdentity: context.promptIdentity,
              },
            })
          }
          case 'torchiko.prospects.save_outreach_draft': {
            const input = draftInput.parse(rawInput)
            const resolvedCopySources = await Promise.all(
              input.copySources.map(async (requested) => {
                const version = Number(requested.version)
                const item = await db.companyKnowledgeItem.findFirst({
                  where: {
                    id: requested.id,
                    accessScope: 'PLATFORM',
                    type: 'POLICY_CONTEXT',
                    OR: [
                      { promotionStatus: 'PROMOTED', authority: 'AUTHORITATIVE_CURRENT' },
                      {
                        promotionStatus: 'CANDIDATE',
                        authority: { in: ['DURABLE_CONTEXT', 'INFERENCE'] },
                      },
                    ],
                    currentRevision: version,
                    archivedAt: null,
                    supersededAt: null,
                  },
                  select: {
                    id: true,
                    currentRevision: true,
                    promotionStatus: true,
                    revisions: {
                      where: { revision: version },
                      take: 1,
                      select: { sourceDigest: true, structuredData: true },
                    },
                  },
                })
                const revision = item?.revisions[0]
                const structured = revision?.structuredData as { allowedUses?: unknown } | undefined
                const allowedUses = Array.isArray(structured?.allowedUses)
                  ? structured.allowedUses.filter(
                      (value): value is 'OUTREACH' | 'FOLLOW_UP' | 'PROPOSAL' =>
                        value === 'OUTREACH' || value === 'FOLLOW_UP' || value === 'PROPOSAL',
                    )
                  : []
                if (!item || !revision || !allowedUses.includes('OUTREACH'))
                  throw new ProspectAgentRegistryError(
                    'OUT_OF_SCOPE',
                    'Copy source is stale, ineligible, or unavailable for outreach',
                  )
                return {
                  id: item.id,
                  version: String(item.currentRevision),
                  status:
                    item.promotionStatus === 'PROMOTED'
                      ? ('APPROVED' as const)
                      : ('PROPOSED' as const),
                  allowedUses,
                  provenance: revision.sourceDigest,
                }
              }),
            )
            const copyHandoff = validateProspectCopyHandoff({
              ...input,
              copySources: resolvedCopySources,
            })
            const member = await db.prospectCampaignMember.findFirst({
              where: { id: input.memberId, organization: organizationScope(context) },
              select: { id: true, venueId: true },
            })
            if (!member)
              throw new ProspectAgentRegistryError(
                'OUT_OF_SCOPE',
                'Campaign member is out of scope',
              )
            let selectedAsset: Awaited<ReturnType<typeof selectProspectLaunchAsset>> | undefined
            if (input.launchAssetSelection) {
              if (!member.venueId)
                throw new ProspectAgentRegistryError(
                  'STATE_HELD',
                  'A current converted venue is required before attaching its QR',
                )
              try {
                selectedAsset = await selectProspectLaunchAsset(
                  member.venueId,
                  input.launchAssetSelection,
                )
              } catch {
                throw new ProspectAgentRegistryError(
                  'STATE_HELD',
                  'Selected venue QR is stale or unavailable; list current assets and choose again',
                )
              }
            }
            const verifiedCurrentPrintAssets =
              selectedAsset?.schema === 'torchiko.venue-launch-asset/2' &&
              selectedAsset.format === 'PDF' &&
              member.venueId
                ? [{ prospectVenueId: member.venueId, asset: selectedAsset }]
                : undefined
            const saved = await saveProspectOutreachDraftAction({
              memberId: input.memberId,
              subject: input.subject,
              textBody: input.textBody,
              groundingSnapshot: {
                schemaVersion: 1,
                evidence: input.evidence.map((item) => ({
                  ...item,
                  trust:
                    item.kind === 'CRM_FIELD'
                      ? 'CANONICAL_CRM_DATA'
                      : 'UNTRUSTED_EXTERNAL_EVIDENCE',
                })),
                template: input.template,
                prompt: input.prompt,
                warnings: input.warnings,
                ...(selectedAsset ? { launchAttachments: [selectedAsset] } : {}),
                copyHandoff,
                lineage: {
                  agentRunId: context.agentRunId,
                  agentIdentityId: context.actorId,
                  initiatorId: context.initiatorId,
                  modelProvider: context.modelProvider,
                  modelName: context.modelName,
                  runPromptIdentity: context.promptIdentity,
                  correlationId: context.correlationId,
                },
              },
              ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
              ...(verifiedCurrentPrintAssets ? { verifiedCurrentPrintAssets } : {}),
              // The domain action retains its compatibility capability spelling. The registry
              // is the server-authoritative boundary and has already verified the AgentRun.
              actor: { type: 'AGENT', id: context.actorId, capabilities: ['prospects:draft'] },
            })
            return { id: saved.id, status: saved.status, version: saved.version }
          }
          case 'torchiko.prospects.ask_operator': {
            const input = questionInput.parse(rawInput)
            return askAgentQuestionAction({
              operationId: input.operationId,
              tenantId: context.tenantId,
              venueId: context.venueId,
              agentIdentityId: context.actorId,
              agentRunId: context.agentRunId,
              question: input.question,
              ...(input.context ? { context: input.context } : {}),
              category: 'prospect-crm',
              urgency: input.urgency,
              ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
              blocking: input.blocking,
              evidence: input.evidence.map((item) => ({
                label: item.kind,
                reference: item.reference,
                ...(item.summary ? { summary: item.summary } : {}),
              })),
              callbackMetadata: { correlationId: context.correlationId },
            })
          }
        }
      })
    },
  }
}
