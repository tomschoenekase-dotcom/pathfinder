-- Preserve the pre-entitlement widget behavior for plan tiers already in use.
-- New plan tiers remain fail-closed until an explicit capability row is added.
INSERT INTO "product_plan_capabilities" (
  "id", "plan_tier", "capability", "enabled", "settings", "created_by", "updated_by", "created_at", "updated_at"
)
SELECT
  'legacy-widget-' || md5(t."plan_tier"),
  t."plan_tier",
  'widget',
  true,
  '{}'::jsonb,
  'migration:20260819151000',
  'migration:20260819151000',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "plan_tier" FROM "tenants") t
ON CONFLICT ("plan_tier", "capability") DO NOTHING;
