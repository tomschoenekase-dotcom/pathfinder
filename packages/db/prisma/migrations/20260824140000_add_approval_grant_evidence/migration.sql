CREATE TABLE "approval_grant_evidence" (
  "tenant_id" TEXT NOT NULL,
  "approval_grant_id" TEXT NOT NULL,
  "outcome_observation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "approval_grant_evidence_pkey"
    PRIMARY KEY ("approval_grant_id", "outcome_observation_id"),
  CONSTRAINT "approval_grant_evidence_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "approval_grant_evidence_approval_grant_id_tenant_id_fkey"
    FOREIGN KEY ("approval_grant_id", "tenant_id") REFERENCES "approval_grants"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "approval_grant_evidence_outcome_observation_id_tenant_id_fkey"
    FOREIGN KEY ("outcome_observation_id", "tenant_id") REFERENCES "agent_outcome_observations"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "approval_grant_evidence_outcome_idx"
  ON "approval_grant_evidence"("tenant_id", "outcome_observation_id");
