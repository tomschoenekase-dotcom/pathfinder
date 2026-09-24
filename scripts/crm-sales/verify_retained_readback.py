"""Verify integration additions and unchanged pre-existing rows. Never imports data.

Reuses the foundation's read-only full-row digest algorithm, not its importer or
import acceptance. The before receipt predates this integration's first DB write.
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
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Readback receipts are immutable; choose a new output path')
    spec = importlib.util.spec_from_file_location('foundation_snapshot', Path(__file__).parents[1] / 'capture-local-crm-snapshot.py')
    foundation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(foundation)
    before = json.loads(args.before.read_text(encoding='utf-8-sig'))
    cutoff = dt.datetime.fromisoformat(before['observedAt']).isoformat()
    assert re.fullmatch(r'[0-9T:+.\-]+', cutoff)
    assert before['container'] == foundation.CONTAINER
    ports = json.loads(foundation.command(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', foundation.CONTAINER]))
    assert ports.get('5432/tcp') == [{'HostIp': '127.0.0.1', 'HostPort': '58617'}]
    created_tables = set(foundation.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='created_at'").splitlines())
    filters = {
        'prospect_email_thread_providers': "id NOT LIKE 'SYN-%'",
    }
    sql = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
           "SELECT json_build_object('kind','identity','database',current_database(),'readOnly',current_setting('transaction_read_only'));"]
    for previous in before['tables']:
        table = previous['table']
        assert re.fullmatch(r'[a-z_]+', table)
        scope = f"created_at <= '{cutoff}'::timestamptz" if table in created_tables else filters.get(table, 'TRUE')
        # Compare all original columns, IDs and timestamps. New schema columns
        # affect only the formerly empty draft table, whose digest remains empty.
        sql.append(
            f"SELECT json_build_object('kind','original_rows','table','{table}','rows',count(*),'sha256',"
            "encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to("
            "to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)->>'id'),''),'UTF8')),'hex')) "
            f'FROM "{table}" t WHERE {scope};')
        sql.append(f"SELECT json_build_object('kind','total','table','{table}','rows',count(*)) FROM \"{table}\";")
    sql += [
        "SELECT json_build_object('kind','providers','rows',count(*),'enabled',count(*) FILTER (WHERE delivery_enabled),"
        "'notExplicitSynthetic',count(*) FILTER (WHERE provider <> 'FAKE' OR connection_status <> 'DISABLED' OR cardinality(capabilities) <> 0 OR credential_reference_id IS NOT NULL OR sync_cursor IS NOT NULL OR id NOT LIKE 'SYN-%')) FROM correspondence_provider_accounts;",
        "SELECT json_build_object('kind','drafts','rows',count(*),'unsafe',count(*) FILTER (WHERE preparation_key IS NULL OR campaign_id IS NOT NULL OR member_id IS NOT NULL OR approved_at IS NOT NULL OR approved_by IS NOT NULL OR status <> 'NEEDS_REVIEW' OR grounding_snapshot->>'SEND_AUTHORIZED' IS DISTINCT FROM 'false'),"
        "'forms',count(*) FILTER (WHERE to_email IS NULL)) FROM prospect_outreach_drafts;",
        "SELECT json_build_object('kind','contacts','originalUnknown',count(*) FILTER (WHERE id NOT LIKE 'SYN-%' AND email_readiness='UNKNOWN' AND permission_state='UNKNOWN'),"
        "'synthetic',count(*) FILTER (WHERE id LIKE 'SYN-%')) FROM prospect_contacts;",
        "SELECT json_build_object('kind','messages','rows',count(*),'notExplicitSynthetic',count(*) FILTER (WHERE source_reference NOT LIKE 'synthetic:crm-sales:%' OR source_reference IS NULL OR id NOT LIKE 'SYN-%')) FROM prospect_email_messages;",
        "SELECT json_build_object('kind','preparation','id',id,'storage',captured_value->>'schema','componentJson',captured_value->>'componentJson','componentSha256',captured_value->>'componentSha256') FROM prospect_source_evidence WHERE source_type='CRM_SALES_PREPARATION_V1' ORDER BY id;",
        "SELECT json_build_object('kind','sourceCounts','prospects',count(*) FILTER (WHERE record_kind='PROSPECT'),'evidence',count(*) FILTER (WHERE record_kind='EVIDENCE')) FROM prospect_import_source_records;",
        'COMMIT;',
    ]
    records = [json.loads(line) for line in foundation.query('\n'.join(sql)).splitlines() if line.startswith('{')]
    identity = next(row for row in records if row['kind'] == 'identity')
    assert identity['readOnly'] == 'on' and identity['database'] == foundation.DATABASE
    originals = {row['table']: {k: v for k, v in row.items() if k != 'kind'} for row in records if row['kind'] == 'original_rows'}
    comparisons = [{**originals[row['table']], 'expectedRows': row['rows'], 'expectedSha256': row['sha256'],
                    'identical': originals[row['table']] == row} for row in before['tables']]
    totals = {row['table']: row['rows'] for row in records if row['kind'] == 'total'}
    zero_tables = ['prospect_campaign_members', 'prospect_outreach_campaigns', 'prospect_send_batches',
                   'prospect_send_items', 'prospect_send_outbox', 'prospect_followups',
                   'prospect_email_events', 'prospect_email_webhook_receipts', 'prospect_research_jobs',
                   'prospect_research_attempts', 'prospect_inbound_reply_reviews']
    checks = [{'label': 'Every pre-existing row retains exact full-row hash and count across all 42 tables',
               'passed': len(comparisons) == 42 and all(row['identical'] for row in comparisons)}]
    checks += [{'label': f'{table} remains zero', 'passed': totals[table] == 0} for table in zero_tables]
    providers = next(row for row in records if row['kind'] == 'providers')
    drafts = next(row for row in records if row['kind'] == 'drafts')
    contacts = next(row for row in records if row['kind'] == 'contacts')
    messages = next(row for row in records if row['kind'] == 'messages')
    checks += [
        {'label': 'Exactly one explicitly synthetic disabled FAKE provider; no credentials/capabilities/delivery', 'passed': providers == {'kind': 'providers', 'rows': 1, 'enabled': 0, 'notExplicitSynthetic': 0}},
        {'label': 'Every retained draft revision is non-campaign, unapproved, immutable NO-SEND', 'passed': drafts['unsafe'] == 0 and drafts['rows'] > 0 and drafts['forms'] >= 1},
        {'label': 'All 8,212 original contact candidates remain UNKNOWN/UNKNOWN', 'passed': contacts['originalUnknown'] == 8212 and contacts['synthetic'] == 1},
        {'label': 'Only the two explicitly synthetic native fixture messages exist', 'passed': messages['rows'] == 2 and messages['notExplicitSynthetic'] == 0},
    ]
    preparation_evidence = []
    for row in (row for row in records if row['kind'] == 'preparation'):
        valid_storage = row['storage'] == 'torchiko.native-component-storage/1'
        item = {'id': row['id'], 'storage': row['storage'], 'retainedLegacyUnusable': not valid_storage}
        if valid_storage:
            computed = hashlib.sha256(row['componentJson'].encode('utf-8')).hexdigest()
            component = json.loads(row['componentJson'])
            prep = component['preparation']
            language = prep['writerContext']['approved_language_snapshot']
            item.update(exactBytesVerified=computed == row['componentSha256'], componentSha256=computed,
                        approvedCount=language['current_approved_count'], selectedCount=len(language['selected_entries']),
                        WLT_packet_identity=prep['writerContext']['WLT_packet_identity'],
                        nativeSnapshotHash=component['nativeSnapshotHash'], componentCodeHashes=component['componentCodeHashes'])
            checks.append({'label': f"{row['id']}: exact stored component bytes, real WLT, zero approved phrases and SEND false",
                           'passed': computed == row['componentSha256'] and bool(item['WLT_packet_identity']) and item['approvedCount'] == 0
                           and item['selectedCount'] == 0 and component['SEND_AUTHORIZED'] is False and component['senderAvailable'] is False})
        preparation_evidence.append(item)
    receipt = {'schema': 'torchiko.retained-native-sales-readback/1', 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
               'database': foundation.DATABASE, 'container': foundation.CONTAINER, 'readOnly': True,
               'beforeReceipt': str(args.before), 'originalRowCutoff': cutoff, 'originalRows': comparisons,
               'totalRows': totals, 'providers': providers, 'drafts': drafts, 'contacts': contacts, 'messages': messages,
               'preparations': preparation_evidence, 'checks': checks, 'passed': all(item['passed'] for item in checks),
               'workbookReimported': False, 'SEND_AUTHORIZED': False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(receipt, output, ensure_ascii=False, indent=2)
    print(json.dumps({'output': str(args.output.resolve()), 'passed': receipt['passed'], 'checks': len(checks),
                      'failed': [row for row in checks if not row['passed']], 'drafts': drafts, 'providers': providers,
                      'unchangedOriginalTables': sum(row['identical'] for row in comparisons), 'preparations': len(preparation_evidence)}))
    if not receipt['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
