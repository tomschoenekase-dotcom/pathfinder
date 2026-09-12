// Generated from canonical TypeScript; do not edit.
// Regenerate: node scripts/generate-guest-disposition-runtime.mjs --write
import { createHash } from 'node:crypto';
/** Server-owned first-slice authority. This records accepted implementation scope,
 * not a legal approval date or a claim that every privacy obligation is resolved.
 */
const policy = {
    version: 'guest-conversations-terminal-text-v1',
    decisionKey: 'guest-conversations',
    scope: 'EXACT_SESSION_TERMINAL_TEXT_CONTENT_ERASURE',
    retentionDays: 365,
    authority: {
        designSha256: '53e4bc210d0433fe66df2cc85f16f4590a8b695cc693a646e913c878993b2bd9',
        rootGrantSha256: '19f0d28e770952f940294261bdb05c100de7081312a7a39bebcf088958587953',
        relationInventorySha256: 'd18f47d148634a6b9dc1fe83fa3ff573fe3d3b2e8e4b33241c0132aab24f0008',
    },
    erase: {
        VisitorSession: [
            'anonymousToken',
            'latestLat',
            'latestLng',
            'pendingEngagementQuestionId',
            'pendingEngagementIsInvented',
            'pendingEngagementAskedMessageId',
            'pendingEngagementAskedAt',
        ],
        Message: ['content', 'topic'],
        GuestChatTurn: [
            'replayMetadata',
            'pendingQuestionId',
            'pendingIsInvented',
            'pendingAskedMessageId',
            'pendingAskedAt',
            'leaseToken',
            'leaseExpiresAt',
        ],
        GuestChatProviderOperation: ['leaseToken', 'leaseExpiresAt'],
        EngagementQuestionResponse: ['questionText', 'answerText', 'sentimentLabel', 'category'],
        MessageFeedback: ['reason'],
        AnalyticsEvent: ['metadata'],
    },
    hashRetirement: {
        fields: ['GuestChatTurn.requestHash', 'GuestChatTurn.responseHash'],
        rule: 'DOMAIN_SEPARATED_OPERATION_TENANT_VENUE_SESSION_TURN_DIGEST_NO_CONTENT_INPUTS',
        originalHashesInJournal: false,
    },
    preservedResiduals: [
        'persistent-visitor-id',
        'structural-identifiers-and-relations',
        'timestamps-and-sequences',
        'numeric-analytics',
        'settled-content-free-accounting',
    ],
    refusalScope: [
        'voice',
        'admin-notes',
        'insights-proposals-and-handoffs',
        'attribution-and-evaluation',
        'linked-operational-events',
        'any-venue-question-cluster-theme-report-analysis',
        'any-tenant-weekly-digest',
        'unresolved-holds-provider-work-or-unclassified-content',
    ],
    execution: 'SEPARATE_FENCED_MAINTENANCE_WITH_RETAINED_JOURNAL',
};
// Fixed JSON property order is part of this version's canonical byte definition.
export const GUEST_CONVERSATION_DISPOSITION_POLICY_CANONICAL = JSON.stringify(policy);
export const GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256 = createHash('sha256')
    .update(GUEST_CONVERSATION_DISPOSITION_POLICY_CANONICAL, 'utf8')
    .digest('hex');
export function resolveGuestConversationDispositionPolicy(version, sha256) {
    if (version !== policy.version || sha256 !== GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256)
        return null;
    // Return a new object so callers cannot mutate the registry or future resolutions.
    return JSON.parse(GUEST_CONVERSATION_DISPOSITION_POLICY_CANONICAL);
}
export const GUEST_CONVERSATION_DISPOSITION_POLICY_VERSION = policy.version;
