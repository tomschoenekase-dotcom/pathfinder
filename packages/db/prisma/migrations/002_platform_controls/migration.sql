CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tenant_feature_flags" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flag_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "set_by" TEXT NOT NULL,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_config_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");
CREATE UNIQUE INDEX "tenant_feature_flags_tenant_id_flag_key_key" ON "tenant_feature_flags"("tenant_id", "flag_key");
CREATE INDEX "tenant_feature_flags_tenant_id_idx" ON "tenant_feature_flags"("tenant_id");

ALTER TABLE "tenant_feature_flags"
    ADD CONSTRAINT "tenant_feature_flags_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
