-- These tables exist only after the real prefix has advanced through 245.
BEGIN;
DO $$
DECLARE s text; t text; v text; stamp timestamp := '2026-09-01 12:00:00.123';
BEGIN
 FOREACH s IN ARRAY ARRAY['a','b','c'] LOOP
  t := CASE WHEN s='c' THEN 'mr-t2' ELSE 'mr-t1' END; v := 'mr-v-'||s;
  INSERT INTO semantic_duplicate_resolutions(id,tenant_id,venue_id,proposal_id,proposal_updated_at,preview_hash,target_knowledge_entry_id,target_snapshot_hash,input_hash,relation,desired,source_evidence,resolution_note,created_by)
   VALUES(md5('duplicate-resolution-'||s)::uuid,t,v,md5('duplicate-'||s)::uuid,stamp,repeat('a',64),'mr-knowledge-'||s,repeat('b',64),repeat('c',64),'NEW_FACT','{"content":"The quiet room is beside the gallery."}','[{"sourceId":"synthetic-evidence"}]','Retain canonical guidance','fixture');
  INSERT INTO semantic_conflict_resolutions(id,tenant_id,venue_id,proposal_id,proposal_updated_at,preview_hash,question_id,question_updated_at,answered_at,answer_hash,target_knowledge_entry_id,target_snapshot_hash,input_hash,relation,conflict_desired,desired,outcome,resolution_note,created_by)
   VALUES(md5('conflict-resolution-'||s)::uuid,t,v,md5('conflict-'||s)::uuid,stamp,repeat('a',64),'mr-question-'||s,stamp,stamp,encode(sha256(convert_to('Keep canonical','UTF8')),'hex'),'mr-knowledge-'||s,repeat('b',64),repeat('c',64),'CORRECTS','{"content":"Proposed conflicting location"}','{"content":"The quiet room is beside the gallery."}','KEEP_CANONICAL','Reviewed exact answered question','fixture');
  INSERT INTO character_candidate_review_briefs(id,tenant_id,venue_id,custom_character_id,candidate_version,candidate_revision,artifact_fingerprint,brief,rationale,source_provenance,created_by)
   VALUES('mr-brief-'||s,t,v,'mr-character-'||s,1,1,repeat('a',64),'Synthetic imported candidate','Retain review source','IMPORTED_FIXTURE','fixture');
  INSERT INTO character_candidate_review_decisions(id,tenant_id,venue_id,brief_id,custom_character_id,candidate_version,candidate_revision,artifact_fingerprint,operation_id,request_fingerprint,decision,resulting_job_id,decided_by)
   VALUES('mr-decision-'||s,t,v,'mr-brief-'||s,'mr-character-'||s,1,1,repeat('a',64),'mr-operation-'||s,repeat('b',64),'REVISE','mr-job-'||s,'fixture');
  INSERT INTO intake_source_agent_routing_policies(id,tenant_id,venue_id,agent_identity_id,created_by,updated_by,updated_at)
   VALUES(md5('routing-'||s)::uuid,t,v,'mr-agent-'||s,'fixture','fixture',stamp);
  INSERT INTO support_messages(id,tenant_id,venue_id,support_request_id,author_kind,author_id,body,visibility,request_version,client_version,submission_request_id,submission_input_hash,completion_outcome)
   VALUES('mr-completion-'||s,t,v,'mr-support-'||s,'OPERATOR','fixture','Synthetic no-change completion evidence','CLIENT_VISIBLE',1,2,md5('completion-'||s)::uuid,repeat('a',64),'NO_CHANGE');
  INSERT INTO intake_source_agent_dispatches(id,tenant_id,venue_id,extraction_dispatch_id,intake_run_id,receipt_id,extracted_text_hash,updated_at)
   VALUES(md5('source-dispatch-'||s)::uuid,t,v,'mr-processing-'||s,'mr-intake-'||s,md5('extraction-'||s)::uuid,encode(sha256(convert_to('Synthetic source','UTF8')),'hex'),stamp);
 END LOOP;
END $$;
COMMIT;
