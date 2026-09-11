CREATE TYPE "AgentWorkflowPromotionAssessmentOutcome" AS ENUM ('EVIDENCE_READY_REVIEW_REQUIRED', 'REJECTED_OVERFIT', 'REJECTED_REGRESSION', 'INCOMPLETE_EVIDENCE');

CREATE TABLE "agent_workflow_promotion_assessments" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "workflow_version_id" UUID NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "development_validation_id" TEXT NOT NULL,
  "heldout_validation_id" TEXT NOT NULL,
  "assessment_hash" CHAR(64) NOT NULL,
  "outcome" "AgentWorkflowPromotionAssessmentOutcome" NOT NULL,
  "diagnostics" JSONB NOT NULL,
  "created_by_type" "ActorType" NOT NULL,
  "created_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_workflow_promotion_assessments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_workflow_promotion_assessments_distinct_roles_check" CHECK ("development_validation_id" <> "heldout_validation_id"),
  CONSTRAINT "agent_workflow_promotion_assessments_diagnostics_object_check" CHECK (jsonb_typeof("diagnostics") = 'object')
);

CREATE UNIQUE INDEX "agent_workflow_promotion_assessments_tenant_operation_key" ON "agent_workflow_promotion_assessments"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "agent_workflow_promotion_assessments_evidence_key" ON "agent_workflow_promotion_assessments"("workflow_version_id", "development_validation_id", "heldout_validation_id");
CREATE INDEX "agent_workflow_promotion_assessments_scope_created_idx" ON "agent_workflow_promotion_assessments"("tenant_id", "venue_id", "created_at", "id");
CREATE UNIQUE INDEX "agent_improvement_proposals_id_scope_key" ON "agent_improvement_proposals"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "agent_improvement_validations_id_scope_key" ON "agent_improvement_validation_evidence"("id", "tenant_id", "venue_id");

ALTER TABLE "agent_workflow_promotion_assessments" ADD CONSTRAINT "agent_workflow_promotion_assessments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_promotion_assessments" ADD CONSTRAINT "agent_workflow_promotion_assessments_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_promotion_assessments" ADD CONSTRAINT "agent_workflow_promotion_assessments_workflow_scope_fkey" FOREIGN KEY ("workflow_version_id", "tenant_id", "venue_id") REFERENCES "agent_workflow_versions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_promotion_assessments" ADD CONSTRAINT "agent_workflow_promotion_assessments_proposal_scope_fkey" FOREIGN KEY ("proposal_id", "tenant_id", "venue_id") REFERENCES "agent_improvement_proposals"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_promotion_assessments" ADD CONSTRAINT "agent_workflow_promotion_assessments_development_validation_scope_fkey" FOREIGN KEY ("development_validation_id", "tenant_id", "venue_id") REFERENCES "agent_improvement_validation_evidence"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_promotion_assessments" ADD CONSTRAINT "agent_workflow_promotion_assessments_heldout_validation_scope_fkey" FOREIGN KEY ("heldout_validation_id", "tenant_id", "venue_id") REFERENCES "agent_improvement_validation_evidence"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_agent_workflow_promotion_assessment_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent workflow promotion assessments are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_workflow_promotion_assessments_immutable_update" BEFORE UPDATE ON "agent_workflow_promotion_assessments" FOR EACH ROW EXECUTE FUNCTION reject_agent_workflow_promotion_assessment_mutation();
CREATE TRIGGER "agent_workflow_promotion_assessments_immutable_delete" BEFORE DELETE ON "agent_workflow_promotion_assessments" FOR EACH ROW EXECUTE FUNCTION reject_agent_workflow_promotion_assessment_mutation();
