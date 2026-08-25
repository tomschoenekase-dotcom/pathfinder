-- Direct agent identities select the governed agent-run workload. The exact
-- provider model, fallbacks, retry limits, timeout, output limit, and request
-- ceiling remain centrally configurable instead of being copied into identity
-- rows. Bridge identities continue to retain an explicit bridge target.
UPDATE "agent_identities"
SET "default_provider" = 'anthropic',
    "default_model" = 'central:agent-run'
WHERE lower("default_provider") IN ('anthropic', 'claude', 'claude-api');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_identities"
    WHERE NOT (
      ("default_provider" IS NULL AND "default_model" IS NULL)
      OR (
        "default_provider" = 'anthropic'
        AND "default_model" = 'central:agent-run'
      )
      OR (
        "default_provider" IN (
          'hermes-bridge',
          'claude-bridge',
          'codex-bridge',
          'openai-compatible-bridge'
        )
        AND "default_model" IS NOT NULL
        AND length(btrim("default_model")) > 0
        AND "default_model" <> 'central:agent-run'
      )
    )
  ) THEN
    RAISE EXCEPTION 'agent identity execution routing contains unsupported legacy values'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "agent_identities"
  ADD CONSTRAINT "agent_identities_execution_route_check" CHECK (
    ("default_provider" IS NULL AND "default_model" IS NULL)
    OR (
      "default_provider" = 'anthropic'
      AND "default_model" = 'central:agent-run'
    )
    OR (
      "default_provider" IN (
        'hermes-bridge',
        'claude-bridge',
        'codex-bridge',
        'openai-compatible-bridge'
      )
      AND "default_model" IS NOT NULL
      AND length(btrim("default_model")) > 0
      AND "default_model" <> 'central:agent-run'
    )
  );
