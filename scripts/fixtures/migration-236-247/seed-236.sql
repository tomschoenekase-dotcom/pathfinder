-- Synthetic predecessor-only fixture. All triggers and constraints remain enabled.
BEGIN;
INSERT INTO tenants (id,name,slug,updated_at) VALUES
 ('mr-t1','Migration fixture one','mr-t1','2026-09-01'),('mr-t2','Migration fixture two','mr-t2','2026-09-01');
INSERT INTO users(id,email,updated_at) VALUES('mr-owner','migration-fixture@example.test','2026-09-01');
DO $$
DECLARE s text; t text; v text; k text; p uuid; source_hash text; stamp timestamp := '2026-09-01 12:00:00.123';
BEGIN
 FOREACH s IN ARRAY ARRAY['a','b','c'] LOOP
  t := CASE WHEN s='c' THEN 'mr-t2' ELSE 'mr-t1' END; v := 'mr-v-'||s;
  INSERT INTO venues(id,tenant_id,name,slug,description,updated_at) VALUES(v,t,'Synthetic gallery '||s,v,'Retain exact visitor and employee evidence',stamp);
  INSERT INTO visitor_sessions(id,tenant_id,venue_id,anonymous_token) VALUES('mr-session-'||s,t,v,'synthetic-session-'||s);
  INSERT INTO conversation_insights(id,tenant_id,venue_id,session_id,category,confidence,summary,capability,provider,model,analyzer_version,created_at)
   VALUES(md5('insight-'||s)::uuid,t,v,'mr-session-'||s,'KNOWLEDGE_GAP',0.85,'Retain synthetic insight '||s,'conversations:review','fixture','fixture','migration-proof-v1',stamp);
  INSERT INTO custom_characters(id,tenant_id,venue_id,display_name,created_by,updated_by,updated_at)
   VALUES('mr-character-'||s,t,v,'Synthetic candidate','fixture','fixture',stamp);
  INSERT INTO character_factory_jobs(id,tenant_id,venue_id,request_id,request_fingerprint,action,request_payload,custom_character_id,created_by,updated_at)
   VALUES('mr-job-'||s,t,v,'mr-job-'||s,repeat('a',64),'INSPECT','{}','mr-character-'||s,'fixture',stamp);
  INSERT INTO agent_identities(id,tenant_id,venue_id,identity_key,name,agent_type,access_scope,enabled,created_by,updated_at)
   VALUES('mr-agent-'||s,t,v,'mr-agent-'||s,'Synthetic source agent','fixture','VENUE',true,'fixture',stamp);
  INSERT INTO support_requests(id,tenant_id,venue_id,category,subject,created_by_kind,created_by_id,updated_by_kind,updated_by_id,updated_at)
   VALUES('mr-support-'||s,t,v,'CONTENT_CORRECTION','Synthetic old support','OPERATOR','fixture','OPERATOR','fixture',stamp);
  INSERT INTO support_request_audit_events(id,tenant_id,venue_id,support_request_id,request_version,event_type,actor_kind,actor_id)
   VALUES('mr-support-event-'||s,t,v,'mr-support-'||s,1,'CREATED','OPERATOR','fixture');
  INSERT INTO support_messages(id,tenant_id,venue_id,support_request_id,author_kind,author_id,body,visibility,request_version,client_version,submission_request_id,submission_input_hash)
   VALUES('mr-message-'||s,t,v,'mr-support-'||s,'OPERATOR','fixture','Retain original support message','CLIENT_VISIBLE',1,1,md5('message-'||s)::uuid,repeat('a',64));
  INSERT INTO venue_knowledge_entries(id,tenant_id,venue_id,title,category,content,source_type,authorship,updated_at)
   VALUES('mr-knowledge-'||s,t,v,'Retained canonical guidance','Visitor services','The quiet room is beside the gallery.','SYNTHETIC_FIXTURE','HUMAN_AUTHORED',stamp);
  FOREACH k IN ARRAY ARRAY['package','operational','universal','legacy','conflict','duplicate','empty','race','decline'] LOOP
   p := md5(k||'-'||s)::uuid;
   INSERT INTO knowledge_change_proposals(id,tenant_id,venue_id,target_knowledge_entry_id,proposed_change,reason,confidence,status,created_by_type,created_by_id,reviewer_id,review_note,reviewed_at,updated_at,support_request_id,support_request_version)
    VALUES(p,t,v,'mr-knowledge-'||s,'Synthetic proposed guidance '||k,'Migration preservation fixture',0.9,(CASE WHEN k='decline' THEN 'REJECTED' ELSE 'APPROVED' END)::"KnowledgeChangeProposalStatus",'HUMAN','fixture','fixture','Synthetic review',stamp,stamp,CASE WHEN k='decline' THEN 'mr-support-'||s ELSE NULL END,CASE WHEN k='decline' THEN 1 ELSE NULL END);
  END LOOP;
  INSERT INTO venue_packages(id,tenant_id,venue_id,draft_key,schema_version,payload,payload_hash,base_digest,validation_report,preview_plan,created_by,updated_at)
   VALUES('mr-package-'||s,t,v,md5('draft-'||s)::uuid,1,'{}',repeat('a',64),repeat('b',64),'{}','{}','fixture',stamp);
  INSERT INTO knowledge_proposal_package_handoffs(tenant_id,venue_id,proposal_id,venue_package_id,preview_hash,created_by)
   VALUES(t,v,md5('package-'||s)::uuid,'mr-package-'||s,repeat('a',64),'fixture');
  INSERT INTO operational_updates(id,tenant_id,venue_id,severity,title,body,starts_at,expires_at,created_by,updated_at)
   VALUES('mr-update-'||s,t,v,'WARNING','Synthetic notice','Retained content',stamp,'2099-01-01','fixture',stamp);
  INSERT INTO knowledge_proposal_operational_update_handoffs(tenant_id,venue_id,proposal_id,operational_update_id,preview_hash,created_by)
   VALUES(t,v,md5('operational-'||s)::uuid,'mr-update-'||s,repeat('a',64),'fixture');
  FOREACH k IN ARRAY ARRAY['universal','legacy'] LOOP
   INSERT INTO content_module_identities(id,tenant_id,venue_id,kind) VALUES('mr-module-'||k||'-'||s,t,v,'OPERATIONAL_FACT');
   INSERT INTO content_module_revisions(id,tenant_id,venue_id,module_id,kind,version,audience,created_by)
    VALUES('mr-revision-'||k||'-'||s,t,v,'mr-module-'||k||'-'||s,'OPERATIONAL_FACT',1,'PUBLIC','fixture');
  END LOOP;
  INSERT INTO knowledge_proposal_universal_content_handoffs(tenant_id,venue_id,proposal_id,module_id,module_kind,revision_id,classification,relation,preview_hash,draft_hash,proposal_updated_at,created_by)
   VALUES(t,v,md5('universal-'||s)::uuid,'mr-module-universal-'||s,'OPERATIONAL_FACT','mr-revision-universal-'||s,'ADDITION','NEW_FACT',repeat('a',64),repeat('b',64),stamp,'fixture');
  INSERT INTO legacy_knowledge_universal_content_adoptions(tenant_id,venue_id,proposal_id,legacy_knowledge_entry_id,module_id,module_kind,revision_id,proposal_updated_at,legacy_knowledge_updated_at,legacy_snapshot,legacy_snapshot_hash,draft_hash,created_by)
   VALUES(t,v,md5('legacy-'||s)::uuid,'mr-knowledge-'||s,'mr-module-legacy-'||s,'OPERATIONAL_FACT','mr-revision-legacy-'||s,stamp,stamp,'{"fixture":"canonical prior state"}',repeat('a',64),repeat('b',64),'fixture');
  INSERT INTO external_access_credentials(id,tenant_id,client_id,venue_id,scope_key,kind,label,capabilities,secret_prefix,secret_hash,enabled,created_by,created_at,updated_at)
   VALUES('mr-credential-'||s,t,t,v,v,'MCP','Unusable synthetic metadata',ARRAY['accounts:read','venues:read'],'fixture-'||s,'$argon2id$not-a-real-credential',false,'fixture',stamp,stamp);
  INSERT INTO external_credential_operation_receipts(operation_id,operation_hash,operation_kind,tenant_id,client_id,venue_id,scope_key,credential_id,actor_id,created_at)
   VALUES(md5('credential-'||s)::uuid,repeat('a',64),'ISSUE',t,t,v,v,'mr-credential-'||s,'fixture',stamp);
  INSERT INTO agent_questions(id,operation_id,tenant_id,venue_id,agent_identity_id,question,created_at,updated_at,callback_metadata)
   VALUES('mr-question-'||s,md5('question-'||s)::uuid,t,v,'mr-agent-'||s,'Keep the canonical quiet room guidance?',stamp-interval '1 second',stamp-interval '1 second',
    jsonb_build_object('workflow','semantic-venue-update','proposalId',md5('conflict-'||s)::uuid::text,'previewHash',repeat('a',64),'classification','CONFLICT'));
  UPDATE agent_questions SET status='ANSWERED',answer='Keep canonical',answered_by_id='fixture',answered_at=stamp,updated_at=stamp WHERE id='mr-question-'||s;
  INSERT INTO intake_runs(id,tenant_id,venue_id,source_kind,display_name,requested_by)
   VALUES('mr-intake-'||s,t,v,'FILE_UPLOAD','Synthetic source document','fixture');
  INSERT INTO intake_uploads(id,tenant_id,venue_id,request_id,request_hash,display_name,file_name,mime_type,byte_size,sha256,object_key,object_generation,requested_by,requested_by_role,updated_at)
   VALUES('mr-upload-'||s,t,v,md5('upload-request-'||s)::uuid,repeat('a',64),'Synthetic source','source.txt','text/plain',16,encode(sha256(convert_to('Synthetic source','UTF8')),'hex'),'fixture/source-'||s,md5('generation-'||s)::uuid,'fixture','PLATFORM_ADMIN',stamp);
  UPDATE intake_uploads SET status='VERIFYING',storage_version_id='fixture-version',verification_claim_id=md5('claim-'||s)::uuid,verification_claimed_at=CURRENT_TIMESTAMP,verification_lease_until=CURRENT_TIMESTAMP+interval '1 hour' WHERE id='mr-upload-'||s;
  FOREACH k IN ARRAY ARRAY['PRECHECK','RESOURCE_SAFETY','MALWARE'] LOOP
   INSERT INTO intake_upload_verification_receipts(tenant_id,venue_id,upload_id,kind,verdict,engine,engine_version,verdict_hash,object_generation,storage_version_id,computed_byte_size,computed_sha256,claim_id)
    VALUES(t,v,'mr-upload-'||s,k::"IntakeUploadVerificationKind",(CASE WHEN k='MALWARE' THEN 'CLEAN' ELSE 'PASSED' END)::"IntakeUploadVerificationVerdict",'synthetic-no-provider','1',repeat('b',64),md5('generation-'||s)::uuid,'fixture-version',16,encode(sha256(convert_to('Synthetic source','UTF8')),'hex'),md5('claim-'||s)::uuid);
  END LOOP;
  UPDATE intake_uploads SET status='AWAITING_REVIEW',verification_claim_id=NULL,verification_claimed_at=NULL,verification_lease_until=NULL,verified_at=CURRENT_TIMESTAMP,intake_run_id='mr-intake-'||s WHERE id='mr-upload-'||s;
  INSERT INTO intake_file_extraction_receipts(id,tenant_id,venue_id,run_id,upload_id,request_id,request_hash,outcome,source_object_generation,source_storage_version_id,source_sha256,source_byte_size,source_mime_type,extractor,extractor_version,extracted_text,extracted_text_hash,extracted_character_count,extracted_line_count,created_by)
   VALUES(md5('extraction-'||s)::uuid,t,v,'mr-intake-'||s,'mr-upload-'||s,md5('extract-request-'||s)::uuid,repeat('a',64),'SUCCEEDED',md5('generation-'||s)::uuid,'fixture-version',encode(sha256(convert_to('Synthetic source','UTF8')),'hex'),16,'text/plain','pathfinder-utf8-document','1','Synthetic source',encode(sha256(convert_to('Synthetic source','UTF8')),'hex'),16,1,'fixture');
  SELECT encode(sha256(convert_to('{"id":'||to_json(upload.id)::text||',"receipt":{"computedByteSize":'||receipt.computed_byte_size::text||',"computedSha256":'||to_json(receipt.computed_sha256::text)::text||',"objectGeneration":'||to_json(receipt.object_generation::text)::text||',"storageVersionId":'||to_json(receipt.storage_version_id)::text||',"uploadId":'||to_json(receipt.upload_id)::text||',"verdictHash":'||to_json(receipt.verdict_hash::text)::text||'}}','UTF8')),'hex') INTO source_hash
   FROM intake_uploads upload JOIN intake_upload_verification_receipts receipt ON receipt.upload_id=upload.id WHERE upload.id='mr-upload-'||s AND receipt.kind='MALWARE';
  INSERT INTO intake_v1_submissions(id,tenant_id,venue_id,owner_user_id,operation_id,request_hash,updated_at)
   VALUES('mr-submission-'||s,t,v,'mr-owner',md5('submission-'||s)::uuid,repeat('a',64),stamp);
  INSERT INTO intake_v1_submission_revisions(id,submission_id,tenant_id,venue_id,revision,operation_id,request_hash,manifest,manifest_hash,critical_missing)
   VALUES('mr-submission-revision-'||s,'mr-submission-'||s,t,v,1,md5('submission-revision-'||s)::uuid,repeat('a',64),'{}',repeat('b',64),'[]');
  INSERT INTO intake_v1_submission_members(id,revision_id,tenant_id,venue_id,ordinal,kind,intake_upload_id,immutable_hash)
   VALUES('mr-member-'||s,'mr-submission-revision-'||s,t,v,0,'INTAKE_UPLOAD','mr-upload-'||s,source_hash);
  INSERT INTO intake_v1_processing_dispatches(id,tenant_id,venue_id,revision_id,member_id,intake_run_id,operation_id,kind,status,source_hash,policy_version,file_extraction_receipt_id,completed_at,updated_at)
   VALUES('mr-processing-'||s,t,v,'mr-submission-revision-'||s,'mr-member-'||s,'mr-intake-'||s,md5('processing-'||s)::uuid,'FILE_EXTRACTION','COMPLETED',source_hash,'intake-v1-file-extraction-v1',md5('extraction-'||s)::uuid,CURRENT_TIMESTAMP,stamp);
 END LOOP;
END $$;
COMMIT;
