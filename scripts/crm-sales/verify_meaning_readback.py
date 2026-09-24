"""Read-only retained CRM/source preservation and exact meaning-receipt checks.

Both the pre-sales baseline and this lane's initial snapshot are compared. The
existing explicitly synthetic thread advances last-message metadata when the
acceptance fixture appends inbound evidence; this is reported, never hidden as
an unchanged table. All pre-existing message/draft/review/source rows still hash.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--foundation-before', type=Path, required=True)
    parser.add_argument('--lane-before', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Create-only receipt required')
    root = Path(__file__).resolve().parents[2]
    if not args.output.resolve().is_relative_to(root / 'artifacts/crm-meaning-review-20260921-r001'):
        raise ValueError('Use this worktree meaning-review evidence root')
    spec = importlib.util.spec_from_file_location('foundation', root / 'scripts/capture-local-crm-snapshot.py')
    foundation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(foundation)
    before = {label: json.loads(path.read_text(encoding='utf-8-sig')) for label, path in (
        ('preSales', args.foundation_before), ('meaningLane', args.lane_before))}
    for value in before.values():
        assert value['container'] == foundation.CONTAINER
        assert value['identity'] == {'database': foundation.DATABASE, 'readOnly': 'on'}
    ports = json.loads(foundation.command(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', foundation.CONTAINER]))
    assert ports.get('5432/tcp') == [{'HostIp': '127.0.0.1', 'HostPort': '58617'}]
    created_tables = set(foundation.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='created_at'").splitlines())
    statements = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
        "SELECT json_build_object('kind','identity','database',current_database(),'readOnly',current_setting('transaction_read_only'));"]
    for label, value in before.items():
        cutoff = dt.datetime.fromisoformat(value['observedAt']).isoformat()
        assert re.fullmatch(r'[0-9T:+.\-]+', cutoff)
        for row in value['tables']:
            table = row['table']
            assert re.fullmatch(r'[a-z_]+', table)
            scope = f"created_at <= '{cutoff}'::timestamptz" if table in created_tables else (
                "id NOT LIKE 'SYN-%'" if label == 'preSales' and table == 'prospect_email_thread_providers' else 'TRUE')
            statements.append(
                f"SELECT json_build_object('kind','originalRows','baseline','{label}','table','{table}','rows',count(*),'sha256',"
                "encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to("
                "to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)->>'id'),''),'UTF8')),'hex')) "
                f'FROM "{table}" t WHERE {scope};')
    for table in [row['table'] for row in before['meaningLane']['tables']]:
        statements.append(f"SELECT json_build_object('kind','total','table','{table}','rows',count(*)) FROM \"{table}\";")
    cutoff = before['meaningLane']['observedAt']
    assert re.fullmatch(r'[0-9T:+.\-]+', cutoff)
    statements += [
        "SELECT json_build_object('kind','providers','rows',count(*),'enabled',count(*) FILTER (WHERE delivery_enabled),'notExplicitSynthetic',count(*) FILTER (WHERE provider <> 'FAKE' OR connection_status <> 'DISABLED' OR cardinality(capabilities) <> 0 OR credential_reference_id IS NOT NULL OR sync_cursor IS NOT NULL OR id NOT LIKE 'SYN-%')) FROM correspondence_provider_accounts;",
        "SELECT json_build_object('kind','drafts','rows',count(*),'unsafe',count(*) FILTER (WHERE preparation_key IS NULL OR campaign_id IS NOT NULL OR member_id IS NOT NULL OR approved_at IS NOT NULL OR approved_by IS NOT NULL OR status <> 'NEEDS_REVIEW' OR grounding_snapshot->>'SEND_AUTHORIZED' IS DISTINCT FROM 'false'),'forms',count(*) FILTER (WHERE to_email IS NULL)) FROM prospect_outreach_drafts;",
        f"SELECT json_build_object('kind','newDraftActors','rows',count(*),'notExplicitSystem',count(*) FILTER (WHERE generated_by_type <> 'SYSTEM' OR generated_by_id NOT LIKE 'synthetic:crm-meaning:%')) FROM prospect_outreach_drafts WHERE created_at > '{cutoff}'::timestamptz;",
        "SELECT json_build_object('kind','contacts','originalUnknown',count(*) FILTER (WHERE id NOT LIKE 'SYN-%' AND email_readiness='UNKNOWN' AND permission_state='UNKNOWN'),'synthetic',count(*) FILTER (WHERE id LIKE 'SYN-%')) FROM prospect_contacts;",
        "SELECT json_build_object('kind','messages','rows',count(*),'notExplicitSynthetic',count(*) FILTER (WHERE source_reference NOT LIKE 'synthetic:crm-sales:%' OR source_reference IS NULL OR id NOT LIKE 'SYN-%')) FROM prospect_email_messages;",
        "SELECT json_build_object('kind','meaning','id',a.id,'evidence',a.evidence,'nativeDraftExists',d.id IS NOT NULL,'nativeContentHash',d.content_hash,'nativeSubject',d.subject,'nativeBody',d.text_body,'nativePreparationId',d.grounding_snapshot->>'preparationId') FROM prospect_activities a LEFT JOIN prospect_outreach_drafts d ON d.id=a.evidence->>'draftId' WHERE a.evidence->>'schema'='torchiko.native-sales-review/1' AND a.evidence->>'reviewScope'='CLAIM_MEANING_ASSESSMENT_NOT_APPROVAL' ORDER BY a.created_at,a.id;",
        "SELECT json_build_object('kind','sourceCounts','prospects',count(*) FILTER (WHERE record_kind='PROSPECT'),'evidence',count(*) FILTER (WHERE record_kind='EVIDENCE')) FROM prospect_import_source_records;",
        'COMMIT;',
    ]
    records = [json.loads(line) for line in foundation.query('\n'.join(statements)).splitlines() if line.startswith('{')]
    identity = next(row for row in records if row['kind'] == 'identity')
    assert identity['readOnly'] == 'on' and identity['database'] == foundation.DATABASE
    comparisons = {}
    for label, value in before.items():
        current = {row['table']: row for row in records if row['kind'] == 'originalRows' and row['baseline'] == label}
        comparisons[label] = [
            {**row, 'expectedRows': old['rows'], 'expectedSha256': old['sha256'],
             'identical': row['rows'] == old['rows'] and row['sha256'] == old['sha256']}
            for old in value['tables'] for row in [current[old['table']]]]
    totals = {row['table']: row['rows'] for row in records if row['kind'] == 'total'}
    zero_tables = ['prospect_campaign_members', 'prospect_outreach_campaigns', 'prospect_send_batches',
        'prospect_send_items', 'prospect_send_outbox', 'prospect_followups', 'prospect_email_events',
        'prospect_email_webhook_receipts', 'prospect_research_jobs', 'prospect_research_attempts', 'prospect_inbound_reply_reviews']
    checks = []
    def check(condition, label):
        checks.append({'label': label, 'passed': bool(condition)})
    check(len(comparisons['preSales']) == 42 and all(row['identical'] for row in comparisons['preSales']),
          'All 42 original pre-sales table projections retain exact full-row hashes and counts')
    lane_changes = [row for row in comparisons['meaningLane'] if not row['identical']]
    check([row['table'] for row in lane_changes] == ['prospect_email_threads'] and
          lane_changes[0]['rows'] == lane_changes[0]['expectedRows'] == 1,
          'Only the existing synthetic thread metadata changed; all other pre-lane row projections across 41 tables are byte-identical')
    for table in zero_tables:
        check(totals[table] == 0, f'{table} remains zero')
    providers = next(row for row in records if row['kind'] == 'providers')
    check(providers == {'kind': 'providers', 'rows': 1, 'enabled': 0, 'notExplicitSynthetic': 0},
          'Exactly one disabled synthetic FAKE account, without credentials/capabilities or delivery')
    drafts = next(row for row in records if row['kind'] == 'drafts')
    actors = next(row for row in records if row['kind'] == 'newDraftActors')
    contacts = next(row for row in records if row['kind'] == 'contacts')
    messages = next(row for row in records if row['kind'] == 'messages')
    check(drafts['unsafe'] == 0 and drafts['forms'] >= 1, 'All retained drafts remain immutable unapproved non-campaign NO-SEND; a form URL does not become an email')
    check(actors['rows'] > 0 and actors['notExplicitSystem'] == 0, 'Every new native draft records an explicit synthetic SYSTEM actor, not a fabricated human')
    check(contacts['originalUnknown'] == 8212 and contacts['synthetic'] == 1, 'All 8,212 original contact candidates remain UNKNOWN/UNKNOWN with one retained synthetic hold contact')
    check(messages['rows'] >= 3 and messages['notExplicitSynthetic'] == 0, 'Only explicitly synthetic fixture messages exist; changed inbound acceptance appended rather than reset history')
    meanings = []
    for row in (row for row in records if row['kind'] == 'meaning'):
        evidence = row['evidence']; envelope = evidence['record']
        exact = hashlib.sha256(envelope['componentJson'].encode('utf-8')).hexdigest() == envelope['componentSha256']
        record = json.loads(envelope['componentJson'])
        binding, submission, assessment = record['binding'], record['submission'], record['check']
        draft_bytes = ('Subject: ' + row['nativeSubject'] + '\n\n' + row['nativeBody'] + '\n').encode('utf-8')
        identities = row['nativeDraftExists'] and all((
            evidence['contentHash'] == row['nativeContentHash'] == binding['contentHash'] == assessment['contentHash'],
            binding['draftId'] == evidence['draftId'] == submission['draftId'] == assessment['draftId'],
            binding['subject'] == row['nativeSubject'], binding['body'] == row['nativeBody'],
            binding['preparationId'] == row['nativePreparationId'] == submission['preparationId'] == assessment['preparationId'],
            evidence['bindingHash'] == submission['bindingHash'] == assessment['bindingHash'],
            hashlib.sha256(draft_bytes).hexdigest() == assessment['composerDraftSha256'],
            submission['annotations'] == assessment['annotations'], submission['reviewer'] == assessment['reviewer'],
        ))
        safe = all(value.get('SEND_AUTHORIZED') is False for value in (evidence, envelope, record, binding, assessment))
        safe = (safe and evidence['semanticCertification'] is False and assessment['semanticCertification'] is False and
                evidence['humanApproval'] == assessment['humanApproval'] == 'ABSENT')
        synthetic = evidence['recordedBy']['type'] == 'SYSTEM' and evidence['recordedBy']['synthetic'] is True and evidence['recordedBy']['id'].startswith('synthetic:crm-meaning:')
        holds = assessment['status'] != 'ASSESSED_NO_SEND' or not (assessment['findings'] or assessment['unresolvedHolds'])
        check(exact and identities and safe and synthetic and holds, f"{row['id']}: exact native revision/source receipt, attributed synthetic review, consistent holds and NO SEND")
        meanings.append({'id': row['id'], 'draftId': evidence['draftId'], 'bindingHash': evidence['bindingHash'],
            'componentSha256': envelope['componentSha256'], 'status': assessment['status'],
            'reviewer': assessment['reviewer'], 'recordedBy': evidence['recordedBy'],
            'exactBytesVerified': exact, 'exactNativeIdentityVerified': identities, 'noSendVerified': safe,
            'findings': len(assessment['findings']), 'sourceEvidenceEntries': len(assessment['claimEvidence'])})
    check(bool(meanings) and {'BLOCKED', 'ASSESSED_NO_SEND'} <= {row['status'] for row in meanings},
          'Both failed findings and completed attributed assessments are retained as separate immutable history')
    receipt = {'schema': 'torchiko.native-meaning-preservation/1', 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'database': foundation.DATABASE, 'container': foundation.CONTAINER, 'readOnly': True,
        'baselines': {label: value['observedAt'] for label, value in before.items()}, 'comparisons': comparisons,
        'expectedMutableException': 'Existing SYN-crm-sales-20260921-thread latest-message metadata advances when explicit synthetic inbound evidence is appended. No original real-prospect source/contact/import rows are changed.',
        'totalRows': totals, 'providers': providers, 'drafts': drafts, 'newDraftActors': actors,
        'contacts': contacts, 'messages': messages, 'meaningReceipts': meanings, 'checks': checks,
        'passed': all(row['passed'] for row in checks), 'SEND_AUTHORIZED': False, 'workbookReimported': False}
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(receipt, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'output': str(args.output), 'passed': receipt['passed'], 'checks': len(checks),
        'failed': [row for row in checks if not row['passed']], 'preSalesIdentical': sum(row['identical'] for row in comparisons['preSales']),
        'laneIdentical': sum(row['identical'] for row in comparisons['meaningLane']), 'meaningReceipts': len(meanings), 'messages': messages}))
    if not receipt['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
