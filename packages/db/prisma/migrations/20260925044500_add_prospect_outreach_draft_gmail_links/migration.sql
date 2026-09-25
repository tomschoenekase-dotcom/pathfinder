CREATE TABLE "prospect_outreach_draft_gmail_links" (
  "id" TEXT NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "outreach_draft_id" TEXT NOT NULL,
  "provider_draft_id" VARCHAR(191) NOT NULL,
  "provider_message_id" VARCHAR(191) NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prospect_outreach_draft_gmail_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prospect_outreach_draft_gmail_links_outreach_draft_id_key"
  ON "prospect_outreach_draft_gmail_links"("outreach_draft_id");
CREATE UNIQUE INDEX "prospect_outreach_draft_gmail_links_account_draft_key"
  ON "prospect_outreach_draft_gmail_links"("provider_account_id", "provider_draft_id");
CREATE UNIQUE INDEX "prospect_outreach_draft_gmail_links_account_message_key"
  ON "prospect_outreach_draft_gmail_links"("provider_account_id", "provider_message_id");
CREATE INDEX "prospect_outreach_draft_gmail_links_provider_account_id_created_at_idx"
  ON "prospect_outreach_draft_gmail_links"("provider_account_id", "created_at");

ALTER TABLE "prospect_outreach_draft_gmail_links"
  ADD CONSTRAINT "prospect_outreach_draft_gmail_links_provider_account_id_fkey"
  FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "prospect_outreach_draft_gmail_links"
  ADD CONSTRAINT "prospect_outreach_draft_gmail_links_outreach_draft_id_fkey"
  FOREIGN KEY ("outreach_draft_id") REFERENCES "prospect_outreach_drafts"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "reject_prospect_outreach_draft_gmail_link_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'prospect outreach draft Gmail links are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prospect_outreach_draft_gmail_links_append_only"
  BEFORE UPDATE OR DELETE ON "prospect_outreach_draft_gmail_links"
  FOR EACH ROW EXECUTE FUNCTION "reject_prospect_outreach_draft_gmail_link_mutation"();
CREATE TRIGGER "prospect_outreach_draft_gmail_links_no_truncate"
  BEFORE TRUNCATE ON "prospect_outreach_draft_gmail_links"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_prospect_outreach_draft_gmail_link_mutation"();

COMMENT ON TABLE "prospect_outreach_draft_gmail_links" IS
  'Append-only association of a verified existing Gmail draft/message ID pair to one immutable CRM outreach draft version.';
