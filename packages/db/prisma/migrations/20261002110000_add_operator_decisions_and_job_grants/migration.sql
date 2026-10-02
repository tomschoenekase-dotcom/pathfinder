BEGIN;

-- Authenticated chat approvals (decision requests) and bounded job grants for the operator.
-- Forward-only and additive: two new platform-scoped tables, one enum and one nullable column on
-- operator_proposals. Nothing here changes existing rows or grants authority by itself. A decision
-- request carries no authority (only the dashboard decision route, behind a signed-in person, can
-- consume it, once). A job grant is created and revoked only by a signed-in person; its counters are
-- the remaining budget so a use is one conditional update that cannot overspend.

CREATE TYPE "OperatorDecisionRequestStatus" AS ENUM ('REQUESTED', 'DECIDED', 'EXPIRED', 'INVALIDATED');

ALTER TABLE "operator_proposals" ADD COLUMN "job_grant_id" TEXT;

CREATE TABLE "operator_decision_requests" (
  "id" TEXT NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "client_id" VARCHAR(64) NOT NULL,
  "args_hash" CHAR(64) NOT NULL,
  "preview_digest" CHAR(64),
  "target_version" VARCHAR(191),
  "status" "OperatorDecisionRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "decision" VARCHAR(16),
  "decided_by_user_id" VARCHAR(191),
  "decided_at" TIMESTAMP(3),
  "result_status" VARCHAR(32),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operator_decision_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operator_decision_requests_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('approve', 'reject')),
  -- A request is DECIDED exactly when it names who decided what and when.
  CONSTRAINT "operator_decision_requests_decided_check"
    CHECK (("status" = 'DECIDED') = ("decision" IS NOT NULL AND "decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL))
);

CREATE TABLE "operator_job_grants" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "client_id" VARCHAR(64) NOT NULL,
  "created_by_user_id" VARCHAR(191) NOT NULL,
  "target_tenant_id" VARCHAR(191) NOT NULL,
  "target_venue_id" VARCHAR(191),
  "allowed_kinds" TEXT[],
  "max_executions" INTEGER NOT NULL,
  "remaining_executions" INTEGER NOT NULL,
  "max_amount_cents" INTEGER,
  "remaining_amount_cents" INTEGER,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "revoked_by_user_id" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operator_job_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operator_job_grants_bounds_check" CHECK (
    "max_executions" BETWEEN 1 AND 1000
    AND "remaining_executions" BETWEEN 0 AND "max_executions"
    AND cardinality("allowed_kinds") BETWEEN 1 AND 20
    AND ("max_amount_cents" IS NULL) = ("remaining_amount_cents" IS NULL)
    AND ("max_amount_cents" IS NULL OR ("max_amount_cents" >= 0 AND "remaining_amount_cents" BETWEEN 0 AND "max_amount_cents"))
    AND "expires_at" > "created_at"
  )
);

CREATE INDEX "operator_proposals_job_grant_idx" ON "operator_proposals"("job_grant_id");
CREATE INDEX "operator_decision_requests_proposal_status_idx" ON "operator_decision_requests"("proposal_id", "status");
CREATE INDEX "operator_decision_requests_status_expires_idx" ON "operator_decision_requests"("status", "expires_at");
CREATE INDEX "operator_job_grants_client_tenant_expires_idx" ON "operator_job_grants"("client_id", "target_tenant_id", "expires_at");
CREATE INDEX "operator_job_grants_created_idx" ON "operator_job_grants"("created_at");

ALTER TABLE "operator_proposals" ADD CONSTRAINT "operator_proposals_job_grant_id_fkey"
  FOREIGN KEY ("job_grant_id") REFERENCES "operator_job_grants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "operator_decision_requests" ADD CONSTRAINT "operator_decision_requests_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "operator_proposals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "operator_decision_requests" ADD CONSTRAINT "operator_decision_requests_grant_id_fkey"
  FOREIGN KEY ("grant_id") REFERENCES "operator_grants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "operator_job_grants" ADD CONSTRAINT "operator_job_grants_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "operator_oauth_clients"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
