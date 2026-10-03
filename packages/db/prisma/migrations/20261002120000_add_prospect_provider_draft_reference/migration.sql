-- Provider draft IDs are distinct from local draft IDs and Gmail message/thread IDs.
-- Existing local drafts have no provider draft and remain null.
ALTER TABLE "prospect_outreach_drafts"
  ADD COLUMN "provider_draft_account_id" TEXT,
  ADD COLUMN "provider_draft_id" VARCHAR(191);

ALTER TABLE "prospect_outreach_drafts"
  ADD CONSTRAINT "prospect_outreach_drafts_provider_draft_pair_check"
  CHECK (("provider_draft_account_id" IS NULL) = ("provider_draft_id" IS NULL));

CREATE UNIQUE INDEX "prospect_outreach_drafts_provider_draft_key"
  ON "prospect_outreach_drafts"("provider_draft_account_id", "provider_draft_id");

ALTER TABLE "prospect_outreach_drafts"
  ADD CONSTRAINT "prospect_outreach_drafts_provider_draft_account_id_fkey"
  FOREIGN KEY ("provider_draft_account_id")
  REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
