# Privacy and retention activation

The public `/privacy` route is intentionally a blocking notice until approved policy text exists. It must not be presented as legal policy.

## Exact owner/legal decisions still required

The decision keys are executable contracts in `packages/contracts/src/retention-policy.ts`. Tom, with appropriate legal review, must approve an action, duration where applicable, reason, policy version, and approval reference for each:

1. approved venue content;
2. content history and provenance;
3. guest conversations and visitor identifiers;
4. analytics and reports;
5. AI usage and cost evidence;
6. client-visible support;
7. internal support evidence;
8. agent and approval evidence;
9. intake sources, quarantined uploads, and verification evidence;
10. offboarding evidence and exports;
11. billing and commercial records;
12. any remaining key returned by `RetentionDecisionKey.options` after contract changes.

Each decision must also specify legal holds, backup/restore treatment, derived-record handling, object-storage version deletion, provider-side deletion obligations, and who may authorize or verify execution.

## Safe manual export/deletion runbook

1. Confirm the exact tenant and venue identifiers with two independent read-only views. Never act from a display name alone.
2. Pause venue availability and new intake. Do not delete before export and revocation evidence is complete.
3. Use the offboarding preview and finalized bounded export artifact. Record artifact hash, record counts, omissions, and storage version.
4. Revoke user and machine credentials through their normal lifecycle actions. Record each result.
5. Run a dry-run dependency inventory grouped by the retention registry. Treat restricted and append-only evidence as blocked unless its approved rule explicitly permits action.
6. Obtain owner approval for the exact inventory and policy version. A client request alone does not override legal holds or immutable-evidence requirements.
7. Execute only a reviewed, tenant-scoped procedure in dependency order. There is no approved general executor in this repository today; direct ad hoc SQL is prohibited.
8. Verify database counts, object versions, provider-side records, search indexes, derived reports, and access revocation. Produce an immutable receipt without copying deleted content.
9. Test the effect of a backup restore and document any records that can reappear. Reapply approved deletion if required.

Current blocker: steps 6–9 cannot be automated until every retention decision is approved and a reviewed executor exists.
