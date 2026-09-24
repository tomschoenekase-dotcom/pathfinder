"""Read-only full-row SHA-256 receipts for the retained local CRM only.

No row values, credentials, schema writes, migrations, or database mutations.
Identical full-table digests cover IDs, payloads, provenance, and timestamps.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess

CONTAINER = 'torchiko-crm-research-db-20260919'
DATABASE = 'pathfinder_disposable_crm_research_20260919'


def command(args: list[str], sql: str | None = None) -> str:
    result = subprocess.run(args, input=sql, capture_output=True, text=True,
                            encoding='utf-8', timeout=180, check=False)
    if result.returncode:
        raise RuntimeError(f'Local read-only snapshot failed: {result.stderr[:1000]}')
    return result.stdout.strip()


def query(sql: str) -> str:
    return command(['docker', 'exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on',
                    CONTAINER, 'psql', '-U', 'postgres', '-d', DATABASE, '--no-psqlrc',
                    '--set=ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--quiet'], sql)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--compare', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Snapshot receipts are immutable; choose a new output path')
    ports = json.loads(command(['docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', CONTAINER]))
    if ports.get('5432/tcp') != [{'HostIp': '127.0.0.1', 'HostPort': '58617'}]:
        raise RuntimeError('Retained loopback database identity changed')
    tables = query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND "
                   "(tablename LIKE 'prospect\\_%' ESCAPE '\\' OR tablename IN "
                   "('audit_logs','public_interest_prospect_conversions')) ORDER BY tablename;").splitlines()
    statements = ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
                  "SELECT json_build_object('database',current_database(),'readOnly',current_setting('transaction_read_only'));" ]
    for table in tables:
        if not table.replace('_', '').isalnum():
            raise RuntimeError('Unexpected table identifier')
        statements.append(
            f"SELECT json_build_object('table','{table}','rows',count(*),'sha256',"
            "encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to("
            "to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(t)->>'id'),''),'UTF8')),'hex')) "
            f'FROM "{table}" t;')
    statements.append('COMMIT;')
    records = [json.loads(line) for line in query('\n'.join(statements)).splitlines() if line.startswith('{')]
    identity, data = records[0], records[1:]
    if identity != {'database': DATABASE, 'readOnly': 'on'}:
        raise RuntimeError('Read-only database identity check failed')
    receipt = {'schema': 'torchiko.local-crm-full-row-snapshot/v1',
               'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
               'container': CONTAINER, 'identity': identity, 'tables': data}
    if args.compare:
        before = json.loads(args.compare.read_text(encoding='utf-8-sig'))
        receipt['comparedWith'] = str(args.compare.resolve())
        receipt['identical'] = before['identity'] == identity and before['tables'] == data
        previous = {row['table']: row for row in before['tables']}
        receipt['changedTables'] = [row['table'] for row in data if row != previous.get(row['table'])]
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(receipt, output, indent=2)
    print(json.dumps({'receipt': str(args.output.resolve()), 'tables': len(data),
                      'identity': identity, 'identical': receipt.get('identical'),
                      'changedTables': receipt.get('changedTables')}, indent=2))
    if receipt.get('identical') is False:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
