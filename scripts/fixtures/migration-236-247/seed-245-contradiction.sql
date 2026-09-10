-- A valid 245 state: migration 244 does not exclude an operational outcome.
BEGIN;
INSERT INTO operational_updates(id,tenant_id,venue_id,severity,title,body,expires_at,created_by,updated_at)
 VALUES('mr-contradiction','mr-t1','mr-v-a','WARNING','Synthetic contradiction','Preserve this evidence','2099-01-01','fixture',CURRENT_TIMESTAMP);
INSERT INTO knowledge_proposal_operational_update_handoffs(tenant_id,venue_id,proposal_id,operational_update_id,preview_hash,created_by)
 VALUES('mr-t1','mr-v-a',md5('duplicate-a')::uuid,'mr-contradiction',repeat('a',64),'fixture');
COMMIT;
