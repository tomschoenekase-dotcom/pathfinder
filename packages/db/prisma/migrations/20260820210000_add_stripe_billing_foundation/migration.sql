-- Stripe Billing foundation. Production activation and provider configuration remain separate,
-- default-off operator steps. This migration stores provider identifiers and sanitized billing
-- projections only; it contains no card or payment-method data.

CREATE TYPE "StripeEnvironmentMode" AS ENUM ('TEST', 'LIVE');
CREATE TYPE "BillingMode" AS ENUM ('STRIPE_SUBSCRIPTION', 'STRIPE_INVOICE', 'MANUAL_INVOICE', 'COMPLIMENTARY', 'PILOT', 'NO_BILLING_REQUIRED');
CREATE TYPE "BillingAccountStatus" AS ENUM ('UNCONFIGURED', 'PENDING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELED', 'ENDED', 'PAUSED', 'MANUAL_REVIEW');
CREATE TYPE "BillingReconciliationHealth" AS ENUM ('UNKNOWN', 'CURRENT', 'STALE', 'DRIFT', 'ERROR');
CREATE TYPE "CommercialAgreementStatus" AS ENUM ('DRAFT', 'PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELED', 'ENDED', 'PAUSED', 'MANUAL_REVIEW');
CREATE TYPE "BillingInterval" AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR', 'CUSTOM');
CREATE TYPE "BillingCheckoutAttemptStatus" AS ENUM ('PENDING', 'CREATED', 'COMPLETED', 'EXPIRED', 'CANCELED', 'FAILED');
CREATE TYPE "BillingInvoiceSource" AS ENUM ('STRIPE', 'MANUAL');
CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID');
CREATE TYPE "StripeWebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'APPLIED', 'IGNORED', 'QUARANTINED', 'FAILED');
CREATE TYPE "BillingEventApplicationStatus" AS ENUM ('APPLIED', 'IGNORED_STALE', 'QUARANTINED', 'FAILED');
CREATE TYPE "BillingReconciliationTrigger" AS ENUM ('SCHEDULED', 'ON_DEMAND', 'WEBHOOK_RECOVERY');
CREATE TYPE "BillingReconciliationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'DRIFT_DETECTED', 'FAILED');
CREATE TYPE "BillingAccessOverrideEffect" AS ENUM ('GRANT', 'DENY');
CREATE TYPE "BillingAccessOverrideKind" AS ENUM ('MANUAL_PAYMENT', 'COMPLIMENTARY', 'PILOT', 'GRACE_PERIOD', 'PLATFORM_ADMIN');
CREATE TYPE "BillingCustomerRequestKind" AS ENUM ('CANCELLATION', 'ADD_ON_INTEREST');
CREATE TYPE "BillingCustomerRequestStatus" AS ENUM ('OPEN', 'PROCESSING', 'COMPLETED', 'DECLINED', 'WITHDRAWN', 'FAILED');
CREATE TYPE "BillingAgentCommandAction" AS ENUM ('CREATE_NEGOTIATED_CHECKOUT', 'SET_GRACE_PERIOD', 'CANCEL_AT_PERIOD_END');
CREATE TYPE "BillingAgentCommandStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'COMPLETED', 'REJECTED', 'FAILED');

CREATE TABLE "billing_accounts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_email" VARCHAR(320),
  "billing_contact_reference" VARCHAR(191),
  "legal_name_snapshot" VARCHAR(191),
  "display_name_snapshot" VARCHAR(191) NOT NULL,
  "billing_mode" "BillingMode" NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
  "status" "BillingAccountStatus" NOT NULL DEFAULT 'UNCONFIGURED',
  "stripe_mode" "StripeEnvironmentMode",
  "stripe_account_id" VARCHAR(191),
  "stripe_customer_id" VARCHAR(191),
  "payment_behavior" JSONB NOT NULL DEFAULT '{}',
  "grace_period_ends_at" TIMESTAMP(3),
  "paid_through_at" TIMESTAMP(3),
  "reconciliation_health" "BillingReconciliationHealth" NOT NULL DEFAULT 'UNKNOWN',
  "last_reconciled_at" TIMESTAMP(3),
  "last_reconciliation_error" VARCHAR(500),
  "internal_reference" VARCHAR(191),
  "internal_notes" VARCHAR(2000),
  "provider_state_changed_at" TIMESTAMP(3),
  "last_applied_stripe_event_id" VARCHAR(191),
  "last_applied_stripe_event_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_accounts_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "billing_accounts_stripe_namespace_check" CHECK (
    ("stripe_mode" IS NULL AND "stripe_account_id" IS NULL AND "stripe_customer_id" IS NULL)
    OR ("stripe_mode" IS NOT NULL AND "stripe_account_id" IS NOT NULL AND "stripe_customer_id" IS NOT NULL)
  )
);

CREATE TABLE "commercial_agreements" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "is_base" BOOLEAN NOT NULL DEFAULT false,
  "internal_plan_key" VARCHAR(100) NOT NULL,
  "internal_plan_version" INTEGER NOT NULL DEFAULT 1,
  "status" "CommercialAgreementStatus" NOT NULL DEFAULT 'DRAFT',
  "billing_mode" "BillingMode" NOT NULL,
  "billing_interval" "BillingInterval" NOT NULL,
  "billing_interval_count" INTEGER NOT NULL DEFAULT 1,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "covered_venue_count" INTEGER NOT NULL DEFAULT 1,
  "agreed_amount_minor" BIGINT,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
  "stripe_mode" "StripeEnvironmentMode",
  "stripe_account_id" VARCHAR(191),
  "stripe_product_id" VARCHAR(191),
  "stripe_price_id" VARCHAR(191),
  "stripe_subscription_id" VARCHAR(191),
  "stripe_subscription_status" VARCHAR(64),
  "starts_at" TIMESTAMP(3) NOT NULL,
  "access_starts_at" TIMESTAMP(3),
  "access_ends_at" TIMESTAMP(3),
  "current_period_starts_at" TIMESTAMP(3),
  "current_period_ends_at" TIMESTAMP(3),
  "trial_starts_at" TIMESTAMP(3),
  "trial_ends_at" TIMESTAMP(3),
  "minimum_commitment_starts_at" TIMESTAMP(3),
  "minimum_commitment_ends_at" TIMESTAMP(3),
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
  "cancellation_effective_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "commercial_reference" VARCHAR(191),
  "provider_state_changed_at" TIMESTAMP(3),
  "last_applied_stripe_event_id" VARCHAR(191),
  "last_applied_stripe_event_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commercial_agreements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commercial_agreements_positive_values_check" CHECK (
    "internal_plan_version" > 0 AND "billing_interval_count" > 0 AND "quantity" > 0
    AND "covered_venue_count" > 0 AND ("agreed_amount_minor" IS NULL OR "agreed_amount_minor" >= 0)
  ),
  CONSTRAINT "commercial_agreements_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "commercial_agreements_period_check" CHECK (
    ("access_starts_at" IS NULL OR "access_ends_at" IS NULL OR "access_ends_at" > "access_starts_at")
    AND ("current_period_starts_at" IS NULL OR "current_period_ends_at" IS NULL OR "current_period_ends_at" >= "current_period_starts_at")
    AND ("trial_starts_at" IS NULL OR "trial_ends_at" IS NULL OR "trial_ends_at" > "trial_starts_at")
    AND ("minimum_commitment_starts_at" IS NULL OR "minimum_commitment_ends_at" IS NULL OR "minimum_commitment_ends_at" > "minimum_commitment_starts_at")
  ),
  CONSTRAINT "commercial_agreements_temporary_access_expiry_check" CHECK (
    "billing_mode" NOT IN ('COMPLIMENTARY', 'PILOT') OR "access_ends_at" IS NOT NULL
  ),
  CONSTRAINT "commercial_agreements_stripe_namespace_check" CHECK (
    (("stripe_product_id" IS NULL AND "stripe_price_id" IS NULL AND "stripe_subscription_id" IS NULL)
      AND (("stripe_mode" IS NULL AND "stripe_account_id" IS NULL) OR ("stripe_mode" IS NOT NULL AND "stripe_account_id" IS NOT NULL)))
    OR ("stripe_mode" IS NOT NULL AND "stripe_account_id" IS NOT NULL)
  )
);

CREATE TABLE "commercial_agreement_venues" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "commercial_agreement_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commercial_agreement_venues_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing_checkout_attempts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "commercial_agreement_id" TEXT NOT NULL,
  "operation_key" VARCHAR(191) NOT NULL,
  "requested_plan_key" VARCHAR(100) NOT NULL,
  "requested_plan_version" INTEGER NOT NULL,
  "requested_quantity" INTEGER NOT NULL DEFAULT 1,
  "stripe_mode" "StripeEnvironmentMode" NOT NULL,
  "stripe_account_id" VARCHAR(191) NOT NULL,
  "stripe_checkout_session_id" VARCHAR(191),
  "stripe_checkout_url" VARCHAR(2048),
  "status" "BillingCheckoutAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "initiated_by" VARCHAR(191) NOT NULL,
  "provider_created_at" TIMESTAMP(3),
  "provider_state_changed_at" TIMESTAMP(3),
  "last_applied_stripe_event_id" VARCHAR(191),
  "last_applied_stripe_event_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "failure_code" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_checkout_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_checkout_attempts_positive_values_check" CHECK ("requested_plan_version" > 0 AND "requested_quantity" > 0)
);

CREATE TABLE "billing_invoice_projections" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "commercial_agreement_id" TEXT NOT NULL,
  "source" "BillingInvoiceSource" NOT NULL,
  "stripe_mode" "StripeEnvironmentMode",
  "stripe_account_id" VARCHAR(191),
  "stripe_invoice_id" VARCHAR(191),
  "invoice_number" VARCHAR(191),
  "status" "BillingInvoiceStatus" NOT NULL,
  "amount_due_minor" BIGINT NOT NULL DEFAULT 0,
  "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
  "amount_remaining_minor" BIGINT NOT NULL DEFAULT 0,
  "currency" VARCHAR(3) NOT NULL,
  "hosted_invoice_url" VARCHAR(2048),
  "invoice_document_url" VARCHAR(2048),
  "receipt_url" VARCHAR(2048),
  "payment_intent_reference" VARCHAR(191),
  "due_at" TIMESTAMP(3),
  "paid_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "voided_at" TIMESTAMP(3),
  "next_retry_at" TIMESTAMP(3),
  "failure_code" VARCHAR(100),
  "failure_summary" VARCHAR(500),
  "provider_state_changed_at" TIMESTAMP(3),
  "last_applied_stripe_event_id" VARCHAR(191),
  "last_applied_stripe_event_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_invoice_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_invoice_projections_amounts_check" CHECK (
    "amount_due_minor" >= 0 AND "amount_paid_minor" >= 0 AND "amount_remaining_minor" >= 0
  ),
  CONSTRAINT "billing_invoice_projections_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "billing_invoice_projections_source_check" CHECK (
    ("source" = 'STRIPE' AND "stripe_mode" IS NOT NULL AND "stripe_account_id" IS NOT NULL AND "stripe_invoice_id" IS NOT NULL)
    OR ("source" = 'MANUAL' AND "stripe_mode" IS NULL AND "stripe_account_id" IS NULL AND "stripe_invoice_id" IS NULL)
  )
);

CREATE TABLE "stripe_webhook_receipts" (
  "id" TEXT NOT NULL,
  "stripe_mode" "StripeEnvironmentMode" NOT NULL,
  "stripe_account_id" VARCHAR(191) NOT NULL,
  "stripe_event_id" VARCHAR(191) NOT NULL,
  "event_type" VARCHAR(100) NOT NULL,
  "api_version" VARCHAR(32),
  "primary_object_id" VARCHAR(191),
  "stripe_customer_id" VARCHAR(191),
  "stripe_subscription_id" VARCHAR(191),
  "stripe_invoice_id" VARCHAR(191),
  "provider_created_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload_hash" CHAR(64) NOT NULL,
  "sanitized_object" JSONB NOT NULL DEFAULT '{}',
  "processing_status" "StripeWebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "resolved_tenant_id" VARCHAR(191),
  "error_code" VARCHAR(100),
  "quarantine_reason" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stripe_webhook_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stripe_webhook_receipts_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stripe_webhook_receipts_attempt_count_check" CHECK ("attempt_count" >= 0)
);

CREATE TABLE "billing_event_applications" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "commercial_agreement_id" TEXT,
  "stripe_receipt_id" TEXT NOT NULL,
  "event_type" VARCHAR(100) NOT NULL,
  "provider_created_at" TIMESTAMP(3) NOT NULL,
  "status" "BillingEventApplicationStatus" NOT NULL,
  "applied_object_type" VARCHAR(64),
  "applied_object_id" VARCHAR(191),
  "transition" JSONB NOT NULL DEFAULT '{}',
  "error_code" VARCHAR(100),
  "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_event_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_event_applications_object_pair_check" CHECK (
    ("applied_object_type" IS NULL AND "applied_object_id" IS NULL)
    OR ("applied_object_type" IS NOT NULL AND "applied_object_id" IS NOT NULL)
  )
);

CREATE TABLE "billing_reconciliation_runs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "trigger" "BillingReconciliationTrigger" NOT NULL,
  "status" "BillingReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
  "initiated_by" VARCHAR(191) NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "compared_object_count" INTEGER NOT NULL DEFAULT 0,
  "repaired_object_count" INTEGER NOT NULL DEFAULT 0,
  "unknown_object_count" INTEGER NOT NULL DEFAULT 0,
  "drift_summary" JSONB NOT NULL DEFAULT '{}',
  "error_code" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_reconciliation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_reconciliation_runs_counts_check" CHECK (
    "compared_object_count" >= 0 AND "repaired_object_count" >= 0 AND "unknown_object_count" >= 0
  ),
  CONSTRAINT "billing_reconciliation_runs_time_check" CHECK ("completed_at" IS NULL OR "completed_at" >= "started_at")
);

CREATE TABLE "billing_access_overrides" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "commercial_agreement_id" TEXT,
  "venue_id" TEXT,
  "capability" VARCHAR(100),
  "effect" "BillingAccessOverrideEffect" NOT NULL,
  "kind" "BillingAccessOverrideKind" NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "source_reference" VARCHAR(191),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_access_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_access_overrides_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "billing_access_overrides_expiry_check" CHECK ("expires_at" > "starts_at")
);

CREATE TABLE "billing_customer_requests" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "commercial_agreement_id" TEXT,
  "venue_id" TEXT,
  "kind" "BillingCustomerRequestKind" NOT NULL,
  "status" "BillingCustomerRequestStatus" NOT NULL DEFAULT 'OPEN',
  "requested_by" VARCHAR(191) NOT NULL,
  "reason" VARCHAR(2000),
  "feature_key" VARCHAR(100),
  "feature_label_snapshot" VARCHAR(191),
  "provider_action_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "resolved_by" VARCHAR(191),
  "failure_code" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_customer_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_customer_requests_shape_check" CHECK (
    ("kind" = 'CANCELLATION' AND "reason" IS NOT NULL AND length(btrim("reason")) > 0 AND "feature_key" IS NULL AND "feature_label_snapshot" IS NULL)
    OR ("kind" = 'ADD_ON_INTEREST' AND "feature_key" IS NOT NULL AND "feature_label_snapshot" IS NOT NULL)
  ),
  CONSTRAINT "billing_customer_requests_resolution_check" CHECK (
    ("status" IN ('OPEN', 'PROCESSING') AND "resolved_at" IS NULL)
    OR ("status" IN ('COMPLETED', 'DECLINED', 'WITHDRAWN', 'FAILED') AND "resolved_at" IS NOT NULL)
  )
);

CREATE TABLE "billing_agent_commands" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT,
  "commercial_agreement_id" TEXT,
  "venue_id" TEXT,
  "approval_request_id" TEXT NOT NULL,
  "action" "BillingAgentCommandAction" NOT NULL,
  "status" "BillingAgentCommandStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "payload" JSONB NOT NULL,
  "result" JSONB NOT NULL DEFAULT '{}',
  "requested_by_agent_id" TEXT NOT NULL,
  "executed_by" VARCHAR(191),
  "executed_at" TIMESTAMP(3),
  "failure_code" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_agent_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_agent_commands_execution_check" CHECK (
    ("status" IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED') AND "executed_at" IS NULL)
    OR ("status" = 'EXECUTING')
    OR ("status" IN ('COMPLETED', 'FAILED') AND "executed_at" IS NOT NULL AND "executed_by" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "billing_accounts_tenant_id_key" ON "billing_accounts"("tenant_id");
CREATE UNIQUE INDEX "billing_accounts_id_tenant_key" ON "billing_accounts"("id", "tenant_id");
CREATE UNIQUE INDEX "billing_accounts_stripe_customer_key" ON "billing_accounts"("stripe_mode", "stripe_account_id", "stripe_customer_id");
CREATE INDEX "billing_accounts_status_reconciliation_health_updated_at_idx" ON "billing_accounts"("status", "reconciliation_health", "updated_at");

CREATE UNIQUE INDEX "commercial_agreements_id_tenant_key" ON "commercial_agreements"("id", "tenant_id");
CREATE UNIQUE INDEX "commercial_agreements_stripe_subscription_key" ON "commercial_agreements"("stripe_mode", "stripe_account_id", "stripe_subscription_id");
CREATE UNIQUE INDEX "commercial_agreements_one_current_base_key" ON "commercial_agreements"("tenant_id") WHERE "is_base" = true AND "status" NOT IN ('CANCELED', 'ENDED');
CREATE INDEX "commercial_agreements_tenant_id_status_updated_at_idx" ON "commercial_agreements"("tenant_id", "status", "updated_at");
CREATE INDEX "commercial_agreements_billing_account_id_tenant_id_status_idx" ON "commercial_agreements"("billing_account_id", "tenant_id", "status");

CREATE UNIQUE INDEX "commercial_agreement_venues_coverage_key" ON "commercial_agreement_venues"("tenant_id", "commercial_agreement_id", "venue_id");
CREATE UNIQUE INDEX "commercial_agreement_venues_id_tenant_key" ON "commercial_agreement_venues"("id", "tenant_id");
CREATE INDEX "commercial_agreement_venues_tenant_id_venue_id_idx" ON "commercial_agreement_venues"("tenant_id", "venue_id");

CREATE UNIQUE INDEX "billing_checkout_attempts_operation_key" ON "billing_checkout_attempts"("tenant_id", "operation_key");
CREATE UNIQUE INDEX "billing_checkout_attempts_stripe_session_key" ON "billing_checkout_attempts"("stripe_mode", "stripe_account_id", "stripe_checkout_session_id");
CREATE UNIQUE INDEX "billing_checkout_attempts_id_tenant_key" ON "billing_checkout_attempts"("id", "tenant_id");
CREATE INDEX "billing_checkout_attempts_tenant_id_status_created_at_idx" ON "billing_checkout_attempts"("tenant_id", "status", "created_at");

CREATE UNIQUE INDEX "billing_invoice_projections_stripe_invoice_key" ON "billing_invoice_projections"("stripe_mode", "stripe_account_id", "stripe_invoice_id");
CREATE UNIQUE INDEX "billing_invoice_projections_id_tenant_key" ON "billing_invoice_projections"("id", "tenant_id");
CREATE INDEX "billing_invoice_projections_tenant_id_status_due_at_idx" ON "billing_invoice_projections"("tenant_id", "status", "due_at");
CREATE INDEX "billing_invoice_projections_billing_account_id_tenant_id_created_at_idx" ON "billing_invoice_projections"("billing_account_id", "tenant_id", "created_at");

CREATE UNIQUE INDEX "stripe_webhook_receipts_event_key" ON "stripe_webhook_receipts"("stripe_mode", "stripe_account_id", "stripe_event_id");
CREATE INDEX "stripe_webhook_receipts_processing_status_received_at_idx" ON "stripe_webhook_receipts"("processing_status", "received_at");
CREATE INDEX "stripe_webhook_receipts_resolved_tenant_id_received_at_idx" ON "stripe_webhook_receipts"("resolved_tenant_id", "received_at");

CREATE UNIQUE INDEX "billing_event_applications_stripe_receipt_id_key" ON "billing_event_applications"("stripe_receipt_id");
CREATE UNIQUE INDEX "billing_event_applications_id_tenant_key" ON "billing_event_applications"("id", "tenant_id");
CREATE INDEX "billing_event_applications_tenant_id_provider_created_at_idx" ON "billing_event_applications"("tenant_id", "provider_created_at");
CREATE INDEX "billing_event_applications_tenant_id_status_applied_at_idx" ON "billing_event_applications"("tenant_id", "status", "applied_at");

CREATE UNIQUE INDEX "billing_reconciliation_runs_id_tenant_key" ON "billing_reconciliation_runs"("id", "tenant_id");
CREATE INDEX "billing_reconciliation_runs_tenant_id_status_started_at_idx" ON "billing_reconciliation_runs"("tenant_id", "status", "started_at");

CREATE UNIQUE INDEX "billing_access_overrides_id_tenant_key" ON "billing_access_overrides"("id", "tenant_id");
CREATE INDEX "billing_access_overrides_tenant_id_venue_id_capability_starts_at_expires_at_idx" ON "billing_access_overrides"("tenant_id", "venue_id", "capability", "starts_at", "expires_at");
CREATE INDEX "billing_access_overrides_tenant_id_commercial_agreement_id_starts_at_expires_at_idx" ON "billing_access_overrides"("tenant_id", "commercial_agreement_id", "starts_at", "expires_at");

CREATE UNIQUE INDEX "billing_customer_requests_operation_key" ON "billing_customer_requests"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "billing_customer_requests_id_tenant_key" ON "billing_customer_requests"("id", "tenant_id");
CREATE INDEX "billing_customer_requests_tenant_id_kind_status_created_at_idx" ON "billing_customer_requests"("tenant_id", "kind", "status", "created_at");
CREATE INDEX "billing_customer_requests_billing_account_id_tenant_id_created_at_idx" ON "billing_customer_requests"("billing_account_id", "tenant_id", "created_at");

CREATE UNIQUE INDEX "billing_agent_commands_operation_key" ON "billing_agent_commands"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "billing_agent_commands_approval_key" ON "billing_agent_commands"("approval_request_id", "tenant_id");
CREATE UNIQUE INDEX "billing_agent_commands_id_tenant_key" ON "billing_agent_commands"("id", "tenant_id");
CREATE INDEX "billing_agent_commands_tenant_id_status_created_at_idx" ON "billing_agent_commands"("tenant_id", "status", "created_at");

ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "commercial_agreements" ADD CONSTRAINT "commercial_agreements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "commercial_agreements" ADD CONSTRAINT "commercial_agreements_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "commercial_agreement_venues" ADD CONSTRAINT "commercial_agreement_venues_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "commercial_agreement_venues" ADD CONSTRAINT "commercial_agreement_venues_commercial_agreement_id_tenant_id_fkey"
  FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "commercial_agreement_venues" ADD CONSTRAINT "commercial_agreement_venues_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_commercial_agreement_id_tenant_id_fkey"
  FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "billing_invoice_projections" ADD CONSTRAINT "billing_invoice_projections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_invoice_projections" ADD CONSTRAINT "billing_invoice_projections_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_invoice_projections" ADD CONSTRAINT "billing_invoice_projections_commercial_agreement_id_tenant_id_fkey"
  FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "billing_event_applications" ADD CONSTRAINT "billing_event_applications_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_event_applications" ADD CONSTRAINT "billing_event_applications_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_event_applications" ADD CONSTRAINT "billing_event_applications_commercial_agreement_id_tenant_id_fkey"
  FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_event_applications" ADD CONSTRAINT "billing_event_applications_stripe_receipt_id_fkey"
  FOREIGN KEY ("stripe_receipt_id") REFERENCES "stripe_webhook_receipts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "billing_reconciliation_runs" ADD CONSTRAINT "billing_reconciliation_runs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_reconciliation_runs" ADD CONSTRAINT "billing_reconciliation_runs_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "billing_access_overrides" ADD CONSTRAINT "billing_access_overrides_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_access_overrides" ADD CONSTRAINT "billing_access_overrides_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_access_overrides" ADD CONSTRAINT "billing_access_overrides_commercial_agreement_id_tenant_id_fkey"
  FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_access_overrides" ADD CONSTRAINT "billing_access_overrides_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "billing_customer_requests" ADD CONSTRAINT "billing_customer_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_customer_requests" ADD CONSTRAINT "billing_customer_requests_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_customer_requests" ADD CONSTRAINT "billing_customer_requests_commercial_agreement_id_tenant_id_fkey"
  FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_customer_requests" ADD CONSTRAINT "billing_customer_requests_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "billing_agent_commands" ADD CONSTRAINT "billing_agent_commands_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_agent_commands" ADD CONSTRAINT "billing_agent_commands_billing_account_id_tenant_id_fkey"
  FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_agent_commands" ADD CONSTRAINT "billing_agent_commands_commercial_agreement_id_tenant_id_fkey"
  FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_agent_commands" ADD CONSTRAINT "billing_agent_commands_approval_request_id_tenant_id_fkey"
  FOREIGN KEY ("approval_request_id", "tenant_id") REFERENCES "approval_requests"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "billing_agent_commands" ADD CONSTRAINT "billing_agent_commands_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
