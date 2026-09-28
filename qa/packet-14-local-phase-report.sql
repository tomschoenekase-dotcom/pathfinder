-- Read-only Packet 14 M5 timing report.
-- Intended only for the disposable database pathfinder_disposable_p14_local.
-- The database-name predicate fails closed elsewhere. Never point this report
-- at staging or production. It selects event metadata only; no message/response
-- text, credentials, or prompt content is read.

BEGIN TRANSACTION READ ONLY;

WITH packet14_venues(venue_id, tenant_id, venue_name) AS (
  VALUES
    ('cpacket14aurora0000000000', 'org_LocalTenantA', 'Aurora Science Museum'),
    ('cpacket14pocket0000000000', 'org_LocalTenantA', 'Pocket Collection Museum'),
    ('cpacket14riverbend0000000', 'org_LocalTenantB', 'Riverbend Nature Centre')
), local_turns AS (
  SELECT
    e.id AS event_id,
    e.occurred_at,
    e.tenant_id,
    e.venue_id,
    v.venue_name,
    e.session_id,
    (e.metadata ->> 'firstTurn')::boolean AS first_turn,
    NULLIF(e.metadata ->> 'turnSetupMs', '')::double precision AS turn_setup_ms,
    NULLIF(e.metadata ->> 'preEmbeddingMs', '')::double precision AS pre_embedding_ms,
    NULLIF(e.metadata ->> 'embeddingMs', '')::double precision AS embedding_ms,
    NULLIF(e.metadata ->> 'retrievalMs', '')::double precision AS retrieval_ms,
    NULLIF(e.metadata ->> 'promptAssemblyMs', '')::double precision AS prompt_assembly_ms,
    NULLIF(e.metadata ->> 'modelMs', '')::double precision AS model_ms,
    NULLIF(e.metadata ->> 'persistenceMs', '')::double precision AS persistence_ms,
    NULLIF(e.metadata ->> 'totalMs', '')::double precision AS total_ms,
    NULLIF(e.metadata ->> 'providerFirstTextMs', '')::double precision AS provider_first_text_ms,
    NULLIF(e.metadata ->> 'requestFirstTextMs', '')::double precision AS request_first_text_ms
  FROM analytics_events AS e
  JOIN packet14_venues AS v
    ON v.venue_id = e.venue_id
   AND v.tenant_id = e.tenant_id
  WHERE current_database() = 'pathfinder_disposable_p14_local'
    AND e.event_type = 'message.received'
    AND e.metadata ->> 'firstTurn' IN ('true', 'false')
)
SELECT
  event_id,
  occurred_at,
  tenant_id,
  venue_id,
  venue_name,
  session_id,
  first_turn AS "firstTurn",
  CASE WHEN first_turn THEN 'first' ELSE 'follow-up' END AS turn_kind,
  turn_setup_ms AS "turnSetupMs",
  pre_embedding_ms AS "preEmbeddingMs",
  embedding_ms AS "embeddingMs",
  retrieval_ms AS "retrievalMs",
  prompt_assembly_ms AS "promptAssemblyMs",
  model_ms AS "modelMs",
  persistence_ms AS "persistenceMs",
  total_ms AS "totalMs",
  provider_first_text_ms AS "providerFirstTextMs",
  request_first_text_ms AS "requestFirstTextMs"
FROM local_turns
ORDER BY venue_name, occurred_at, event_id;

WITH packet14_venues(venue_id, tenant_id, venue_name) AS (
  VALUES
    ('cpacket14aurora0000000000', 'org_LocalTenantA', 'Aurora Science Museum'),
    ('cpacket14pocket0000000000', 'org_LocalTenantA', 'Pocket Collection Museum'),
    ('cpacket14riverbend0000000', 'org_LocalTenantB', 'Riverbend Nature Centre')
), local_turns AS (
  SELECT
    v.venue_name,
    (e.metadata ->> 'firstTurn')::boolean AS first_turn,
    NULLIF(e.metadata ->> 'totalMs', '')::double precision AS total_ms,
    NULLIF(e.metadata ->> 'requestFirstTextMs', '')::double precision AS request_first_text_ms
  FROM analytics_events AS e
  JOIN packet14_venues AS v
    ON v.venue_id = e.venue_id
   AND v.tenant_id = e.tenant_id
  WHERE current_database() = 'pathfinder_disposable_p14_local'
    AND e.event_type = 'message.received'
    AND e.metadata ->> 'firstTurn' IN ('true', 'false')
)
SELECT
  venue_name,
  CASE WHEN first_turn THEN 'first' ELSE 'follow-up' END AS turn_kind,
  COUNT(*) AS turn_count,
  COUNT(request_first_text_ms) AS request_first_text_sample_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY request_first_text_ms) AS request_first_text_median_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY request_first_text_ms) AS request_first_text_p90_ms,
  COUNT(total_ms) AS total_sample_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_median_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY total_ms) AS total_p90_ms
FROM local_turns
GROUP BY venue_name, first_turn
ORDER BY venue_name, first_turn DESC;

WITH packet14_venues(venue_id, tenant_id, venue_name) AS (
  VALUES
    ('cpacket14aurora0000000000', 'org_LocalTenantA', 'Aurora Science Museum'),
    ('cpacket14pocket0000000000', 'org_LocalTenantA', 'Pocket Collection Museum'),
    ('cpacket14riverbend0000000', 'org_LocalTenantB', 'Riverbend Nature Centre')
), local_turns AS (
  SELECT
    v.venue_name,
    (e.metadata ->> 'firstTurn')::boolean AS first_turn,
    e.metadata
  FROM analytics_events AS e
  JOIN packet14_venues AS v
    ON v.venue_id = e.venue_id
   AND v.tenant_id = e.tenant_id
  WHERE current_database() = 'pathfinder_disposable_p14_local'
    AND e.event_type = 'message.received'
    AND e.metadata ->> 'firstTurn' IN ('true', 'false')
), phases AS (
  SELECT
    venue_name,
    first_turn,
    phase_name,
    NULLIF(metadata ->> metadata_key, '')::double precision AS phase_ms
  FROM local_turns
  CROSS JOIN LATERAL (VALUES
    ('turn setup', 'turnSetupMs'),
    ('pre embedding', 'preEmbeddingMs'),
    ('embedding', 'embeddingMs'),
    ('retrieval', 'retrievalMs'),
    ('prompt assembly', 'promptAssemblyMs'),
    ('model', 'modelMs'),
    ('persistence', 'persistenceMs'),
    ('provider first text', 'providerFirstTextMs'),
    ('request first text', 'requestFirstTextMs'),
    ('total', 'totalMs')
  ) AS phase(phase_name, metadata_key)
)
SELECT
  venue_name,
  CASE WHEN first_turn THEN 'first' ELSE 'follow-up' END AS turn_kind,
  phase_name,
  COUNT(phase_ms) AS phase_sample_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY phase_ms) AS median_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY phase_ms) AS p90_ms
FROM phases
GROUP BY venue_name, first_turn, phase_name
ORDER BY venue_name, first_turn DESC, phase_name;

COMMIT;
