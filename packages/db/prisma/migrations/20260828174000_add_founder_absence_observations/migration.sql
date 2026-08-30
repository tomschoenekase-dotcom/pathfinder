CREATE TABLE "founder_absence_observations" (
  "id" TEXT NOT NULL,
  "observed_on" DATE NOT NULL,
  "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "release_sha" CHAR(40) NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "snapshot_hash" CHAR(64) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "evidence_complete" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "founder_absence_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "founder_absence_observations_release_sha_check"
    CHECK ("release_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "founder_absence_observations_snapshot_hash_check"
    CHECK ("snapshot_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "founder_absence_observations_schema_version_check"
    CHECK ("schema_version" = 1)
);

CREATE UNIQUE INDEX "founder_absence_observations_observed_on_key"
  ON "founder_absence_observations"("observed_on");
CREATE INDEX "founder_absence_observations_captured_idx"
  ON "founder_absence_observations"("captured_at");

CREATE FUNCTION "guard_founder_absence_observation_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'founder absence observations are immutable' USING ERRCODE = '55000';
END;
$$;

ALTER FUNCTION "guard_founder_absence_observation_immutable"() SET search_path = pg_catalog, public;

CREATE TRIGGER "founder_absence_observations_immutable"
  BEFORE UPDATE OR DELETE ON "founder_absence_observations"
  FOR EACH ROW EXECUTE FUNCTION "guard_founder_absence_observation_immutable"();
CREATE TRIGGER "founder_absence_observations_no_truncate"
  BEFORE TRUNCATE ON "founder_absence_observations"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_founder_absence_observation_immutable"();
