-- Operator-only terminal text disposition. Prior migrations remain immutable.
-- Hosting must explicitly provision EXECUTE to its reviewed maintenance principal;
-- no application role, PUBLIC privilege, custom GUC or runtime flag enables erase.
BEGIN;

-- One intentionally marked cluster role can own functions in multiple restored
-- databases. Never adopt/regrant an unrelated pre-existing role with this name.
DO $$ DECLARE role_oid oid; BEGIN
  SELECT oid INTO role_oid FROM pg_roles WHERE rolname='pathfinder_guest_disposition_executor';
  IF role_oid IS NULL THEN
    CREATE ROLE pathfinder_guest_disposition_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    COMMENT ON ROLE pathfinder_guest_disposition_executor IS 'pathfinder:guest-disposition-executor:v1';
  ELSE
    IF shobj_description(role_oid,'pg_authid') IS DISTINCT FROM 'pathfinder:guest-disposition-executor:v1'
      OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=role_oid AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls OR rolconfig IS NOT NULL))
      OR EXISTS(WITH RECURSIVE members(oid) AS (
        SELECT member FROM pg_auth_members WHERE roleid=role_oid
        UNION SELECT a.member FROM pg_auth_members a JOIN members m ON a.roleid=m.oid
      ) SELECT 1 FROM members JOIN pg_roles r USING(oid) WHERE r.rolcanlogin)
      THEN RAISE EXCEPTION 'guest disposition executor role conflict'; END IF;
  END IF;
END $$;
GRANT pg_read_all_stats TO pathfinder_guest_disposition_executor;
GRANT USAGE ON SCHEMA public TO pathfinder_guest_disposition_executor;
CREATE TYPE "GuestConversationDispositionState" AS ENUM ('AUTHORIZED','FENCED','APPLIED');
CREATE TABLE public.guest_conversation_disposition_operations (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, venue_id text NOT NULL, session_id text NOT NULL,
  request jsonb NOT NULL, authority_snapshot jsonb NOT NULL,
  request_sha256 char(64) NOT NULL, policy_version varchar(100) NOT NULL, policy_sha256 char(64) NOT NULL,
  retention_days integer NOT NULL CHECK (retention_days = 365),
  state "GuestConversationDispositionState" NOT NULL DEFAULT 'AUTHORIZED',
  authorized_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(), sealed_at timestamptz(6), applied_at timestamptz(6),
  effective_cutoff_utc timestamptz(6), retired_token_digest char(64), external_intent_sha256 char(64),
  sealed_inventory jsonb, receipt jsonb,
  CONSTRAINT guest_disposition_scope_key UNIQUE(id,tenant_id,venue_id),
  CONSTRAINT guest_disposition_hashes CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$' AND policy_sha256 ~ '^[a-f0-9]{64}$'
    AND (retired_token_digest IS NULL OR retired_token_digest ~ '^[a-f0-9]{64}$')
    AND (external_intent_sha256 IS NULL OR external_intent_sha256 ~ '^[a-f0-9]{64}$')),
  CONSTRAINT guest_disposition_state_shape CHECK (
    (state='AUTHORIZED' AND sealed_at IS NULL AND applied_at IS NULL AND effective_cutoff_utc IS NULL
      AND retired_token_digest IS NULL AND external_intent_sha256 IS NULL AND sealed_inventory IS NULL AND receipt IS NULL)
    OR (state='FENCED' AND sealed_at IS NOT NULL AND applied_at IS NULL AND effective_cutoff_utc IS NOT NULL
      AND retired_token_digest IS NOT NULL AND sealed_inventory IS NOT NULL AND receipt IS NULL)
    OR (state='APPLIED' AND sealed_at IS NOT NULL AND applied_at IS NOT NULL AND effective_cutoff_utc IS NOT NULL
      AND retired_token_digest IS NOT NULL AND external_intent_sha256 IS NOT NULL AND sealed_inventory IS NOT NULL AND receipt IS NOT NULL))
);
CREATE INDEX guest_disposition_session_idx ON public.guest_conversation_disposition_operations(tenant_id,venue_id,session_id);
CREATE INDEX guest_disposition_token_idx ON public.guest_conversation_disposition_operations(tenant_id,venue_id,retired_token_digest);
CREATE UNIQUE INDEX guest_disposition_active_session_key ON public.guest_conversation_disposition_operations(tenant_id,venue_id,session_id) WHERE state IN ('FENCED','APPLIED');
ALTER TABLE public.visitor_sessions ADD COLUMN disposition_operation_id uuid;
ALTER TABLE public.visitor_sessions ADD CONSTRAINT visitor_session_disposition_fkey FOREIGN KEY(disposition_operation_id,tenant_id,venue_id)
  REFERENCES public.guest_conversation_disposition_operations(id,tenant_id,venue_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
REVOKE ALL ON public.guest_conversation_disposition_operations FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.guest_conversation_disposition_operations TO pathfinder_guest_disposition_executor;

CREATE FUNCTION public.pathfinder_guest_disposition_digest(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public
AS $$ SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') $$;
CREATE FUNCTION public.pathfinder_guest_disposition_token_digest(tenant text,venue text,token text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public
AS $$ SELECT public.pathfinder_guest_disposition_digest(jsonb_build_array('guest-disposition-token-v1',tenant,venue,token)) $$;

CREATE FUNCTION public.pathfinder_authorize_guest_disposition(req jsonb,authority jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public.guest_conversation_disposition_operations; fingerprint text; replayed boolean := false;
BEGIN
  -- Server API authenticates the platform operator. This SQL boundary validates
  -- shape/scope and immutable replay; it does not claim to authenticate Clerk.
  IF octet_length(req::text)>8192 OR octet_length(authority::text)>8192
    OR jsonb_typeof(req)<>'object' OR jsonb_typeof(authority)<>'object'
    OR req - ARRAY['version','operationId','tenantId','venueId','sessionId','expectedPolicyVersion','expectedPolicySha256','basis'] <> '{}'
    OR authority - ARRAY['version','actorId','actorRole','policyVersion','policySha256','retentionDays','holdAssessment','basis'] <> '{}'
    OR req->>'version' IS DISTINCT FROM 'guest-conversation-disposition-v1'
    OR authority->>'version' IS DISTINCT FROM 'guest-disposition-authority-v1'
    OR authority->>'actorRole' IS DISTINCT FROM 'PLATFORM_ADMIN'
    OR authority->>'retentionDays' IS DISTINCT FROM '365'
    OR authority->>'actorId' IS NULL OR authority->>'actorId' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$'
    OR authority#>>'{holdAssessment,status}' IS DISTINCT FROM 'NO_KNOWN_HOLD'
    OR authority#>>'{holdAssessment,referenceSha256}' IS NULL
    OR authority#>>'{holdAssessment,referenceSha256}' !~ '^[a-f0-9]{64}$'
    OR (authority->'holdAssessment') - ARRAY['status','referenceSha256'] <> '{}'
    OR req->>'expectedPolicyVersion' IS DISTINCT FROM authority->>'policyVersion'
    OR req->>'expectedPolicySha256' IS DISTINCT FROM authority->>'policySha256'
    OR authority->>'policyVersion' IS NULL OR authority->>'policyVersion' !~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    OR authority->>'policySha256' IS NULL OR authority->>'policySha256' !~ '^[a-f0-9]{64}$'
    OR req#>>'{basis,kind}' IS DISTINCT FROM authority#>>'{basis,kind}'
    OR req#>>'{basis,kind}' IS NULL OR req#>>'{basis,kind}' NOT IN ('RETENTION_EXPIRY','SUPPORT_REQUEST')
  THEN RAISE EXCEPTION 'AUTHORITY_NOT_RESOLVED'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['tenantId','venueId','sessionId']) k WHERE req->>k IS NULL OR req->>k !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$')
    THEN RAISE EXCEPTION 'SCOPE_NOT_FOUND'; END IF;
  IF req#>>'{basis,kind}'='RETENTION_EXPIRY' THEN
    IF req->'basis' <> '{"kind":"RETENTION_EXPIRY"}' OR authority->'basis' <> req->'basis' THEN RAISE EXCEPTION 'AUTHORITY_NOT_RESOLVED'; END IF;
  ELSE
    IF (req->'basis') - ARRAY['kind','supportRequestId','expectedSupportRequestVersion'] <> '{}'
      OR (authority->'basis') - ARRAY['kind','supportRequestId','supportRequestVersion','reviewedRequesterUserId'] <> '{}'
      OR req#>>'{basis,supportRequestId}' IS DISTINCT FROM authority#>>'{basis,supportRequestId}'
      OR req#>>'{basis,expectedSupportRequestVersion}' IS DISTINCT FROM authority#>>'{basis,supportRequestVersion}'
      OR req#>>'{basis,supportRequestId}' IS NULL OR req#>>'{basis,supportRequestId}' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$'
      OR req#>>'{basis,expectedSupportRequestVersion}' IS NULL OR req#>>'{basis,expectedSupportRequestVersion}' !~ '^[1-9][0-9]{0,14}$'
      OR authority#>>'{basis,reviewedRequesterUserId}' IS NULL OR authority#>>'{basis,reviewedRequesterUserId}' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$'
    THEN RAISE EXCEPTION 'SUPPORT_REQUEST_CHANGED'; END IF;
  END IF;
  fingerprint := public.pathfinder_guest_disposition_digest(jsonb_build_array('guest-disposition-request-v1',req,authority));
  PERFORM pg_advisory_xact_lock(hashtextextended('guest-disposition:'||(req->>'operationId'),0));
  SELECT * INTO op FROM public.guest_conversation_disposition_operations WHERE id=(req->>'operationId')::uuid FOR UPDATE;
  IF FOUND THEN
    IF op.request_sha256<>fingerprint OR op.request<>req OR op.authority_snapshot<>authority THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
    replayed := true;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.visitor_sessions WHERE id=req->>'sessionId' AND tenant_id=req->>'tenantId' AND venue_id=req->>'venueId') THEN RAISE EXCEPTION 'SCOPE_NOT_FOUND'; END IF;
    INSERT INTO public.guest_conversation_disposition_operations(id,tenant_id,venue_id,session_id,request,authority_snapshot,request_sha256,policy_version,policy_sha256,retention_days)
      VALUES ((req->>'operationId')::uuid,req->>'tenantId',req->>'venueId',req->>'sessionId',req,authority,fingerprint,authority->>'policyVersion',authority->>'policySha256',365)
      RETURNING * INTO op;
  END IF;
  RETURN jsonb_build_object('operationId',op.id,'requestSha256',op.request_sha256,'state',op.state,'authorizedAt',op.authorized_at,'replayed',replayed);
END $$;

CREATE FUNCTION public.pathfinder_guest_disposition_maintenance_check() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_stat_clear_snapshot();
  IF current_setting('transaction_isolation') <> 'read committed'
    OR (SELECT datallowconn FROM pg_database WHERE datname=current_database()) IS DISTINCT FROM false
    OR EXISTS (SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid())
    OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database=current_database())
    THEN RAISE EXCEPTION 'MAINTENANCE_NOT_ESTABLISHED'; END IF;
END $$;

-- Fixed relation order. Admission is already closed; no external I/O occurs in
-- these transactions. SHARE ROW EXCLUSIVE fences all ordinary row writers.
CREATE FUNCTION public.pathfinder_guest_disposition_lock_relations() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['admin_chatlog_notes','ai_usage_events','analytics_events','answer_analysis_snapshots',
    'conversation_insights','engagement_question_responses','generation_request_dispatches','guest_answer_attribution_evaluation_requests',
    'guest_answer_attributions','guest_chat_provider_operations','guest_chat_turns','guest_conversation_disposition_operations',
    'job_records','knowledge_change_proposals','message_feedback','messages','operational_events','question_clusters',
    'support_request_participants','support_requests','tenant_memberships','venue_weekly_themes','visitor_sessions','voice_sessions','weekly_digests','weekly_reports']
  LOOP EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',name); END LOOP;
END $$;

CREATE FUNCTION public.pathfinder_guest_disposition_current_authority(operation uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE op public.guest_conversation_disposition_operations;
BEGIN
  SELECT * INTO STRICT op FROM public.guest_conversation_disposition_operations WHERE id=operation;
  IF op.request#>>'{basis,kind}'='SUPPORT_REQUEST' AND NOT EXISTS (
    SELECT 1 FROM public.support_requests r WHERE r.id=op.request#>>'{basis,supportRequestId}' AND r.tenant_id=op.tenant_id
      AND r.venue_id=op.venue_id AND r.version=(op.request#>>'{basis,expectedSupportRequestVersion}')::int
      AND r.status::text NOT IN ('DRAFT','CANCELLED') AND r.created_by_kind::text IN ('CLIENT','OPERATOR')
      AND EXISTS(SELECT 1 FROM public.tenant_memberships m WHERE m.tenant_id=op.tenant_id
        AND m.user_id=op.authority_snapshot#>>'{basis,reviewedRequesterUserId}' AND m.status::text='ACTIVE'
        AND ((r.created_by_kind::text='CLIENT' AND r.requester_user_id=m.user_id)
          OR EXISTS(SELECT 1 FROM public.support_request_participants p WHERE p.support_request_id=r.id
            AND p.tenant_id=op.tenant_id AND p.venue_id=op.venue_id AND p.user_id=m.user_id AND p.revoked_at IS NULL))))
    THEN RAISE EXCEPTION 'SUPPORT_REQUEST_CHANGED'; END IF;
END $$;

CREATE FUNCTION public.pathfinder_guest_disposition_inventory(operation uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE op public.guest_conversation_disposition_operations; s public.visitor_sessions;
  n bigint; bytes bigint; counts jsonb := '{}'; name text; key text; probe record;
BEGIN
  SELECT * INTO STRICT op FROM public.guest_conversation_disposition_operations WHERE id=operation;
  SELECT * INTO s FROM public.visitor_sessions WHERE id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCOPE_NOT_FOUND'; END IF;
  IF s.disposition_operation_id IS NOT NULL AND s.disposition_operation_id<>operation THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
  IF s.last_active_at > op.effective_cutoff_utc THEN RAISE EXCEPTION 'CUTOFF_NOT_ELIGIBLE'; END IF;
  IF EXISTS(SELECT 1 FROM public.messages WHERE session_id=s.id AND created_at>op.effective_cutoff_utc)
    OR EXISTS(SELECT 1 FROM public.guest_chat_turns WHERE session_id=s.id AND coalesce(completed_at,failed_at,created_at)>op.effective_cutoff_utc)
    OR EXISTS(SELECT 1 FROM public.engagement_question_responses WHERE session_id=s.id AND answered_at>op.effective_cutoff_utc)
    OR EXISTS(SELECT 1 FROM public.message_feedback WHERE session_id=s.id AND updated_at>op.effective_cutoff_utc)
    THEN RAISE EXCEPTION 'CUTOFF_NOT_ELIGIBLE'; END IF;
  PERFORM public.pathfinder_guest_disposition_current_authority(operation);
  IF EXISTS(SELECT 1 FROM public.guest_chat_turns WHERE session_id=s.id AND status NOT IN ('COMPLETE','FAILED'))
    THEN RAISE EXCEPTION 'ACTIVE_WORK'; END IF;
  IF EXISTS(SELECT 1 FROM public.guest_chat_provider_operations WHERE session_id=s.id AND
      (status NOT IN ('OBSERVED','CANCELLED') OR (outcome_code IS NOT NULL AND outcome_code NOT IN ('SUCCEEDED','ADMISSION_REJECTED','FAILED_FALLBACK','SUCCESS','SYNTHETIC_PROVIDER_DARK'))
        OR (usage_reference IS NOT NULL AND usage_reference !~ '^[A-Za-z0-9_-]{1,191}$')))
    THEN RAISE EXCEPTION 'PROVIDER_OUTCOME_UNRESOLVED'; END IF;
  IF EXISTS(SELECT 1 FROM public.guest_chat_turns WHERE session_id=s.id AND
      ((fallback_code IS NOT NULL AND fallback_code NOT IN ('PROVIDER_CONFIGURATION_REQUIRED','PROVIDER_CONNECTION_FAILED','PROVIDER_REQUEST_ABORTED','PROVIDER_INVALID_RESPONSE','PROVIDER_REQUEST_FAILED','NO_RELEVANT_CONTEXT','UNEXPECTED_FAILURE'))
        OR (failure_code IS NOT NULL AND failure_code NOT IN ('AI_UNAVAILABLE','PRE_DISPATCH_FAILURE','PROVIDER_REJECTED'))))
    THEN RAISE EXCEPTION 'PROVIDER_OUTCOME_UNRESOLVED'; END IF;
  FOR name,key IN SELECT * FROM (VALUES
    ('voice_sessions','VOICE_DISPOSITION_UNRESOLVED'),('admin_chatlog_notes','ADMIN_NOTE_DISPOSITION_UNRESOLVED'),
    ('conversation_insights','DERIVED_RECORD_DISPOSITION_UNRESOLVED'),('knowledge_change_proposals','DERIVED_RECORD_DISPOSITION_UNRESOLVED'),
    ('guest_answer_attributions','RESTRICTED_EVIDENCE_DISPOSITION_UNRESOLVED'),
    ('guest_answer_attribution_evaluation_requests','RESTRICTED_EVIDENCE_DISPOSITION_UNRESOLVED')) x(t,k)
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I=$1)',name,CASE WHEN name='voice_sessions' THEN 'visitor_session_id' ELSE 'session_id' END) INTO probe USING s.id;
    IF probe.exists THEN RAISE EXCEPTION '%',key; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.operational_events e WHERE e.tenant_id=op.tenant_id AND e.venue_id=op.venue_id AND
      (e.linked_object_id=s.id OR e.linked_object_id IN (SELECT id::text FROM public.guest_chat_turns WHERE session_id=s.id)
       OR e.linked_object_id IN (SELECT id FROM public.message_feedback WHERE session_id=s.id)
       OR e.linked_object_id IN (SELECT id FROM public.messages WHERE session_id=s.id)))
    THEN RAISE EXCEPTION 'OPERATIONAL_EVENT_DISPOSITION_UNRESOLVED'; END IF;
  FOREACH name IN ARRAY ARRAY['question_clusters','venue_weekly_themes','weekly_reports','answer_analysis_snapshots','generation_request_dispatches'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE tenant_id=$1 AND venue_id=$2)',name) INTO probe USING op.tenant_id,op.venue_id;
    IF probe.exists THEN RAISE EXCEPTION 'AGGREGATE_LINEAGE_UNRESOLVED'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.weekly_digests WHERE tenant_id=op.tenant_id)
    THEN RAISE EXCEPTION 'AGGREGATE_LINEAGE_UNRESOLVED'; END IF;
  -- Generic job payloads lack a trusted session lineage: any scoped record is
  -- conservatively unresolved, including terminal payload/error copies.
  IF EXISTS(SELECT 1 FROM public.job_records WHERE tenant_id=op.tenant_id AND (venue_id IS NULL OR venue_id=op.venue_id))
    THEN RAISE EXCEPTION 'ACTIVE_WORK'; END IF;
  IF EXISTS(SELECT 1 FROM public.ai_usage_events u CROSS JOIN LATERAL jsonb_each_text(to_jsonb(u)) f
    WHERE u.session_id=s.id AND f.key IN ('feature','capability','request_type','route_model_key','provider_request_id','surface','provider','model','pricing_version','usage_observation_status','error_code')
      AND f.value IS NOT NULL AND (length(f.value)>191 OR f.value !~ '^[A-Za-z0-9_.:/-]+$'))
    THEN RAISE EXCEPTION 'ACCOUNTING_DISPOSITION_UNRESOLVED'; END IF;
  IF EXISTS(SELECT 1 FROM public.ai_usage_events WHERE session_id=s.id AND
      (usage_observation_status IS NULL OR usage_observation_status NOT IN ('OBSERVED','NOT_DISPATCHED')
       OR feature NOT IN ('guest-chat','guest-chat-query-embedding') OR surface<>'guest-web'
       OR provider NOT IN ('openai','anthropic')
       OR (error_code IS NOT NULL AND error_code NOT IN ('AbortError','TimeoutError','invalid-provider-response','invalid-structured-output','missing-text-block',
         'provider-AbortError','provider-TimeoutError','provider-client-initialization','provider-connection-error','provider-connection-timeout','provider-error',
         'provider-file-delete-unconfirmed','provider-incomplete-response','provider-not-configured','provider-timeout','provider-user-abort') AND error_code !~ '^provider-http-[1-5][0-9]{2}$')))
    THEN RAISE EXCEPTION 'ACCOUNTING_DISPOSITION_UNRESOLVED'; END IF;
  -- Frozen guest-session text taxonomy from packages/analytics/src/events.ts.
  -- Voice and non-guest configuration/client-assistant labels are not silently
  -- accepted when linked to this terminal-text scope. New labels require review.
  IF EXISTS(SELECT 1 FROM public.analytics_events WHERE session_id=s.id AND event_type NOT IN (
    'session.started','session.ended','message.sent','message.received','message.fallback','message.low_confidence',
    'place_card.viewed','place_card.clicked','directions.opened','visitor.action.clicked','chat.response.feedback',
    'operational_update.viewed','engagement_question.asked','character_chat_started'))
    THEN RAISE EXCEPTION 'ANALYTICS_DISPOSITION_UNRESOLVED'; END IF;
  FOR name,key IN SELECT * FROM (VALUES ('messages','messages'),('guest_chat_turns','turns'),('engagement_question_responses','engagementResponses'),('message_feedback','feedback'),('analytics_events','analyticsEvents')) x(t,k) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE session_id=$1',name) INTO n USING s.id;
    IF n>10000 THEN RAISE EXCEPTION 'INVENTORY_BOUND_EXCEEDED'; END IF;
    -- Logical JSON bytes, not TOAST/compressed storage size. No row content leaves SQL.
    EXECUTE format('SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM public.%I t WHERE session_id=$1',name) INTO bytes USING s.id;
    IF bytes>10485760 THEN RAISE EXCEPTION 'INVENTORY_BOUND_EXCEEDED'; END IF;
    counts := counts || jsonb_build_object(key,n);
  END LOOP;
  RETURN jsonb_build_object('sessions',1)||counts;
END $$;

CREATE FUNCTION public.pathfinder_seal_guest_disposition(operation uuid,expected_request_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='5s' SET statement_timeout='30s' AS $$
DECLARE op public.guest_conversation_disposition_operations; token text; counts jsonb;
BEGIN
  PERFORM public.pathfinder_guest_disposition_maintenance_check();
  PERFORM public.pathfinder_guest_disposition_lock_relations();
  SELECT * INTO STRICT op FROM public.guest_conversation_disposition_operations WHERE id=operation FOR UPDATE;
  IF op.request_sha256<>expected_request_hash THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
  IF op.state='AUTHORIZED' THEN
    SELECT anonymous_token INTO STRICT token FROM public.visitor_sessions WHERE id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
    UPDATE public.guest_conversation_disposition_operations SET
      effective_cutoff_utc=CASE WHEN request#>>'{basis,kind}'='RETENTION_EXPIRY' THEN clock_timestamp()-interval '365 days' ELSE clock_timestamp() END,
      sealed_at=clock_timestamp(), retired_token_digest=public.pathfinder_guest_disposition_token_digest(op.tenant_id,op.venue_id,token),
      sealed_inventory='{}',state='FENCED' WHERE id=operation;
    counts := public.pathfinder_guest_disposition_inventory(operation);
    UPDATE public.guest_conversation_disposition_operations SET sealed_inventory=counts WHERE id=operation;
    UPDATE public.visitor_sessions SET disposition_operation_id=operation WHERE id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  END IF;
  SELECT * INTO STRICT op FROM public.guest_conversation_disposition_operations WHERE id=operation;
  RETURN jsonb_build_object('version','guest-disposition-intent-v1','operationId',op.id,'tenantId',op.tenant_id,'venueId',op.venue_id,'sessionId',op.session_id,
    'request',op.request,'authority',op.authority_snapshot,'requestSha256',op.request_sha256,'policyVersion',op.policy_version,'policySha256',op.policy_sha256,
    'effectiveCutoffUtc',op.effective_cutoff_utc,'retiredTokenDigest',op.retired_token_digest,'affected',op.sealed_inventory);
END $$;

-- Exact field transition validator shared by the legacy guard successors and
-- tombstone triggers. SECURITY INVOKER is essential: a caller cannot acquire the
-- NOLOGIN owner's identity by invoking this predicate.
CREATE FUNCTION public.pathfinder_guest_disposition_mutation_allowed(table_name text,old_row jsonb,new_row jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE op public.guest_conversation_disposition_operations; fields text[]; expected jsonb;
BEGIN
  IF current_user <> 'pathfinder_guest_disposition_executor' THEN RETURN false; END IF;
  SELECT * INTO op FROM public.guest_conversation_disposition_operations WHERE state='FENCED'
    AND tenant_id=old_row->>'tenant_id' AND venue_id=old_row->>'venue_id'
    AND session_id=CASE WHEN table_name='visitor_sessions' THEN old_row->>'id' ELSE old_row->>'session_id' END;
  IF NOT FOUND THEN RETURN false; END IF;
  CASE table_name
    WHEN 'visitor_sessions' THEN
      IF new_row=old_row||jsonb_build_object('disposition_operation_id',op.id) THEN RETURN true; END IF;
      fields:=ARRAY['anonymous_token','latest_lat','latest_lng','pending_engagement_question_id','pending_engagement_is_invented','pending_engagement_asked_message_id','pending_engagement_asked_at'];
      expected:=jsonb_build_object('anonymous_token','disposed:'||op.id,'latest_lat',NULL,'latest_lng',NULL,'pending_engagement_question_id',NULL,'pending_engagement_is_invented',false,'pending_engagement_asked_message_id',NULL,'pending_engagement_asked_at',NULL);
    WHEN 'messages' THEN fields:=ARRAY['content','topic']; expected:='{"content":"","topic":null}';
    WHEN 'guest_chat_turns' THEN
      fields:=ARRAY['request_hash','response_hash','replay_metadata','pending_question_id','pending_is_invented','pending_asked_message_id','pending_asked_at','lease_token','lease_expires_at'];
      expected:=jsonb_build_object('request_hash',public.pathfinder_guest_disposition_digest(jsonb_build_array('retired-request-v1',op.id,op.tenant_id,op.venue_id,op.session_id,old_row->>'id')),
        'response_hash',CASE WHEN old_row->>'response_hash' IS NULL THEN NULL ELSE public.pathfinder_guest_disposition_digest(jsonb_build_array('retired-response-v1',op.id,op.tenant_id,op.venue_id,op.session_id,old_row->>'id')) END,
        'replay_metadata',CASE WHEN old_row->>'status'='COMPLETE' THEN '{}'::jsonb ELSE NULL END,'pending_question_id',NULL,'pending_is_invented',false,'pending_asked_message_id',NULL,'pending_asked_at',NULL,'lease_token',NULL,'lease_expires_at',NULL);
    WHEN 'guest_chat_provider_operations' THEN fields:=ARRAY['lease_token','lease_expires_at']; expected:='{"lease_token":null,"lease_expires_at":null}';
    WHEN 'engagement_question_responses' THEN fields:=ARRAY['question_text','answer_text','sentiment_label','category']; expected:='{"question_text":"","answer_text":"","sentiment_label":null,"category":null}';
    WHEN 'message_feedback' THEN fields:=ARRAY['reason']; expected:='{"reason":null}';
    WHEN 'analytics_events' THEN fields:=ARRAY['metadata']; expected:='{"metadata":null}';
    ELSE RETURN false;
  END CASE;
  RETURN new_row=old_row||expected AND old_row-fields=new_row-fields;
END $$;

CREATE FUNCTION public.pathfinder_apply_guest_disposition(operation uuid,expected_request_hash text,intent_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='5s' SET statement_timeout='30s' AS $$
DECLARE op public.guest_conversation_disposition_operations; counts jsonb; result jsonb;
BEGIN
  PERFORM public.pathfinder_guest_disposition_maintenance_check();
  PERFORM public.pathfinder_guest_disposition_lock_relations();
  SELECT * INTO STRICT op FROM public.guest_conversation_disposition_operations WHERE id=operation FOR UPDATE;
  IF op.request_sha256<>expected_request_hash OR intent_sha256 !~ '^[a-f0-9]{64}$' OR intent_sha256 IS NULL THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
  IF op.state='APPLIED' THEN
    IF op.external_intent_sha256<>intent_sha256 THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
    PERFORM public.pathfinder_verify_guest_disposition(operation);
    RETURN op.receipt;
  END IF;
  IF op.state<>'FENCED' THEN RAISE EXCEPTION 'DURABLE_WRITE_FENCE_UNAVAILABLE'; END IF;
  counts:=public.pathfinder_guest_disposition_inventory(operation);
  IF counts<>op.sealed_inventory THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
  UPDATE public.messages SET content='',topic=NULL WHERE session_id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  -- Keep the original COMPLETE terminal-shape constraint: an empty object erases
  -- replay content without changing its required non-NULL representation.
  UPDATE public.guest_chat_turns SET replay_metadata=CASE WHEN status='COMPLETE' THEN '{}'::jsonb ELSE NULL END,pending_question_id=NULL,pending_is_invented=false,pending_asked_message_id=NULL,pending_asked_at=NULL,lease_token=NULL,lease_expires_at=NULL,
    request_hash=public.pathfinder_guest_disposition_digest(jsonb_build_array('retired-request-v1',op.id,op.tenant_id,op.venue_id,op.session_id,id)),
    response_hash=CASE WHEN response_hash IS NULL THEN NULL ELSE public.pathfinder_guest_disposition_digest(jsonb_build_array('retired-response-v1',op.id,op.tenant_id,op.venue_id,op.session_id,id)) END
    WHERE session_id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  UPDATE public.guest_chat_provider_operations SET lease_token=NULL,lease_expires_at=NULL WHERE session_id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  UPDATE public.engagement_question_responses SET question_text='',answer_text='',sentiment_label=NULL,category=NULL WHERE session_id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  UPDATE public.message_feedback SET reason=NULL WHERE session_id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  UPDATE public.analytics_events SET metadata=NULL WHERE session_id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  UPDATE public.visitor_sessions SET anonymous_token='disposed:'||op.id,latest_lat=NULL,latest_lng=NULL,pending_engagement_question_id=NULL,pending_engagement_is_invented=false,pending_engagement_asked_message_id=NULL,pending_engagement_asked_at=NULL
    WHERE id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  result:=jsonb_build_object('version','guest-disposition-db-receipt-v1','operationId',op.id,'tenantId',op.tenant_id,'venueId',op.venue_id,'sessionId',op.session_id,
    'requestSha256',op.request_sha256,'policyVersion',op.policy_version,'policySha256',op.policy_sha256,'effectiveCutoffUtc',op.effective_cutoff_utc,'externalIntentSha256',intent_sha256,'affected',counts);
  UPDATE public.guest_conversation_disposition_operations SET state='APPLIED',applied_at=clock_timestamp(),external_intent_sha256=intent_sha256,receipt=result WHERE id=operation;
  RETURN result;
END $$;

-- Guard successors, row fences and explicit function privilege closure follow.
CREATE FUNCTION public.pathfinder_verify_guest_disposition(operation uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE op public.guest_conversation_disposition_operations;
BEGIN
  SELECT * INTO STRICT op FROM public.guest_conversation_disposition_operations WHERE id=operation;
  IF op.state<>'APPLIED' OR public.pathfinder_guest_disposition_inventory(operation)<>op.sealed_inventory
    OR NOT EXISTS(SELECT 1 FROM public.visitor_sessions WHERE id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id
      AND disposition_operation_id=op.id AND anonymous_token='disposed:'||op.id AND latest_lat IS NULL AND latest_lng IS NULL
      AND pending_engagement_question_id IS NULL AND NOT pending_engagement_is_invented AND pending_engagement_asked_message_id IS NULL AND pending_engagement_asked_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.messages WHERE session_id=op.session_id AND (content<>'' OR topic IS NOT NULL))
    OR EXISTS(SELECT 1 FROM public.guest_chat_turns WHERE session_id=op.session_id AND
      (replay_metadata IS DISTINCT FROM CASE WHEN status='COMPLETE' THEN '{}'::jsonb ELSE NULL END
       OR pending_question_id IS NOT NULL OR pending_is_invented OR pending_asked_message_id IS NOT NULL OR pending_asked_at IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL
       OR request_hash<>public.pathfinder_guest_disposition_digest(jsonb_build_array('retired-request-v1',op.id,op.tenant_id,op.venue_id,op.session_id,id))
       OR (response_hash IS NOT NULL AND response_hash<>public.pathfinder_guest_disposition_digest(jsonb_build_array('retired-response-v1',op.id,op.tenant_id,op.venue_id,op.session_id,id)))))
    OR EXISTS(SELECT 1 FROM public.guest_chat_provider_operations WHERE session_id=op.session_id AND (lease_token IS NOT NULL OR lease_expires_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM public.engagement_question_responses WHERE session_id=op.session_id AND (question_text<>'' OR answer_text<>'' OR sentiment_label IS NOT NULL OR category IS NOT NULL))
    OR EXISTS(SELECT 1 FROM public.message_feedback WHERE session_id=op.session_id AND reason IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.analytics_events WHERE session_id=op.session_id AND metadata IS NOT NULL)
    THEN RAISE EXCEPTION 'RESTORE_RECONCILIATION_UNRESOLVED'; END IF;
END $$;

CREATE FUNCTION public.pathfinder_guest_disposition_row_blocked(table_name text,row_value jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scoped_session text; scoped_tenant text:=row_value->>'tenant_id'; scoped_venue text:=row_value->>'venue_id';
BEGIN
  IF table_name='visitor_sessions' THEN
    scoped_session:=row_value->>'id';
    IF EXISTS(SELECT 1 FROM public.guest_conversation_disposition_operations WHERE tenant_id=scoped_tenant AND venue_id=scoped_venue
      AND state IN ('FENCED','APPLIED') AND retired_token_digest=public.pathfinder_guest_disposition_token_digest(scoped_tenant,scoped_venue,row_value->>'anonymous_token')) THEN RETURN true; END IF;
  ELSE scoped_session:=CASE WHEN table_name='voice_sessions' THEN row_value->>'visitor_session_id' ELSE row_value->>'session_id' END; END IF;
  IF table_name='operational_events' THEN
    RETURN EXISTS(SELECT 1 FROM public.guest_conversation_disposition_operations o WHERE o.state IN ('FENCED','APPLIED') AND o.tenant_id=scoped_tenant AND o.venue_id=scoped_venue AND
      (o.session_id=row_value->>'linked_object_id'
       OR EXISTS(SELECT 1 FROM public.guest_chat_turns t WHERE t.session_id=o.session_id AND t.id::text=row_value->>'linked_object_id')
       OR EXISTS(SELECT 1 FROM public.message_feedback f WHERE f.session_id=o.session_id AND f.id=row_value->>'linked_object_id')
       OR EXISTS(SELECT 1 FROM public.messages m WHERE m.session_id=o.session_id AND m.id=row_value->>'linked_object_id')));
  END IF;
  IF scoped_session IS NULL THEN RETURN false; END IF;
  -- Lock the parent when present. Restore tombstones also exist without a parent.
  PERFORM 1 FROM public.visitor_sessions WHERE id=scoped_session AND tenant_id=scoped_tenant AND venue_id=scoped_venue FOR KEY SHARE;
  RETURN EXISTS(SELECT 1 FROM public.guest_conversation_disposition_operations WHERE tenant_id=scoped_tenant AND venue_id=scoped_venue AND session_id=scoped_session AND state IN ('FENCED','APPLIED'));
END $$;

-- Called only by the same privileged maintenance engine after external journal
-- high-water, source policy and scoped operator reconfirmation have been checked.
-- It never infers external journal completeness from this restored database.
CREATE FUNCTION public.pathfinder_restore_guest_disposition(intent jsonb,intent_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET lock_timeout='5s' SET statement_timeout='30s' AS $$
DECLARE req jsonb:=intent->'request'; authority jsonb:=intent->'authority';
  operation uuid:=(intent->>'operationId')::uuid; fingerprint text;
  op public.guest_conversation_disposition_operations; token text; present boolean;
BEGIN
  PERFORM public.pathfinder_guest_disposition_maintenance_check();
  PERFORM public.pathfinder_guest_disposition_lock_relations();
  fingerprint:=public.pathfinder_guest_disposition_digest(jsonb_build_array('guest-disposition-request-v1',req,authority));
  IF octet_length(intent::text)>65536 OR intent->>'version' IS DISTINCT FROM 'guest-disposition-intent-v1'
    OR intent_sha256 IS NULL OR intent_sha256 !~ '^[a-f0-9]{64}$'
    OR intent->>'requestSha256' IS DISTINCT FROM fingerprint
    OR req->>'operationId' IS DISTINCT FROM intent->>'operationId'
    OR req->>'tenantId' IS DISTINCT FROM intent->>'tenantId' OR req->>'venueId' IS DISTINCT FROM intent->>'venueId' OR req->>'sessionId' IS DISTINCT FROM intent->>'sessionId'
    OR req->>'expectedPolicySha256' IS DISTINCT FROM intent->>'policySha256' OR req->>'expectedPolicyVersion' IS DISTINCT FROM intent->>'policyVersion'
    OR authority->>'policySha256' IS DISTINCT FROM intent->>'policySha256' OR authority->>'policyVersion' IS DISTINCT FROM intent->>'policyVersion'
    OR intent->>'retiredTokenDigest' IS NULL OR intent->>'retiredTokenDigest' !~ '^[a-f0-9]{64}$'
    OR (intent->>'effectiveCutoffUtc')::timestamptz>clock_timestamp()
    THEN RAISE EXCEPTION 'RESTORE_RECONCILIATION_UNRESOLVED'; END IF;
  SELECT anonymous_token INTO token FROM public.visitor_sessions WHERE id=intent->>'sessionId' AND tenant_id=intent->>'tenantId' AND venue_id=intent->>'venueId';
  present:=FOUND;
  SELECT * INTO op FROM public.guest_conversation_disposition_operations WHERE id=operation FOR UPDATE;
  IF FOUND THEN
    IF op.request_sha256<>fingerprint OR op.request<>req OR op.authority_snapshot<>authority
      OR (op.retired_token_digest IS NOT NULL AND op.retired_token_digest<>intent->>'retiredTokenDigest')
      OR (op.external_intent_sha256 IS NOT NULL AND op.external_intent_sha256<>intent_sha256)
      THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
    IF op.state='APPLIED' THEN
      PERFORM public.pathfinder_verify_guest_disposition(operation);
      RETURN jsonb_build_object('resolution','APPLIED_POSTCONDITIONS_VERIFIED','currentSessionPresent',true,'receipt',op.receipt);
    END IF;
  ELSE
    -- Missing-parent restoration retains only externally verified scoped authority,
    -- never a synthetic visitor row or a fabricated one-session erasure effect.
    INSERT INTO public.guest_conversation_disposition_operations(id,tenant_id,venue_id,session_id,request,authority_snapshot,request_sha256,policy_version,policy_sha256,retention_days)
      VALUES(operation,intent->>'tenantId',intent->>'venueId',intent->>'sessionId',req,authority,fingerprint,intent->>'policyVersion',intent->>'policySha256',365)
      RETURNING * INTO op;
  END IF;
  -- Missing-session restoration still requires the current selected support ACL.
  PERFORM public.pathfinder_guest_disposition_current_authority(operation);
  IF op.state='AUTHORIZED' THEN
    IF present AND public.pathfinder_guest_disposition_token_digest(op.tenant_id,op.venue_id,token)<>intent->>'retiredTokenDigest' THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
    UPDATE public.guest_conversation_disposition_operations SET state='FENCED',sealed_at=clock_timestamp(),
      effective_cutoff_utc=(intent->>'effectiveCutoffUtc')::timestamptz,retired_token_digest=intent->>'retiredTokenDigest',sealed_inventory=intent->'affected' WHERE id=operation;
  ELSE
    IF op.effective_cutoff_utc IS DISTINCT FROM (intent->>'effectiveCutoffUtc')::timestamptz OR op.sealed_inventory IS DISTINCT FROM intent->'affected' THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
  END IF;
  IF NOT present THEN
    RETURN jsonb_build_object('resolution','TOMBSTONE_ONLY','currentSessionPresent',false,'operationId',operation,
      'tenantId',op.tenant_id,'venueId',op.venue_id,'sessionId',op.session_id,'requestSha256',fingerprint,'externalIntentSha256',intent_sha256);
  END IF;
  UPDATE public.visitor_sessions SET disposition_operation_id=operation WHERE id=op.session_id AND tenant_id=op.tenant_id AND venue_id=op.venue_id;
  RETURN jsonb_build_object('resolution','APPLIED_POSTCONDITIONS_VERIFIED','currentSessionPresent',true,
    'receipt',public.pathfinder_apply_guest_disposition(operation,fingerprint,intent_sha256));
END $$;

CREATE FUNCTION public.pathfinder_guard_guest_disposition_row() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'guest disposition retained relations cannot be truncated'; END IF;
  IF TG_OP='UPDATE' AND public.pathfinder_guest_disposition_mutation_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='visitor_sessions' AND (
    (TG_OP='INSERT' AND to_jsonb(NEW)->>'disposition_operation_id' IS NOT NULL)
    OR (TG_OP='UPDATE' AND to_jsonb(OLD)->>'disposition_operation_id' IS DISTINCT FROM to_jsonb(NEW)->>'disposition_operation_id'))
    THEN RAISE EXCEPTION 'DURABLE_WRITE_FENCE_UNAVAILABLE'; END IF;
  IF (TG_OP<>'INSERT' AND public.pathfinder_guest_disposition_row_blocked(TG_TABLE_NAME,to_jsonb(OLD)))
    OR (TG_OP<>'DELETE' AND public.pathfinder_guest_disposition_row_blocked(TG_TABLE_NAME,to_jsonb(NEW)))
    THEN RAISE EXCEPTION 'GUEST_CONVERSATION_DISPOSED'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE FUNCTION public.pathfinder_guard_guest_disposition_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_user<>'pathfinder_guest_disposition_executor' OR TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'guest disposition operation is immutable authority'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'AUTHORIZED' THEN RAISE EXCEPTION 'guest disposition must begin authorized'; END IF;
  ELSE
    IF (to_jsonb(OLD)-ARRAY['state','sealed_at','applied_at','effective_cutoff_utc','retired_token_digest','external_intent_sha256','sealed_inventory','receipt'])
      IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','sealed_at','applied_at','effective_cutoff_utc','retired_token_digest','external_intent_sha256','sealed_inventory','receipt'])
      OR OLD.state='APPLIED'
      OR (OLD.state='FENCED' AND NEW.state NOT IN ('FENCED','APPLIED'))
      OR (OLD.state='FENCED' AND (OLD.effective_cutoff_utc IS DISTINCT FROM NEW.effective_cutoff_utc OR OLD.retired_token_digest IS DISTINCT FROM NEW.retired_token_digest OR OLD.sealed_at IS DISTINCT FROM NEW.sealed_at))
      THEN RAISE EXCEPTION 'OPERATION_CONFLICT'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_disposition_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.guest_conversation_disposition_operations FOR EACH ROW EXECUTE FUNCTION public.pathfinder_guard_guest_disposition_operation();
CREATE TRIGGER guest_disposition_operation_no_truncate BEFORE TRUNCATE ON public.guest_conversation_disposition_operations FOR EACH STATEMENT EXECUTE FUNCTION public.pathfinder_guard_guest_disposition_operation();

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['visitor_sessions','messages','guest_chat_turns','guest_chat_provider_operations','engagement_question_responses',
    'message_feedback','analytics_events','ai_usage_events','voice_sessions','admin_chatlog_notes','conversation_insights',
    'knowledge_change_proposals','guest_answer_attributions','guest_answer_attribution_evaluation_requests','operational_events'] LOOP
    EXECUTE format('CREATE TRIGGER guest_disposition_row_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pathfinder_guard_guest_disposition_row()',name);
    EXECUTE format('CREATE TRIGGER guest_disposition_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.pathfinder_guard_guest_disposition_row()',name);
  END LOOP;
END $$;

-- Exact prior guard body, plus one role-and-field-scoped maintenance branch.
CREATE OR REPLACE FUNCTION pathfinder_guard_guest_chat_turn_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND public.pathfinder_guest_disposition_mutation_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'guest chat turns are durable lifecycle evidence'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED' OR NEW."lease_token" IS NOT NULL OR NEW."lease_expires_at" IS NOT NULL
       OR NEW."claimed_at" IS NOT NULL OR NEW."user_message_id" IS NOT NULL OR NEW."assistant_message_id" IS NOT NULL
       OR NEW."replay_metadata" IS NOT NULL OR NEW."response_hash" IS NOT NULL OR NEW."fallback_code" IS NOT NULL
       OR NEW."failure_code" IS NOT NULL OR NEW."completed_at" IS NOT NULL OR NEW."failed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'new guest chat turn must be a pristine reservation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" <> NEW."id" OR OLD."tenant_id" <> NEW."tenant_id" OR OLD."venue_id" <> NEW."venue_id"
     OR OLD."session_id" <> NEW."session_id" OR OLD."request_id" <> NEW."request_id"
     OR OLD."request_hash" <> NEW."request_hash" OR OLD."turn_sequence" <> NEW."turn_sequence"
     OR OLD."user_message_sequence" <> NEW."user_message_sequence"
     OR OLD."assistant_message_sequence" <> NEW."assistant_message_sequence"
     OR OLD."pending_question_id" IS DISTINCT FROM NEW."pending_question_id"
     OR OLD."pending_is_invented" IS DISTINCT FROM NEW."pending_is_invented"
     OR OLD."pending_asked_message_id" IS DISTINCT FROM NEW."pending_asked_message_id"
     OR OLD."pending_asked_at" IS DISTINCT FROM NEW."pending_asked_at"
     OR OLD."created_at" <> NEW."created_at" THEN
    RAISE EXCEPTION 'guest chat turn identity is immutable';
  END IF;
  IF OLD."status" IN ('COMPLETE','FAILED','AMBIGUOUS') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal guest chat turn evidence is immutable';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'RESERVED' AND NEW."status" IN ('GENERATING','FAILED'))
    OR (OLD."status" = 'GENERATING' AND NEW."status" IN ('COMPLETE','FAILED','AMBIGUOUS'))
  ) THEN RAISE EXCEPTION 'invalid guest chat turn transition'; END IF;
  IF OLD."status" = 'RESERVED' AND NEW."status" = 'GENERATING' AND (
    (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id") <> 2
    OR NOT EXISTS (SELECT 1 FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."kind" = 'QUERY_EMBEDDING' AND p."status" = 'RESERVED')
    OR NOT EXISTS (SELECT 1 FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."kind" = 'RESPONSE_GENERATION' AND p."status" = 'RESERVED')
  ) THEN RAISE EXCEPTION 'guest chat turn provider reservations are incomplete'; END IF;
  IF NEW."status" = 'COMPLETE' AND (
    NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."user_message_id" AND m."guest_chat_turn_id" = NEW."id" AND m."role" = 'user' AND m."turn_message_sequence" = 0 AND m."session_sequence" = NEW."user_message_sequence")
    OR NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."assistant_message_id" AND m."guest_chat_turn_id" = NEW."id" AND m."role" = 'assistant' AND m."turn_message_sequence" = 1 AND m."session_sequence" = NEW."assistant_message_sequence")
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" = 'OBSERVED') <> 2
  ) THEN RAISE EXCEPTION 'completed guest chat turn evidence is incomplete'; END IF;
  IF NEW."status" = 'FAILED' AND (
    (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id") <> 2
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" IN ('OBSERVED','CANCELLED')) <> 2
  ) THEN RAISE EXCEPTION 'failed guest chat turn provider evidence is not terminal'; END IF;
  IF NEW."status" = 'AMBIGUOUS' AND (
    (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id") <> 2
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" IN ('OBSERVED','CANCELLED','TERMINAL_AMBIGUOUS')) <> 2
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" IN ('OBSERVED','TERMINAL_AMBIGUOUS')) < 1
  ) THEN RAISE EXCEPTION 'ambiguous guest chat turn provider evidence is not terminal'; END IF;
  RETURN NEW;
END;
$$;

-- Exact prior guard body, plus one role-and-field-scoped maintenance branch.
CREATE OR REPLACE FUNCTION pathfinder_guard_guest_chat_provider_operation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND public.pathfinder_guest_disposition_mutation_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'guest chat provider operations are durable evidence'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED' OR NEW."dispatched_at" IS NOT NULL OR NEW."observed_at" IS NOT NULL
       OR NEW."outcome_code" IS NOT NULL OR NEW."usage_reference" IS NOT NULL THEN
      RAISE EXCEPTION 'new guest chat provider operation must be reserved';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" <> NEW."id" OR OLD."tenant_id" <> NEW."tenant_id" OR OLD."venue_id" <> NEW."venue_id"
     OR OLD."session_id" <> NEW."session_id" OR OLD."turn_id" <> NEW."turn_id"
     OR OLD."kind" <> NEW."kind" OR OLD."invocation_id" <> NEW."invocation_id"
     OR OLD."created_at" <> NEW."created_at" THEN
    RAISE EXCEPTION 'guest chat provider operation identity is immutable';
  END IF;
  IF OLD."status" IN ('OBSERVED','CANCELLED','TERMINAL_AMBIGUOUS') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal guest chat provider operation evidence is immutable';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'RESERVED' AND NEW."status" = 'DISPATCHED')
    OR (OLD."status" = 'RESERVED' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'DISPATCHED' AND NEW."status" IN ('OBSERVED','TERMINAL_AMBIGUOUS'))
  ) THEN RAISE EXCEPTION 'invalid guest chat provider operation transition'; END IF;
  RETURN NEW;
END;
$$;

-- Exact prior guard body, plus one role-and-field-scoped maintenance branch.
CREATE OR REPLACE FUNCTION pathfinder_guard_guest_chat_message_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND public.pathfinder_guest_disposition_mutation_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'guest chat messages are durable evidence'; END IF;
  IF TG_OP = 'DELETE' AND OLD."guest_chat_turn_id" IS NOT NULL THEN RAISE EXCEPTION 'guest chat messages are durable evidence'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."guest_chat_turn_id" IS NOT NULL AND (
    OLD."id" IS DISTINCT FROM NEW."id" OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
    OR OLD."venue_id" IS DISTINCT FROM NEW."venue_id" OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."guest_chat_turn_id" IS DISTINCT FROM NEW."guest_chat_turn_id"
    OR OLD."session_sequence" IS DISTINCT FROM NEW."session_sequence"
    OR OLD."turn_message_sequence" IS DISTINCT FROM NEW."turn_message_sequence"
    OR OLD."role" IS DISTINCT FROM NEW."role" OR OLD."content" IS DISTINCT FROM NEW."content"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  ) THEN RAISE EXCEPTION 'guest chat message identity/content is immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Exact prior guard body, plus one role-and-field-scoped maintenance branch.
CREATE OR REPLACE FUNCTION pathfinder_guard_guest_chat_engagement_response_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND public.pathfinder_guest_disposition_mutation_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'guest chat engagement responses are durable evidence'; END IF;
  IF TG_OP = 'INSERT' AND NEW."guest_chat_turn_id" IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."asked_message_id" AND m."tenant_id" = NEW."tenant_id" AND m."venue_id" = NEW."venue_id" AND m."session_id" = NEW."session_id" AND m."role" = 'assistant')
    OR NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."answer_message_id" AND m."tenant_id" = NEW."tenant_id" AND m."venue_id" = NEW."venue_id" AND m."session_id" = NEW."session_id" AND m."role" = 'user')
  ) THEN RAISE EXCEPTION 'guest chat engagement message roles are invalid'; END IF;
  IF OLD."guest_chat_turn_id" IS NOT NULL THEN RAISE EXCEPTION 'guest chat engagement responses are immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO pathfinder_guest_disposition_executor;
GRANT UPDATE ON public.visitor_sessions, public.messages, public.guest_chat_turns, public.guest_chat_provider_operations,
  public.engagement_question_responses, public.message_feedback, public.analytics_events TO pathfinder_guest_disposition_executor;
-- PostgreSQL requires a write privilege for SHARE ROW EXCLUSIVE. These grants
-- are to the unloginable, ungranted function owner, not the application principal.
GRANT UPDATE ON public.admin_chatlog_notes, public.ai_usage_events, public.answer_analysis_snapshots,
  public.conversation_insights, public.generation_request_dispatches, public.guest_answer_attribution_evaluation_requests,
  public.guest_answer_attributions, public.job_records, public.knowledge_change_proposals, public.operational_events,
  public.question_clusters, public.support_requests, public.support_request_participants, public.tenant_memberships, public.venue_weekly_themes, public.voice_sessions,
  public.weekly_digests, public.weekly_reports TO pathfinder_guest_disposition_executor;
-- PUBLIC may call only content-free read predicates and trigger helpers. No erase
-- or authorization function is executable until an operator grants its exact signature.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'pathfinder_authorize_guest_disposition','pathfinder_seal_guest_disposition','pathfinder_apply_guest_disposition','pathfinder_restore_guest_disposition',
      'pathfinder_guest_disposition_row_blocked')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pathfinder_guest_disposition_executor',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.pathfinder_guest_disposition_row_blocked(text,jsonb) TO PUBLIC;
COMMIT;
