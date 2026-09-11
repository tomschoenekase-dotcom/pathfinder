CREATE TYPE "ProspectOnboardingDeliveryAttemptStatus" AS ENUM ('DRAFT');
CREATE UNIQUE INDEX "prospect_email_messages_onboarding_scope_key" ON "prospect_email_messages"("id", "organization_id", "venue_id", "contact_id");
CREATE UNIQUE INDEX "prospect_inbound_reply_reviews_onboarding_scope_key" ON "prospect_inbound_reply_reviews"("id", "message_id", "organization_id", "disposition");

CREATE TABLE "prospect_onboarding_delivery_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "idempotency_key" VARCHAR(191) NOT NULL,
  "status" "ProspectOnboardingDeliveryAttemptStatus" NOT NULL DEFAULT 'DRAFT', "organization_id" TEXT NOT NULL,
  "prospect_venue_id" TEXT NOT NULL, "contact_id" TEXT NOT NULL, "source_message_id" TEXT NOT NULL,
  "source_review_id" UUID NOT NULL, "source_reference" VARCHAR(1000), "recipient_email_snapshot" VARCHAR(320) NOT NULL,
  "recipient_identity_hash" CHAR(64) NOT NULL, "template_version" VARCHAR(64) NOT NULL,
  "subject" VARCHAR(998) NOT NULL, "text_body" TEXT NOT NULL, "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_onboarding_delivery_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_onboarding_delivery_attempts_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "prospect_onboarding_delivery_attempts_venue_fkey" FOREIGN KEY ("prospect_venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "prospect_onboarding_delivery_attempts_contact_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "prospect_onboarding_delivery_attempts_message_fkey" FOREIGN KEY ("source_message_id") REFERENCES "prospect_email_messages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "prospect_onboarding_delivery_attempts_review_fkey" FOREIGN KEY ("source_review_id") REFERENCES "prospect_inbound_reply_reviews"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "prospect_onboarding_delivery_attempts_hash_check" CHECK ("recipient_identity_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "prospect_onboarding_delivery_attempts_text_check" CHECK (length(btrim("idempotency_key"))>0 AND length(btrim("created_by"))>0 AND length(btrim("template_version"))>0 AND length(btrim("subject"))>0 AND length(btrim("text_body"))>0)
);
CREATE UNIQUE INDEX "prospect_onboarding_delivery_attempts_idempotency_key" ON "prospect_onboarding_delivery_attempts"("idempotency_key");
CREATE UNIQUE INDEX "prospect_onboarding_delivery_attempts_message_venue_key" ON "prospect_onboarding_delivery_attempts"("source_message_id", "prospect_venue_id");
CREATE INDEX "prospect_onboarding_delivery_attempts_org_status_idx" ON "prospect_onboarding_delivery_attempts"("organization_id", "status", "created_at");
CREATE INDEX "prospect_onboarding_delivery_attempts_venue_status_idx" ON "prospect_onboarding_delivery_attempts"("prospect_venue_id", "status", "created_at");

CREATE FUNCTION guard_prospect_onboarding_delivery_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM ('positive-interest:' || NEW.source_message_id || ':' || NEW.prospect_venue_id) THEN RAISE EXCEPTION 'onboarding idempotency key mismatch'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM prospect_email_messages message
    JOIN prospect_inbound_reply_reviews review ON review.id=NEW.source_review_id AND review.message_id=message.id AND review.organization_id=message.organization_id
    JOIN prospect_venues venue ON venue.id=NEW.prospect_venue_id AND venue.organization_id=message.organization_id
    JOIN prospect_contacts contact ON contact.id=NEW.contact_id AND contact.organization_id=message.organization_id AND (contact.venue_id IS NULL OR contact.venue_id=message.venue_id)
    WHERE message.id=NEW.source_message_id AND message.organization_id=NEW.organization_id
      AND message.venue_id=NEW.prospect_venue_id AND message.contact_id=NEW.contact_id
      AND message.inbound_reply_review_id=review.id AND review.disposition='POSITIVE_INTEREST'
      AND lower(btrim(message.from_address))=lower(btrim(NEW.recipient_email_snapshot))
      AND contact.normalized_email IS NOT NULL AND lower(contact.normalized_email)=lower(btrim(NEW.recipient_email_snapshot))
    FOR SHARE OF message, review, venue, contact
  ) THEN RAISE EXCEPTION 'onboarding attempt requires exact current positive reply scope'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "prospect_onboarding_delivery_attempts_insert_guard" BEFORE INSERT ON "prospect_onboarding_delivery_attempts" FOR EACH ROW EXECUTE FUNCTION guard_prospect_onboarding_delivery_attempt();
CREATE TRIGGER "prospect_onboarding_delivery_attempts_immutable" BEFORE UPDATE OR DELETE ON "prospect_onboarding_delivery_attempts" FOR EACH ROW EXECUTE FUNCTION reject_immutable_receipt_mutation();
CREATE TRIGGER "prospect_onboarding_delivery_attempts_no_truncate" BEFORE TRUNCATE ON "prospect_onboarding_delivery_attempts" FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_receipt_mutation();
