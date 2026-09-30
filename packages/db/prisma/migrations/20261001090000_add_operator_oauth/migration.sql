BEGIN;

-- Dot operator OAuth 2.1 authorization server and approval layer.
-- Forward-only and additive: new platform-owned tables, no change to existing rows or flags.
-- Nothing here grants authority: a grant exists only after a platform admin consents.
-- CreateEnum
CREATE TYPE "OperatorProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'APPLIED', 'FAILED', 'STALE', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OperatorTokenKind" AS ENUM ('ACCESS', 'REFRESH');

-- CreateEnum
CREATE TYPE "OperatorAutonomyMode" AS ENUM ('ASK', 'AUTO');

-- CreateTable
CREATE TABLE "operator_oauth_clients" (
    "id" VARCHAR(64) NOT NULL,
    "client_name" VARCHAR(120) NOT NULL,
    "redirect_uris" TEXT[],
    "registration_ip_hash" CHAR(64) NOT NULL,
    "consented_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_grants" (
    "id" TEXT NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "user_id" VARCHAR(191) NOT NULL,
    "all_tenants" BOOLEAN NOT NULL,
    "tenant_ids" TEXT[],
    "capabilities" TEXT[],
    "resource" VARCHAR(2048) NOT NULL,
    "scope" VARCHAR(191) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" VARCHAR(191),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_authorization_codes" (
    "id" TEXT NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "kid" VARCHAR(16) NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "grant_id" TEXT NOT NULL,
    "redirect_uri" VARCHAR(2048) NOT NULL,
    "code_challenge" CHAR(43) NOT NULL,
    "resource" VARCHAR(2048) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_tokens" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "kind" "OperatorTokenKind" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "kid" VARCHAR(16) NOT NULL,
    "family_id" VARCHAR(64) NOT NULL,
    "parent_id" TEXT,
    "audience" VARCHAR(2048) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_plans" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "operation_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "args_hash" CHAR(64) NOT NULL,
    "status" "OperatorProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_user_id" VARCHAR(191),
    "decided_at" TIMESTAMP(3),
    "apply_claimed_at" TIMESTAMP(3),
    "failed_step_index" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_proposals" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "operation_id" UUID NOT NULL,
    "kind" VARCHAR(120) NOT NULL,
    "tool" VARCHAR(120) NOT NULL,
    "capability" VARCHAR(120) NOT NULL,
    "target_tenant_id" VARCHAR(191),
    "target_venue_id" VARCHAR(191),
    "target_ref" VARCHAR(191),
    "args" JSONB NOT NULL,
    "args_hash" CHAR(64) NOT NULL,
    "target_version" VARCHAR(191),
    "status" "OperatorProposalStatus" NOT NULL DEFAULT 'PENDING',
    "plan_id" TEXT,
    "plan_step_index" INTEGER,
    "revert_of_id" TEXT,
    "decided_by_user_id" VARCHAR(191),
    "decided_at" TIMESTAMP(3),
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "apply_claimed_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "before_snapshot" JSONB,
    "after_snapshot" JSONB,
    "result" JSONB,
    "failure_code" VARCHAR(120),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_autonomy_policies" (
    "capability" VARCHAR(120) NOT NULL,
    "mode" "OperatorAutonomyMode" NOT NULL DEFAULT 'ASK',
    "updated_by_user_id" VARCHAR(191) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_autonomy_policies_pkey" PRIMARY KEY ("capability")
);

-- CreateTable
CREATE TABLE "operator_audit_events" (
    "id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" VARCHAR(64) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(64) NOT NULL,
    "grant_id" VARCHAR(191),
    "client_id" VARCHAR(64),
    "tool" VARCHAR(120),
    "args_hash" CHAR(64),
    "redacted_args" JSONB,
    "target_tenant_id" VARCHAR(191),
    "target_venue_id" VARCHAR(191),
    "proposal_id" VARCHAR(191),
    "plan_id" VARCHAR(191),
    "actor_user_id" VARCHAR(191),
    "latency_ms" INTEGER,

    CONSTRAINT "operator_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operator_oauth_clients_ip_created_idx" ON "operator_oauth_clients"("registration_ip_hash", "created_at");

-- CreateIndex
CREATE INDEX "operator_grants_client_created_idx" ON "operator_grants"("client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "operator_authorization_codes_hash_key" ON "operator_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "operator_authorization_codes_grant_idx" ON "operator_authorization_codes"("grant_id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_tokens_hash_key" ON "operator_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "operator_tokens_grant_kind_idx" ON "operator_tokens"("grant_id", "kind");

-- CreateIndex
CREATE INDEX "operator_tokens_family_idx" ON "operator_tokens"("family_id");

-- CreateIndex
CREATE INDEX "operator_plans_status_created_idx" ON "operator_plans"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "operator_plans_grant_operation_key" ON "operator_plans"("grant_id", "operation_id");

-- CreateIndex
CREATE INDEX "operator_proposals_status_created_idx" ON "operator_proposals"("status", "created_at");

-- CreateIndex
CREATE INDEX "operator_proposals_grant_created_idx" ON "operator_proposals"("grant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "operator_proposals_grant_operation_key" ON "operator_proposals"("grant_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_proposals_plan_step_key" ON "operator_proposals"("plan_id", "plan_step_index");

-- CreateIndex
CREATE INDEX "operator_audit_events_occurred_idx" ON "operator_audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "operator_audit_events_grant_occurred_idx" ON "operator_audit_events"("grant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "operator_audit_events_type_occurred_idx" ON "operator_audit_events"("event_type", "occurred_at");

-- AddForeignKey
ALTER TABLE "operator_grants" ADD CONSTRAINT "operator_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "operator_oauth_clients"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operator_authorization_codes" ADD CONSTRAINT "operator_authorization_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "operator_oauth_clients"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operator_authorization_codes" ADD CONSTRAINT "operator_authorization_codes_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "operator_grants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operator_tokens" ADD CONSTRAINT "operator_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "operator_grants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operator_plans" ADD CONSTRAINT "operator_plans_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "operator_grants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operator_proposals" ADD CONSTRAINT "operator_proposals_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "operator_grants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operator_proposals" ADD CONSTRAINT "operator_proposals_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "operator_plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Token material is stored only as HMAC-SHA-256 hex digests.
ALTER TABLE "operator_authorization_codes"
  ADD CONSTRAINT "operator_authorization_codes_hash_hex" CHECK ("code_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "operator_tokens"
  ADD CONSTRAINT "operator_tokens_hash_hex" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "operator_proposals"
  ADD CONSTRAINT "operator_proposals_args_hash_hex" CHECK ("args_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "operator_plans"
  ADD CONSTRAINT "operator_plans_args_hash_hex" CHECK ("args_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "operator_grants"
  ADD CONSTRAINT "operator_grants_bounded_expiry" CHECK ("expires_at" <= "created_at" + INTERVAL '90 days');
ALTER TABLE "operator_proposals"
  ADD CONSTRAINT "operator_proposals_plan_step_pair" CHECK (("plan_id" IS NULL) = ("plan_step_index" IS NULL));

-- The operator audit trail is append-only. Corrections are new rows, never edits.
CREATE OR REPLACE FUNCTION pathfinder_reject_operator_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator audit events are append-only';
END;
$$;

CREATE TRIGGER "operator_audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "operator_audit_events"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_operator_audit_mutation();

CREATE TRIGGER "operator_audit_events_no_truncate"
  BEFORE TRUNCATE ON "operator_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_operator_audit_mutation();

COMMIT;
