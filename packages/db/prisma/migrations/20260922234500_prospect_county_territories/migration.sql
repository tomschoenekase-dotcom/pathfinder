-- CreateTable
CREATE TABLE "prospect_geography_models" (
    "version" VARCHAR(100) NOT NULL,
    "registry_hash" CHAR(64) NOT NULL,
    "county_vintage" VARCHAR(100) NOT NULL,
    "approval_reference" VARCHAR(1000) NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL,
    "approved_by" VARCHAR(191) NOT NULL,
    "source_manifest" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_geography_models_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "prospect_territory_definitions" (
    "model_version" VARCHAR(100) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "territory_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" VARCHAR(100) NOT NULL,
    "states" JSONB NOT NULL,

    CONSTRAINT "prospect_territory_definitions_pkey" PRIMARY KEY ("model_version","code")
);

-- CreateTable
CREATE TABLE "prospect_county_assignments" (
    "model_version" VARCHAR(100) NOT NULL,
    "county_geoid" CHAR(5) NOT NULL,
    "territory_code" VARCHAR(100) NOT NULL,
    "territory_id" TEXT NOT NULL,
    "state" CHAR(2) NOT NULL,
    "county_name" TEXT NOT NULL,

    CONSTRAINT "prospect_county_assignments_pkey" PRIMARY KEY ("model_version","county_geoid")
);

-- CreateTable
CREATE TABLE "prospect_venue_geographies" (
    "venue_id" TEXT NOT NULL,
    "model_version" VARCHAR(100) NOT NULL,
    "county_geoid" CHAR(5),
    "territory_id" TEXT,
    "legacy_territory_id" TEXT,
    "status" VARCHAR(32) NOT NULL DEFAULT 'GEO_HOLD',
    "reason" VARCHAR(2000) NOT NULL,
    "evidence_ids" JSONB NOT NULL DEFAULT '[]',
    "anchor" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by" VARCHAR(191) NOT NULL,
    "updated_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_venue_geographies_pkey" PRIMARY KEY ("venue_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prospect_geography_models_registry_hash_key" ON "prospect_geography_models"("registry_hash");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_territory_definitions_model_version_code_territory_key" ON "prospect_territory_definitions"("model_version", "code", "territory_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_territory_definitions_model_version_territory_id_key" ON "prospect_territory_definitions"("model_version", "territory_id");

-- CreateIndex
CREATE INDEX "prospect_county_assignments_model_version_territory_code_idx" ON "prospect_county_assignments"("model_version", "territory_code");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_county_assignments_model_version_county_geoid_terr_key" ON "prospect_county_assignments"("model_version", "county_geoid", "territory_id");

-- CreateIndex
CREATE INDEX "prospect_venue_geographies_model_version_status_territory_i_idx" ON "prospect_venue_geographies"("model_version", "status", "territory_id");

-- CreateIndex
CREATE INDEX "prospect_venue_geographies_legacy_territory_id_status_idx" ON "prospect_venue_geographies"("legacy_territory_id", "status");

-- AddForeignKey
ALTER TABLE "prospect_territory_definitions" ADD CONSTRAINT "prospect_territory_definitions_model_version_fkey" FOREIGN KEY ("model_version") REFERENCES "prospect_geography_models"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "prospect_territory_definitions" ADD CONSTRAINT "prospect_territory_definitions_territory_id_fkey" FOREIGN KEY ("territory_id") REFERENCES "prospect_territories"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "prospect_county_assignments" ADD CONSTRAINT "prospect_county_assignments_model_version_territory_code_t_fkey" FOREIGN KEY ("model_version", "territory_code", "territory_id") REFERENCES "prospect_territory_definitions"("model_version", "code", "territory_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "prospect_venue_geographies" ADD CONSTRAINT "prospect_venue_geographies_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "prospect_venue_geographies" ADD CONSTRAINT "prospect_venue_geographies_model_version_fkey" FOREIGN KEY ("model_version") REFERENCES "prospect_geography_models"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "prospect_venue_geographies" ADD CONSTRAINT "prospect_venue_geographies_model_version_county_geoid_terr_fkey" FOREIGN KEY ("model_version", "county_geoid", "territory_id") REFERENCES "prospect_county_assignments"("model_version", "county_geoid", "territory_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "prospect_venue_geographies" ADD CONSTRAINT "prospect_venue_geographies_legacy_territory_id_fkey" FOREIGN KEY ("legacy_territory_id") REFERENCES "prospect_territories"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Geography evidence is distinct from arbitrary labels and cannot express a half assignment.
ALTER TABLE "prospect_venue_geographies" ADD CONSTRAINT "prospect_geo_state_check" CHECK (
  (status = 'ASSIGNED' AND county_geoid IS NOT NULL AND territory_id IS NOT NULL
   AND jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)>0)
  OR (status IN ('GEO_HOLD','IDENTITY_REVIEW','OUT_OF_SCOPE') AND county_geoid IS NULL AND territory_id IS NULL)
);
ALTER TABLE "prospect_county_assignments" ADD CONSTRAINT "prospect_county_geoid_check" CHECK (county_geoid ~ '^[0-9]{5}$');

CREATE FUNCTION prospect_frozen_geography_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Approved geography is immutable; append a new version instead' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER prospect_geography_models_frozen BEFORE UPDATE OR DELETE ON prospect_geography_models
 FOR EACH ROW EXECUTE FUNCTION prospect_frozen_geography_guard();
CREATE TRIGGER prospect_territory_definitions_frozen BEFORE UPDATE OR DELETE ON prospect_territory_definitions
 FOR EACH ROW EXECUTE FUNCTION prospect_frozen_geography_guard();
CREATE TRIGGER prospect_county_assignments_frozen BEFORE UPDATE OR DELETE ON prospect_county_assignments
 FOR EACH ROW EXECUTE FUNCTION prospect_frozen_geography_guard();
CREATE TRIGGER prospect_venue_geography_retained BEFORE DELETE ON prospect_venue_geographies
 FOR EACH ROW EXECUTE FUNCTION prospect_frozen_geography_guard();

-- Old generic CRM mutations cannot bypass reviewed physical-county admission by setting a new code.
-- Deferred checking allows the canonical geography transaction to update both sides atomically.
CREATE FUNCTION prospect_geography_native_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; native_territory text; geo_status text; geo_territory text;
BEGIN
  IF TG_TABLE_NAME='prospect_venues' THEN target=NEW.id; ELSE target=NEW.venue_id; END IF;
  SELECT territory_id INTO native_territory FROM prospect_venues WHERE id=target;
  SELECT status,territory_id INTO geo_status,geo_territory FROM prospect_venue_geographies WHERE venue_id=target;
  IF geo_status='ASSIGNED' AND native_territory IS DISTINCT FROM geo_territory THEN
    RAISE EXCEPTION 'Native territory must match reviewed physical geography' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM prospect_territory_definitions WHERE territory_id=native_territory)
     AND (geo_status IS DISTINCT FROM 'ASSIGNED' OR geo_territory IS DISTINCT FROM native_territory) THEN
    RAISE EXCEPTION 'Research territory requires admitted physical-county evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER prospect_native_territory_consistency AFTER INSERT OR UPDATE OF territory_id ON prospect_venues
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prospect_geography_native_consistency();
CREATE CONSTRAINT TRIGGER prospect_geography_territory_consistency AFTER INSERT OR UPDATE ON prospect_venue_geographies
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prospect_geography_native_consistency();

CREATE FUNCTION prospect_geography_address_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.address_line_1,NEW.address_line_2,NEW.city,NEW.region,NEW.postal_code,NEW.country)
    IS DISTINCT FROM (OLD.address_line_1,OLD.address_line_2,OLD.city,OLD.region,OLD.postal_code,OLD.country)
    AND EXISTS(SELECT 1 FROM prospect_venue_geographies WHERE venue_id=OLD.id AND status='ASSIGNED') THEN
  RAISE EXCEPTION 'Location changed: review and invalidate the existing county assignment before editing the physical location' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER prospect_physical_address_guard BEFORE UPDATE ON prospect_venues
 FOR EACH ROW EXECUTE FUNCTION prospect_geography_address_guard();
