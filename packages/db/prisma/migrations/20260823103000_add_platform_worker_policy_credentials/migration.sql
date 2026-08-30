CREATE TABLE "platform_worker_policy_credentials" (
  "id" TEXT NOT NULL,
  "issue_operation_id" UUID NOT NULL,
  "issue_operation_hash" CHAR(64) NOT NULL,
  "worker_id" VARCHAR(191) NOT NULL,
  "label" VARCHAR(200) NOT NULL,
  "capabilities" TEXT[] NOT NULL,
  "secret_prefix" VARCHAR(24) NOT NULL,
  "secret_hash" VARCHAR(255) NOT NULL,
  "hash_algorithm" "ExternalCredentialHashAlgorithm" NOT NULL DEFAULT 'ARGON2ID',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "activated_by" VARCHAR(191),
  "activated_at" TIMESTAMP(3),
  "activation_operation_id" UUID,
  "activation_hash" CHAR(64),
  "revoked_by" VARCHAR(191),
  "revoke_reason" VARCHAR(100),
  "revocation_operation_id" UUID,
  "revocation_hash" CHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_worker_policy_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_worker_policy_argon2id_only" CHECK ("hash_algorithm" = 'ARGON2ID'),
  CONSTRAINT "platform_worker_policy_capabilities_nonempty" CHECK (cardinality("capabilities") > 0),
  CONSTRAINT "platform_worker_policy_activation_complete" CHECK (
    ("activated_at" IS NULL AND "activated_by" IS NULL AND "activation_operation_id" IS NULL AND "activation_hash" IS NULL)
    OR
    ("activated_at" IS NOT NULL AND "activated_by" IS NOT NULL AND "activation_operation_id" IS NOT NULL AND "activation_hash" IS NOT NULL)
  ),
  CONSTRAINT "platform_worker_policy_revocation_complete" CHECK (
    ("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL AND "revocation_operation_id" IS NULL AND "revocation_hash" IS NULL)
    OR
    ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL AND "revocation_operation_id" IS NOT NULL AND "revocation_hash" IS NOT NULL)
  ),
  CONSTRAINT "platform_worker_policy_revoked_disabled" CHECK ("revoked_at" IS NULL OR "enabled" = false)
);

CREATE UNIQUE INDEX "platform_worker_policy_credentials_issue_operation_id_key" ON "platform_worker_policy_credentials"("issue_operation_id");
CREATE UNIQUE INDEX "platform_worker_policy_credentials_secret_prefix_key" ON "platform_worker_policy_credentials"("secret_prefix");
CREATE UNIQUE INDEX "platform_worker_policy_credentials_activation_operation_id_key" ON "platform_worker_policy_credentials"("activation_operation_id");
CREATE UNIQUE INDEX "platform_worker_policy_credentials_revocation_operation_id_key" ON "platform_worker_policy_credentials"("revocation_operation_id");
CREATE INDEX "platform_worker_policy_worker_state_idx" ON "platform_worker_policy_credentials"("worker_id", "enabled", "revoked_at");
