BEGIN;

-- Offboarding execution records. Forward-only and additive: two new tenant-scoped tables and
-- three enums. Nothing here changes existing rows, deletes data, or advances an offboarding plan.
-- An execution switches things off and records what a person must still do; it never calls a
-- payment or identity provider.

CREATE TYPE "OffboardingExecutionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'REINSTATED');
CREATE TYPE "OffboardingExecutionStepKey" AS ENUM (
  'PUBLIC_ACCESS', 'SCHEDULED_WORK', 'CONNECTIONS', 'MEMBER_ACCESS',
  'BILLING', 'IDENTITY_PROVIDER', 'DATA_MANIFEST'
);
CREATE TYPE "OffboardingExecutionStepStatus" AS ENUM (
  'PENDING', 'COMPLETE', 'SKIPPED', 'FAILED', 'ACTION_REQUIRED'
);

CREATE TABLE "offboarding_executions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "status" "OffboardingExecutionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "billing_handled" BOOLEAN NOT NULL DEFAULT false,
  "billing_note" VARCHAR(500),
  "requested_by" VARCHAR(191) NOT NULL,
  "last_operation_id" UUID NOT NULL,
  "prior_state" JSONB NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "reinstated_at" TIMESTAMP(3),
  "reinstated_by" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offboarding_executions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offboarding_executions_status_check" CHECK (
    ("status" = 'IN_PROGRESS' AND "completed_at" IS NULL AND "reinstated_at" IS NULL) OR
    ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "reinstated_at" IS NULL) OR
    ("status" = 'REINSTATED' AND "completed_at" IS NOT NULL AND "reinstated_at" IS NOT NULL AND "reinstated_by" IS NOT NULL)
  ),
  CONSTRAINT "offboarding_executions_billing_note_check" CHECK (
    "billing_handled" = false OR (
      "billing_note" IS NOT NULL AND char_length(btrim("billing_note")) BETWEEN 1 AND 500
    )
  )
);

CREATE TABLE "offboarding_execution_steps" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "execution_id" TEXT NOT NULL,
  "key" "OffboardingExecutionStepKey" NOT NULL,
  "status" "OffboardingExecutionStepStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "outcome" JSONB,
  "error_code" VARCHAR(100),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offboarding_execution_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offboarding_execution_steps_error_check" CHECK (
    ("status" = 'FAILED') = ("error_code" IS NOT NULL)
  ),
  CONSTRAINT "offboarding_execution_steps_completed_check" CHECK (
    ("status" IN ('COMPLETE', 'SKIPPED', 'ACTION_REQUIRED')) = ("completed_at" IS NOT NULL)
  ),
  CONSTRAINT "offboarding_execution_steps_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "offboarding_executions_plan_key" ON "offboarding_executions"("plan_id", "tenant_id");
CREATE UNIQUE INDEX "offboarding_executions_scope_key" ON "offboarding_executions"("id", "tenant_id");
CREATE INDEX "offboarding_executions_scope_status_idx"
  ON "offboarding_executions"("tenant_id", "status", "started_at");
CREATE UNIQUE INDEX "offboarding_execution_steps_key"
  ON "offboarding_execution_steps"("execution_id", "key");
CREATE INDEX "offboarding_execution_steps_scope_idx"
  ON "offboarding_execution_steps"("tenant_id", "execution_id");

ALTER TABLE "offboarding_executions"
  ADD CONSTRAINT "offboarding_executions_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "offboarding_executions_plan_id_tenant_id_fkey" FOREIGN KEY ("plan_id", "tenant_id")
    REFERENCES "offboarding_plans"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "offboarding_execution_steps"
  ADD CONSTRAINT "offboarding_execution_steps_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "offboarding_execution_steps_execution_id_tenant_id_fkey" FOREIGN KEY ("execution_id", "tenant_id")
    REFERENCES "offboarding_executions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Execution history is evidence: it can be updated as steps settle but never removed.
CREATE TRIGGER offboarding_executions_no_delete
  BEFORE DELETE ON "offboarding_executions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_offboarding_plan_delete();
CREATE TRIGGER offboarding_executions_no_truncate
  BEFORE TRUNCATE ON "offboarding_executions"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_offboarding_plan_delete();
CREATE TRIGGER offboarding_execution_steps_no_delete
  BEFORE DELETE ON "offboarding_execution_steps"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_offboarding_plan_delete();
CREATE TRIGGER offboarding_execution_steps_no_truncate
  BEFORE TRUNCATE ON "offboarding_execution_steps"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_offboarding_plan_delete();

COMMIT;
