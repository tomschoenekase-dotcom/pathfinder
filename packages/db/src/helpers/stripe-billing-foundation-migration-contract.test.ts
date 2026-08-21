import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260820210000_add_stripe_billing_foundation/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

const pendingCustomerNamespaceFix = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260821032000_allow_pending_stripe_customer_link/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('Stripe billing foundation migration contract', () => {
  it('adds the complete billing domain without destructive schema changes', () => {
    for (const table of [
      'billing_accounts',
      'commercial_agreements',
      'commercial_agreement_venues',
      'billing_checkout_attempts',
      'billing_invoice_projections',
      'stripe_webhook_receipts',
      'billing_event_applications',
      'billing_reconciliation_runs',
      'billing_access_overrides',
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`)
    }
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/iu)
    expect(migration).not.toMatch(
      /\b(?:card_number|cvc|cvv|client_secret|payment_method_details)\b/iu,
    )
    expect(migration).toContain('"stripe_checkout_url" VARCHAR(2048)')
  })

  it('namespaces every reusable Stripe identifier by environment and platform account', () => {
    expect(migration).toContain('"billing_accounts_stripe_customer_key"')
    expect(migration).toContain('"commercial_agreements_stripe_subscription_key"')
    expect(migration).toContain('"billing_checkout_attempts_stripe_session_key"')
    expect(migration).toContain('"billing_invoice_projections_stripe_invoice_key"')
    expect(migration).toContain('"stripe_webhook_receipts_event_key"')
    expect(migration).toContain('("stripe_mode", "stripe_account_id", "stripe_event_id")')
    expect(migration).toContain('"billing_accounts_stripe_namespace_check"')
    expect(migration).toContain('"billing_invoice_projections_source_check"')
  })

  it('allows a provider-namespaced pending account before its Stripe Customer is linked', () => {
    expect(pendingCustomerNamespaceFix).toContain(
      'DROP CONSTRAINT "billing_accounts_stripe_namespace_check"',
    )
    expect(pendingCustomerNamespaceFix).toContain(
      '("stripe_mode" IS NOT NULL AND "stripe_account_id" IS NOT NULL)',
    )
    expect(pendingCustomerNamespaceFix).toContain('"stripe_customer_id" IS NULL)')
    expect(pendingCustomerNamespaceFix).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/iu)
  })

  it('enforces exact tenant ownership for accounts, agreements, and covered venues', () => {
    expect(migration).toContain(
      'FOREIGN KEY ("billing_account_id", "tenant_id") REFERENCES "billing_accounts"("id", "tenant_id")',
    )
    expect(migration).toContain(
      'FOREIGN KEY ("commercial_agreement_id", "tenant_id") REFERENCES "commercial_agreements"("id", "tenant_id")',
    )
    expect(migration).toContain(
      'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
    )
    expect(migration).toContain('"commercial_agreement_venues_coverage_key"')
  })

  it('allows multiple agreements while admitting at most one current base agreement', () => {
    expect(migration).not.toContain(
      'CREATE UNIQUE INDEX "commercial_agreements_billing_account_id_key"',
    )
    expect(migration).toContain('"commercial_agreements_one_current_base_key"')
    expect(migration).toContain('WHERE "is_base" = true')
    expect(migration).toContain('"billing_mode" "BillingMode" NOT NULL')
    expect(migration).toContain('"access_starts_at" TIMESTAMP(3)')
    expect(migration).toContain('"access_ends_at" TIMESTAMP(3)')
    expect(migration).toContain('"commercial_agreements_temporary_access_expiry_check"')
  })

  it('durably quarantines unknown events before a tenant mapping is known', () => {
    expect(migration).toContain('"resolved_tenant_id" VARCHAR(191)')
    expect(migration).toContain('"processing_status" "StripeWebhookProcessingStatus"')
    expect(migration).toContain('"quarantine_reason" VARCHAR(500)')
    expect(migration).toContain('"payload_hash" CHAR(64) NOT NULL')
    expect(migration).toContain('"stripe_webhook_receipts_hash_check"')
  })

  it('records provider-time fences for monotonic subscription and invoice projections', () => {
    expect(migration.match(/"provider_state_changed_at" TIMESTAMP\(3\)/gu)).toHaveLength(4)
    expect(migration.match(/"last_applied_stripe_event_at" TIMESTAMP\(3\)/gu)).toHaveLength(4)
    expect(migration).toContain('"provider_created_at" TIMESTAMP(3) NOT NULL')
    expect(migration).toContain('"billing_event_applications_stripe_receipt_id_key"')
  })

  it('requires every access override to have a nonblank reason and finite future expiry', () => {
    expect(migration).toContain('"expires_at" TIMESTAMP(3) NOT NULL')
    expect(migration).toContain('"reason" VARCHAR(500) NOT NULL')
    expect(migration).toContain('"billing_access_overrides_reason_check"')
    expect(migration).toContain('length(btrim("reason")) > 0')
    expect(migration).toContain('"billing_access_overrides_expiry_check"')
    expect(migration).toContain('"expires_at" > "starts_at"')
  })
})
