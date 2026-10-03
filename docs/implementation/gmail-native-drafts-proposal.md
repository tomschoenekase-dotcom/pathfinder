# Gmail native drafts: what shipped and what needs a schema change

Date: 2026-10-02. Status: partial implementation; remaining parts need a forward-only migration.

## Shipped without a migration

- `packages/api/src/correspondence/gmail-drafts.ts`: read-only `users.drafts.list` / `users.drafts.get`
  through the existing Gmail HTTP client (`createGmailApiClient` now also implements
  `GmailDraftApiClient`). Pages are bounded (100 per page, 5 pages per run).
- `reconcileGmailProviderDrafts` runs at the end of every completed `SCHEDULED_RECONCILIATION`
  job (scheduled, manual admin/MCP request, initial OAuth backfill). For each local draft that
  already carries `(provider_draft_account_id, provider_draft_id)` for that mailbox:
  - seen in a complete listing, or re-read by `drafts.get` -> kept;
  - absent from a complete listing and `drafts.get` returns 404 -> both reference columns are
    cleared with compare-and-set and an append-only audit row
    (`prospect_draft.provider_draft_absent`) records the old pair. Local draft status is never
    changed; absence is not dispatch evidence.
  - an incomplete listing concludes nothing.
- Provider drafts without a stored reference are counted (`unreferencedProviderDrafts`) and never
  linked. Job records carry counts only.

## Why the rest needs a schema change

The `20261002120000` migration stores only the provider draft ID pair. That is not enough to:

1. **Remember that a draft disappeared** without losing the reference. Today the only truthful
   representation is clearing the pair (audit keeps history). Proposed nullable columns on
   `prospect_outreach_drafts`: `provider_draft_state` (`PRESENT` | `ABSENT`),
   `provider_draft_last_seen_at`, `provider_draft_absent_at`.
2. **Map provider drafts to local drafts by message/thread ID.** Gmail replaces the draft message
   on every edit, so the mapping key must be the draft ID plus the latest observed
   `provider_draft_message_id` and `provider_draft_thread_id` (nullable `VARCHAR(191)`, both null
   until observed). Local drafts have no message or thread ID today, so there is nothing safe to
   match against; matching on recipient/subject/body would be a guess and is rejected.
3. **Tie a dispatched draft to its SENT message.** With the last observed draft message ID stored,
   inbound sync can record "provider draft dispatched" only when a SENT-labelled message with that
   exact Gmail message ID is ingested (the existing `labelAdded` history handling assumes Gmail keeps
   the message ID when a draft is sent; verify that live before relying on it). Status
   would still never become `SENT` from absence alone, and never `DELIVERED` from SENT.
4. **Create the initial link.** A reference can only be set by an exact key: either Torchiko
   creating the provider draft itself (out of scope: external write) or an operator explicitly
   attaching a draft ID through an audited action. Imports keep `gmailDraftId` as an unverified
   claim until one of those happens.

## Proposed migration (not written)

```sql
ALTER TABLE "prospect_outreach_drafts"
  ADD COLUMN "provider_draft_message_id" VARCHAR(191),
  ADD COLUMN "provider_draft_thread_id" VARCHAR(191),
  ADD COLUMN "provider_draft_state" VARCHAR(16),
  ADD COLUMN "provider_draft_last_seen_at" TIMESTAMP(3),
  ADD COLUMN "provider_draft_absent_at" TIMESTAMP(3);
-- state is null exactly when no provider draft reference exists
ALTER TABLE "prospect_outreach_drafts" ADD CONSTRAINT "prospect_outreach_drafts_provider_draft_state_check"
  CHECK ("provider_draft_state" IS NULL OR "provider_draft_state" IN ('PRESENT', 'ABSENT'));
```

With it, reconciliation would set `ABSENT` + `absent_at` instead of clearing the pair, refresh
message/thread IDs on every listing, and the operator read surfaces would expose the state.

## Also not done here

- `crm.get_mail_reconciliation` / `getGmailReconciliation` do not yet return the draft counts
  stored in the job payload (the MCP output contract lives in `packages/contracts`).
- The new disposable test `prisma-provider-draft-store.disposable.integration.test.ts` is gated on
  `RUN_OPERATOR_DB_INTEGRATION` but is not yet listed in `.github/workflows/ci.yml`.
