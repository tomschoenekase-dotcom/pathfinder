ALTER TABLE "prospect_followups"
  ADD COLUMN "campaign_member_id" TEXT,
  ADD COLUMN "trigger_send_item_id" TEXT,
  ADD COLUMN "draft_id" TEXT,
  ADD COLUMN "policy_approved_by" VARCHAR(191),
  ADD COLUMN "policy_approved_at" TIMESTAMP(3),
  ADD COLUMN "readiness_checked_at" TIMESTAMP(3);

ALTER TABLE "prospect_followups"
  ADD CONSTRAINT "prospect_followups_sequence_check" CHECK ("sequence_number" BETWEEN 1 AND 2),
  ADD CONSTRAINT "prospect_followups_campaign_member_id_fkey" FOREIGN KEY ("campaign_member_id") REFERENCES "prospect_campaign_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "prospect_followups_trigger_send_item_id_fkey" FOREIGN KEY ("trigger_send_item_id") REFERENCES "prospect_send_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "prospect_followups_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "prospect_outreach_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "prospect_followups_campaign_member_id_sequence_number_key"
  ON "prospect_followups"("campaign_member_id", "sequence_number");
CREATE UNIQUE INDEX "prospect_followups_draft_id_key" ON "prospect_followups"("draft_id");
