CREATE TABLE "public_interest_prospect_conversions" (
    "id" TEXT NOT NULL,
    "operation_id" UUID NOT NULL,
    "operation_hash" CHAR(64) NOT NULL,
    "submission_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "converted_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "public_interest_prospect_conversions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_interest_prospect_conversions_operation_id_key"
  ON "public_interest_prospect_conversions"("operation_id");
CREATE UNIQUE INDEX "public_interest_prospect_conversions_submission_id_key"
  ON "public_interest_prospect_conversions"("submission_id");
CREATE UNIQUE INDEX "public_interest_prospect_conversions_organization_id_key"
  ON "public_interest_prospect_conversions"("organization_id");
CREATE UNIQUE INDEX "public_interest_prospect_conversions_venue_id_key"
  ON "public_interest_prospect_conversions"("venue_id");
CREATE UNIQUE INDEX "public_interest_prospect_conversions_contact_id_key"
  ON "public_interest_prospect_conversions"("contact_id");

ALTER TABLE "public_interest_prospect_conversions"
  ADD CONSTRAINT "public_interest_prospect_conversions_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "public_interest_submissions"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "public_interest_prospect_conversions"
  ADD CONSTRAINT "public_interest_prospect_conversions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "public_interest_prospect_conversions"
  ADD CONSTRAINT "public_interest_prospect_conversions_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "public_interest_prospect_conversions"
  ADD CONSTRAINT "public_interest_prospect_conversions_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "reject_public_interest_prospect_conversion_mutation"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'public interest prospect conversion evidence is append-only';
END;
$$;

CREATE TRIGGER "public_interest_prospect_conversion_update_guard"
  BEFORE UPDATE ON "public_interest_prospect_conversions"
  FOR EACH ROW EXECUTE FUNCTION "reject_public_interest_prospect_conversion_mutation"();

CREATE TRIGGER "public_interest_prospect_conversion_delete_guard"
  BEFORE DELETE ON "public_interest_prospect_conversions"
  FOR EACH ROW EXECUTE FUNCTION "reject_public_interest_prospect_conversion_mutation"();
