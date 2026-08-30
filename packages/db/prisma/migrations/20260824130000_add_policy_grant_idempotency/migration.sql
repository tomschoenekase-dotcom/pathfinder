ALTER TABLE "approval_grants"
  ADD COLUMN "operation_id" UUID,
  ADD COLUMN "issue_reason" VARCHAR(2000);

CREATE UNIQUE INDEX "approval_grants_tenant_operation_key"
  ON "approval_grants"("tenant_id", "operation_id");
