-- A pending Torchiko billing account is reserved before Stripe Customer creation so Checkout
-- retries are tenant-owned and auditable. Keep the provider namespace present during that short
-- pending state while allowing the customer identifier to be linked after provider creation.

ALTER TABLE "billing_accounts"
  DROP CONSTRAINT "billing_accounts_stripe_namespace_check";

ALTER TABLE "billing_accounts"
  ADD CONSTRAINT "billing_accounts_stripe_namespace_check" CHECK (
    ("stripe_mode" IS NULL AND "stripe_account_id" IS NULL AND "stripe_customer_id" IS NULL)
    OR ("stripe_mode" IS NOT NULL AND "stripe_account_id" IS NOT NULL)
  );
