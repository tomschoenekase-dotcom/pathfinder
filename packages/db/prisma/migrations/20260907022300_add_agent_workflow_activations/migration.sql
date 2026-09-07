-- CreateEnum
CREATE TYPE "AgentWorkflowActivationEventKind" AS ENUM ('ACTIVATE', 'ROLLBACK', 'REVOKE');

-- CreateEnum
CREATE TYPE "AgentWorkflowSelectionOutcome" AS ENUM ('SELECTED', 'CANARY_SKIPPED_NO_WORKFLOW', 'CANARY_SKIPPED_PRIOR_VERSION');

-- CreateEnum
CREATE TYPE "AgentWorkflowSelectionReason" AS ENUM ('HASH_SELECTED', 'HASH_SKIPPED', 'CAPACITY_EXHAUSTED', 'NO_ACTIVE_WORKFLOW', 'INELIGIBLE_RUN', 'WINDOW_INACTIVE');

-- CreateTable
CREATE TABLE "agent_workflow_activation_heads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "registry_key" VARCHAR(191) NOT NULL,
    "active_version_id" UUID,
    "activation_event_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "selected_run_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_workflow_activation_heads_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "agent_workflow_activation_heads" ADD CONSTRAINT "agent_workflow_activation_heads_bounds_check" CHECK ("revision" >= 0 AND "selected_run_count" >= 0);

-- CreateTable
CREATE TABLE "agent_workflow_activation_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "registry_key" VARCHAR(191) NOT NULL,
    "kind" "AgentWorkflowActivationEventKind" NOT NULL,
    "prior_version_id" UUID,
    "resulting_version_id" UUID,
    "promotion_assessment_id" TEXT,
    "approval_decision_id" TEXT NOT NULL,
    "prior_revision" INTEGER NOT NULL,
    "resulting_revision" INTEGER NOT NULL,
    "evidence_digest" CHAR(64) NOT NULL,
    "canary_policy" JSONB NOT NULL,
    "required_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "event_hash" CHAR(64) NOT NULL,
    "reason" VARCHAR(2000) NOT NULL,
    "created_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_workflow_activation_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_revision_check" CHECK ("prior_revision" >= 0 AND "resulting_revision" = "prior_revision" + 1);
ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_hash_check" CHECK ("evidence_digest" ~ '^[0-9a-f]{64}$' AND "event_hash" ~ '^[0-9a-f]{64}$' AND cardinality("required_capabilities") <= 100);
ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_kind_version_check" CHECK (("kind" = 'REVOKE' AND "resulting_version_id" IS NULL AND "promotion_assessment_id" IS NULL) OR ("kind" = 'ACTIVATE' AND "resulting_version_id" IS NOT NULL AND "promotion_assessment_id" IS NOT NULL) OR ("kind" = 'ROLLBACK' AND "resulting_version_id" IS NOT NULL AND "promotion_assessment_id" IS NULL));

-- CreateTable
CREATE TABLE "agent_workflow_run_bindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "agent_run_id" TEXT NOT NULL,
    "registry_key" VARCHAR(191) NOT NULL,
    "outcome" "AgentWorkflowSelectionOutcome" NOT NULL,
    "workflow_version_id" UUID,
    "activation_event_id" UUID,
    "head_revision" INTEGER NOT NULL,
    "selection_proof" CHAR(64) NOT NULL,
    "selection_reason" "AgentWorkflowSelectionReason" NOT NULL,
    "selection_ordinal" INTEGER,
    "binding_hash" CHAR(64) NOT NULL,
    "required_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_workflow_run_bindings_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_hash_check" CHECK ("selection_proof" ~ '^[0-9a-f]{64}$' AND "binding_hash" ~ '^[0-9a-f]{64}$' AND cardinality("required_capabilities") <= 100);
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_reason_check" CHECK (("selection_reason" = 'NO_ACTIVE_WORKFLOW' AND "outcome" = 'CANARY_SKIPPED_NO_WORKFLOW' AND "activation_event_id" IS NULL) OR "selection_reason" <> 'NO_ACTIVE_WORKFLOW');
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_outcome_check" CHECK (("outcome" = 'CANARY_SKIPPED_NO_WORKFLOW' AND "workflow_version_id" IS NULL) OR ("outcome" <> 'CANARY_SKIPPED_NO_WORKFLOW' AND "workflow_version_id" IS NOT NULL));
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_selection_check" CHECK (("selection_reason" = 'HASH_SELECTED' AND "outcome" = 'SELECTED' AND "selection_ordinal" IS NOT NULL AND "selection_ordinal" > 0) OR ("selection_reason" <> 'HASH_SELECTED' AND "selection_ordinal" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "agent_workflow_activation_heads_scope_key" ON "agent_workflow_activation_heads"("tenant_id", "venue_id", "registry_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workflow_activation_heads_id_scope_key" ON "agent_workflow_activation_heads"("id", "tenant_id", "venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workflow_activation_events_tenant_operation_key" ON "agent_workflow_activation_events"("tenant_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workflow_activation_events_id_scope_key" ON "agent_workflow_activation_events"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "agent_workflow_activation_events_id_registry_scope_key" ON "agent_workflow_activation_events"("id", "tenant_id", "venue_id", "registry_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workflow_activation_events_scope_revision_key" ON "agent_workflow_activation_events"("tenant_id", "venue_id", "registry_key", "resulting_revision");

CREATE UNIQUE INDEX "agent_workflow_promotion_assessments_id_scope_key" ON "agent_workflow_promotion_assessments"("id", "tenant_id", "venue_id");

CREATE UNIQUE INDEX "approval_decisions_id_scope_key" ON "approval_decisions"("id", "tenant_id", "venue_id");

-- CreateIndex
CREATE INDEX "agent_workflow_run_bindings_event_idx" ON "agent_workflow_run_bindings"("tenant_id", "venue_id", "activation_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workflow_run_bindings_run_key" ON "agent_workflow_run_bindings"("agent_run_id", "registry_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workflow_run_bindings_id_scope_key" ON "agent_workflow_run_bindings"("id", "tenant_id", "venue_id");

-- AddForeignKey
ALTER TABLE "agent_workflow_activation_heads" ADD CONSTRAINT "agent_workflow_activation_heads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_activation_heads" ADD CONSTRAINT "agent_workflow_activation_heads_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_activation_heads" ADD CONSTRAINT "agent_workflow_activation_heads_active_version_id_tenant_i_fkey" FOREIGN KEY ("active_version_id", "tenant_id", "venue_id") REFERENCES "agent_workflow_versions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_activation_heads" ADD CONSTRAINT "agent_workflow_activation_heads_event_scope_fkey" FOREIGN KEY ("activation_event_id", "tenant_id", "venue_id", "registry_key") REFERENCES "agent_workflow_activation_events"("id", "tenant_id", "venue_id", "registry_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_resulting_version_id_tena_fkey" FOREIGN KEY ("resulting_version_id", "tenant_id", "venue_id") REFERENCES "agent_workflow_versions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_prior_version_scope_fkey" FOREIGN KEY ("prior_version_id", "tenant_id", "venue_id") REFERENCES "agent_workflow_versions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_assessment_scope_fkey" FOREIGN KEY ("promotion_assessment_id", "tenant_id", "venue_id") REFERENCES "agent_workflow_promotion_assessments"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_workflow_activation_events" ADD CONSTRAINT "agent_workflow_activation_events_approval_scope_fkey" FOREIGN KEY ("approval_decision_id", "tenant_id", "venue_id") REFERENCES "approval_decisions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_agent_run_id_tenant_id_venue_i_fkey" FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_workflow_version_id_tenant_id__fkey" FOREIGN KEY ("workflow_version_id", "tenant_id", "venue_id") REFERENCES "agent_workflow_versions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_workflow_run_bindings" ADD CONSTRAINT "agent_workflow_run_bindings_activation_event_id_tenant_id__fkey" FOREIGN KEY ("activation_event_id", "tenant_id", "venue_id", "registry_key") REFERENCES "agent_workflow_activation_events"("id", "tenant_id", "venue_id", "registry_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_agent_workflow_activation_event_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agent workflow activation events are append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "agent_workflow_activation_events_immutable" BEFORE UPDATE OR DELETE ON "agent_workflow_activation_events" FOR EACH ROW EXECUTE FUNCTION reject_agent_workflow_activation_event_mutation();
CREATE FUNCTION reject_agent_workflow_run_binding_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agent workflow run bindings are append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "agent_workflow_run_bindings_immutable" BEFORE UPDATE OR DELETE ON "agent_workflow_run_bindings" FOR EACH ROW EXECUTE FUNCTION reject_agent_workflow_run_binding_mutation();
CREATE TRIGGER "agent_workflow_activation_events_no_truncate" BEFORE TRUNCATE ON "agent_workflow_activation_events" FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_workflow_activation_event_mutation();
CREATE TRIGGER "agent_workflow_run_bindings_no_truncate" BEFORE TRUNCATE ON "agent_workflow_run_bindings" FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_workflow_run_binding_mutation();
