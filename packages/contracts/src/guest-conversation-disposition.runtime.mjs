// Generated from canonical TypeScript; do not edit.
// Regenerate: node scripts/generate-guest-disposition-runtime.mjs --write
import { z } from 'zod';
/** Conservative encoding of the accepted approximately twelve-month chat direction.
 * This is a default duration, not an approval record or an execution capability.
 */
export const GUEST_CONVERSATION_DEFAULT_RETENTION_DAYS = 365;
const scopedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const policyVersion = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/u);
const timestamp = z.string().datetime();
/** One exact session per operation. The executor must independently resolve scope,
 * policy authority, cutoff, holds, dependencies and current activity in its transaction.
 * Parsing this input neither authorizes a write nor establishes eligibility.
 */
export const GuestConversationDispositionRequest = z
    .object({
    version: z.literal('guest-conversation-disposition-v1'),
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    sessionId: scopedId,
    expectedPolicyVersion: policyVersion,
    expectedPolicySha256: sha256,
    basis: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('RETENTION_EXPIRY') }).strict(),
        z
            .object({
            kind: z.literal('SUPPORT_REQUEST'),
            supportRequestId: scopedId,
            expectedSupportRequestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
            .strict(),
    ]),
})
    .strict();
/** Produced only by the authenticated server authority resolver, never accepted
 * as a public request. Persistence does not grant maintenance EXECUTE privilege.
 */
export const GuestConversationDispositionAuthoritySnapshot = z
    .object({
    version: z.literal('guest-disposition-authority-v1'),
    actorId: scopedId,
    actorRole: z.literal('PLATFORM_ADMIN'),
    policyVersion,
    policySha256: sha256,
    retentionDays: z.literal(GUEST_CONVERSATION_DEFAULT_RETENTION_DAYS),
    holdAssessment: z
        .object({ status: z.literal('NO_KNOWN_HOLD'), referenceSha256: sha256 })
        .strict(),
    basis: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('RETENTION_EXPIRY') }).strict(),
        z
            .object({
            kind: z.literal('SUPPORT_REQUEST'),
            supportRequestId: scopedId,
            supportRequestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            reviewedRequesterUserId: scopedId,
        })
            .strict(),
    ]),
})
    .strict();
/** Stable, content-free refusal categories. Absence from an input is never proof
 * of absence in the database or an external system. No executor is exported here.
 */
export const GuestConversationDispositionRefusal = z.enum([
    'SCOPE_NOT_FOUND',
    'POLICY_NOT_RESOLVED',
    'AUTHORITY_NOT_RESOLVED',
    'SUPPORT_REQUEST_CHANGED',
    'CUTOFF_NOT_ELIGIBLE',
    'HOLD_UNRESOLVED',
    'LEGAL_HOLD',
    'OPERATION_CONFLICT',
    'ACTIVE_WORK',
    'PROVIDER_OUTCOME_UNRESOLVED',
    'VOICE_DISPOSITION_UNRESOLVED',
    'DERIVED_RECORD_DISPOSITION_UNRESOLVED',
    'AGGREGATE_LINEAGE_UNRESOLVED',
    'OPERATIONAL_EVENT_DISPOSITION_UNRESOLVED',
    'RESTRICTED_EVIDENCE_DISPOSITION_UNRESOLVED',
    'ANALYTICS_DISPOSITION_UNRESOLVED',
    'ACCOUNTING_DISPOSITION_UNRESOLVED',
    'ADMIN_NOTE_DISPOSITION_UNRESOLVED',
    'FEEDBACK_DISPOSITION_UNRESOLVED',
    'PROVIDER_RETENTION_UNRESOLVED',
    'OBJECT_DISPOSITION_UNRESOLVED',
    'RESTORE_RECONCILIATION_UNRESOLVED',
    'DURABLE_WRITE_FENCE_UNAVAILABLE',
    'MAINTENANCE_NOT_ESTABLISHED',
    'EXTERNAL_JOURNAL_UNAVAILABLE',
    'INVENTORY_BOUND_EXCEEDED',
]);
const resultIdentity = z
    .object({
    version: z.literal('guest-conversation-disposition-result-v1'),
    operationId: z.string().uuid(),
    tenantId: scopedId,
    venueId: scopedId,
    sessionId: scopedId,
    observedUtc: timestamp,
})
    .strict();
const affectedCounts = z
    .object({
    sessions: z.literal(1),
    messages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    turns: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    engagementResponses: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    feedback: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    analyticsEvents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
    .strict();
const committedEvidence = {
    databaseState: z.literal('COMMITTED'),
    requestSha256: sha256,
    resolvedPolicyVersion: policyVersion,
    resolvedPolicySha256: sha256,
    effectiveCutoffUtc: timestamp,
    databaseReceiptSha256: sha256,
    externalIntentSha256: sha256,
    affected: affectedCounts,
};
/** Operator metadata only. Digests bind bytes; they do not prove the bytes were
 * persisted. The executor must read back each corresponding durable record.
 * Retained scope identifiers remain pseudonymous, not anonymous.
 */
export const GuestConversationDispositionResult = z.discriminatedUnion('status', [
    resultIdentity
        .extend({
        status: z.literal('REFUSED'),
        databaseState: z.literal('UNCHANGED'),
        externalJournalState: z.literal('NOT_STARTED'),
        refusals: z.array(GuestConversationDispositionRefusal).min(1).max(32),
    })
        .strict(),
    resultIdentity
        .extend({
        status: z.literal('APPLIED'),
        ...committedEvidence,
        externalJournalState: z.literal('COMPLETION_DURABLE'),
        externalCompletionSha256: sha256,
    })
        .strict(),
    resultIdentity
        .extend({
        status: z.literal('REPLAY'),
        ...committedEvidence,
        externalJournalState: z.literal('COMPLETION_DURABLE'),
        externalCompletionSha256: sha256,
    })
        .strict(),
    resultIdentity
        .extend({
        status: z.literal('DB_COMMITTED_EXTERNAL_COMPLETION_PENDING'),
        ...committedEvidence,
        externalJournalState: z.literal('INTENT_DURABLE'),
        nextAction: z.literal('RECONCILE_SAME_OPERATION'),
    })
        .strict(),
    resultIdentity
        .extend({
        status: z.literal('RECONCILIATION_REQUIRED'),
        databaseState: z.enum(['UNCHANGED', 'FENCED', 'UNKNOWN']),
        externalJournalState: z.enum(['NOT_STARTED', 'INTENT_DURABLE', 'UNKNOWN']),
        reason: z.enum([
            'JOURNAL_WRITE_UNCONFIRMED',
            'JOURNAL_READBACK_FAILED',
            'DATABASE_COMMIT_UNCONFIRMED',
            'PREPARED_OPERATION_INTERRUPTED',
            'RESTORE_HISTORY_INCOMPLETE',
            'AUTHORITY_CHANGED_AFTER_FENCE',
        ]),
        nextAction: z.literal('RECONCILE_SAME_OPERATION'),
    })
        .strict(),
]);
