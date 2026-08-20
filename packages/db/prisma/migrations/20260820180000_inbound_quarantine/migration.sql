CREATE TABLE "prospect_inbound_quarantines" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT,
    "provider_account_id" TEXT,
    "reason" VARCHAR(100) NOT NULL,
    "detail" VARCHAR(2000) NOT NULL,
    "message_snapshot" JSONB,
    "candidate_thread_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" VARCHAR(191),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prospect_inbound_quarantines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prospect_inbound_quarantines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "prospect_email_webhook_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "prospect_inbound_quarantines_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "prospect_inbound_quarantines_status_occurred_at_idx"
ON "prospect_inbound_quarantines"("status", "occurred_at");
CREATE INDEX "prospect_inbound_quarantines_provider_account_id_occurred_at_idx"
ON "prospect_inbound_quarantines"("provider_account_id", "occurred_at");
