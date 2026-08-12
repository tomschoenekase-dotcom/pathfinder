import { z } from 'zod'

export const RetentionPolicyAction = z.enum(['RETAIN', 'DELETE', 'ANONYMIZE'])
export type RetentionPolicyAction = z.infer<typeof RetentionPolicyAction>

export const RetentionDecisionKey = z.enum([
  'account-and-access',
  'approved-venue-content',
  'content-history-and-provenance',
  'guest-conversations',
  'analytics-and-reports',
  'ai-usage-and-cost',
  'support-client-visible',
  'support-internal',
  'agent-and-approval-evidence',
  'intake-sources-and-evidence',
  'offboarding-evidence-and-exports',
  'billing-and-commercial-records',
])
export type RetentionDecisionKey = z.infer<typeof RetentionDecisionKey>

export const RetentionPolicyDecision = z
  .object({
    decisionKey: RetentionDecisionKey,
    action: RetentionPolicyAction,
    retentionDays: z.number().int().min(1).max(36_500).nullable(),
    rationale: z.string().trim().min(1).max(2_000),
    approvedBy: z.string().trim().min(1).max(200),
    approvedAt: z.string().datetime({ offset: true }),
    policyVersion: z.string().trim().min(1).max(100),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.action === 'RETAIN' && decision.retentionDays !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retentionDays'],
        message: 'Indefinite retention uses a null duration',
      })
    }
    if (decision.action !== 'RETAIN' && decision.retentionDays === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retentionDays'],
        message: 'Deletion and anonymization require an approved duration',
      })
    }
  })
export type RetentionPolicyDecision = z.infer<typeof RetentionPolicyDecision>

export type RetentionInventoryEntry = {
  model: string
  decisionKey: RetentionDecisionKey
  containsPersonalData: boolean
  clientExportEligible: boolean
  lifecycle: 'MUTABLE' | 'VERSIONED' | 'APPEND_ONLY' | 'EXTERNAL_REFERENCE'
  deletionBoundary: 'TENANT_ROOT' | 'VENUE_ROOT' | 'RESTRICTED_EVIDENCE' | 'EXTERNAL_REVOCATION'
  notes: string
}

export const RETENTION_DATA_INVENTORY: readonly RetentionInventoryEntry[] = [
  {
    model: 'TenantMembership',
    decisionKey: 'account-and-access',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'MUTABLE',
    deletionBoundary: 'TENANT_ROOT',
    notes: 'Access must be revoked before any retention disposition is attempted.',
  },
  {
    model: 'Venue',
    decisionKey: 'approved-venue-content',
    containsPersonalData: false,
    clientExportEligible: true,
    lifecycle: 'VERSIONED',
    deletionBoundary: 'VENUE_ROOT',
    notes: 'Approved venue identity and configuration are exportable.',
  },
  {
    model: 'Place',
    decisionKey: 'approved-venue-content',
    containsPersonalData: false,
    clientExportEligible: true,
    lifecycle: 'VERSIONED',
    deletionBoundary: 'VENUE_ROOT',
    notes: 'Granular approved content remains independently exportable.',
  },
  {
    model: 'VenueKnowledgeEntry',
    decisionKey: 'approved-venue-content',
    containsPersonalData: false,
    clientExportEligible: true,
    lifecycle: 'VERSIONED',
    deletionBoundary: 'VENUE_ROOT',
    notes: 'Knowledge is part of the approved-content export.',
  },
  {
    model: 'ContentModuleIdentity',
    decisionKey: 'approved-venue-content',
    containsPersonalData: false,
    clientExportEligible: true,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Normalized typed content is immutable and needs an explicit policy mapping.',
  },
  {
    model: 'ContentVersion',
    decisionKey: 'content-history-and-provenance',
    containsPersonalData: true,
    clientExportEligible: true,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Versions may contain actor attribution and cannot be silently truncated.',
  },
  {
    model: 'VisitorSession',
    decisionKey: 'guest-conversations',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'MUTABLE',
    deletionBoundary: 'VENUE_ROOT',
    notes: 'Conversation and visitor identifiers require a privacy decision.',
  },
  {
    model: 'AnalyticsEvent',
    decisionKey: 'analytics-and-reports',
    containsPersonalData: true,
    clientExportEligible: true,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'VENUE_ROOT',
    notes: 'Raw events and derived reports may require different approved durations.',
  },
  {
    model: 'AiUsageEvent',
    decisionKey: 'ai-usage-and-cost',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Usage evidence supports cost and incident review.',
  },
  {
    model: 'SupportMessage',
    decisionKey: 'support-client-visible',
    containsPersonalData: true,
    clientExportEligible: true,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Only client-visible support belongs in a client export.',
  },
  {
    model: 'SupportRequestAuditEvent',
    decisionKey: 'support-internal',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Internal notes and audit evidence require a separate policy decision.',
  },
  {
    model: 'AgentAction',
    decisionKey: 'agent-and-approval-evidence',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Agent evidence is immutable operational audit material.',
  },
  {
    model: 'ApprovalDecision',
    decisionKey: 'agent-and-approval-evidence',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Human decision evidence cannot be removed without explicit policy.',
  },
  {
    model: 'IntakeEvidenceRecord',
    decisionKey: 'intake-sources-and-evidence',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'VERSIONED',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Source material may contain private interview or document content.',
  },
  {
    model: 'IntakeUpload',
    decisionKey: 'intake-sources-and-evidence',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'EXTERNAL_REFERENCE',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes:
      'Quarantined object locators and verification metadata require an explicit source-retention decision.',
  },
  {
    model: 'OffboardingPlan',
    decisionKey: 'offboarding-evidence-and-exports',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'APPEND_ONLY',
    deletionBoundary: 'RESTRICTED_EVIDENCE',
    notes: 'Offboarding proof and export hashes require an approved retention rule.',
  },
  {
    model: 'Tenant',
    decisionKey: 'billing-and-commercial-records',
    containsPersonalData: true,
    clientExportEligible: false,
    lifecycle: 'MUTABLE',
    deletionBoundary: 'TENANT_ROOT',
    notes: 'Commercial/account disposition depends on legal and billing policy.',
  },
] as const

export const RetentionPolicySet = z
  .object({
    policyVersion: z.string().trim().min(1).max(100),
    decisions: z.array(RetentionPolicyDecision).max(RetentionDecisionKey.options.length),
  })
  .strict()
  .superRefine((policy, context) => {
    const seen = new Set<string>()
    for (const [index, decision] of policy.decisions.entries()) {
      if (decision.policyVersion !== policy.policyVersion) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'policyVersion'],
          message: 'Decision policy version must match the policy set',
        })
      }
      if (seen.has(decision.decisionKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'decisionKey'],
          message: 'Policy decisions must be unique by decision key',
        })
      }
      seen.add(decision.decisionKey)
    }
  })
export type RetentionPolicySet = z.infer<typeof RetentionPolicySet>

export type RetentionReadiness = {
  ready: boolean
  unresolvedDecisionKeys: RetentionDecisionKey[]
  policyVersion: string | null
}

export function assessRetentionReadiness(policy: RetentionPolicySet | null): RetentionReadiness {
  if (!policy) {
    return {
      ready: false,
      unresolvedDecisionKeys: [...RetentionDecisionKey.options],
      policyVersion: null,
    }
  }
  const parsed = RetentionPolicySet.parse(policy)
  const decided = new Set(parsed.decisions.map((decision) => decision.decisionKey))
  const unresolvedDecisionKeys = RetentionDecisionKey.options.filter((key) => !decided.has(key))
  return {
    ready: unresolvedDecisionKeys.length === 0,
    unresolvedDecisionKeys,
    policyVersion: parsed.policyVersion,
  }
}

export function assertRetentionExecutionAuthorized(policy: RetentionPolicySet | null): void {
  const readiness = assessRetentionReadiness(policy)
  if (!readiness.ready) {
    throw new Error(
      `Retention execution is blocked; unresolved policy decisions: ${readiness.unresolvedDecisionKeys.join(', ')}`,
    )
  }
}
