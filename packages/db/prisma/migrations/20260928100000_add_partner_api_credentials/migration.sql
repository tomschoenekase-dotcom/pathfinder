CREATE TABLE "partner_api_credentials" (
    "id" TEXT NOT NULL,
    "public_id" VARCHAR(32) NOT NULL,
    "secret_hmac" CHAR(64) NOT NULL,
    "environment" VARCHAR(16) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "venue_ids" TEXT[] NOT NULL,
    "capabilities" TEXT[] NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "created_by_user_id" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(500),
    "rotated_from_id" TEXT,
    CONSTRAINT "partner_api_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "partner_api_credentials_public_id_key" UNIQUE ("public_id"),
    CONSTRAINT "partner_api_credentials_id_tenant_key" UNIQUE ("id", "tenant_id"),
    CONSTRAINT "partner_api_credentials_scope_arrays_check" CHECK (
      cardinality("venue_ids") <= 500 AND cardinality("capabilities") <= 6
    ),
    CONSTRAINT "partner_api_credentials_environment_check" CHECK ("environment" IN ('dev', 'test', 'live')),
    CONSTRAINT "partner_api_credentials_client_tenant_check" CHECK ("client_id" = "tenant_id"),
    CONSTRAINT "partner_api_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "partner_api_credentials_rotated_from_tenant_fkey" FOREIGN KEY ("rotated_from_id", "tenant_id") REFERENCES "partner_api_credentials"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "partner_api_credentials_scope_state_idx" ON "partner_api_credentials"("tenant_id", "client_id", "revoked_at");
CREATE INDEX "partner_api_credentials_tenant_created_idx" ON "partner_api_credentials"("tenant_id", "created_at");
CREATE INDEX "partner_api_credentials_rotated_from_idx" ON "partner_api_credentials"("rotated_from_id");
