"""Independent ZIP/XML workbook-to-immutable-package reconciliation; no DB writes."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import json
from pathlib import Path
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

EXPECTED_SHA = '1e2d5c29aae124a616e5c037e9e75cfc4f35026ec838dbd39914a3bd8aa1d8ff'
HEADERS = 'venue_name venue_type venue_subtype city state website general_email contact_name contact_title contact_email phone owner_name owner_size location_count venue_size short_description pathfinder_fit_score fit_reason primary_use_case location_aware employee_pathfinder_fit self_service_fit estimated_value_tier outreach_priority recommended_outreach_type personalization_hook demo_generation_fit research_confidence research_date source_urls notes'.split()
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workbook', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Receipts are exclusive-created; choose a new output')
    original = args.workbook.read_bytes()
    package_bytes = args.package.read_bytes()
    package = json.loads(package_bytes)
    failures, checks = [], 0

    def check(condition: bool, label: str) -> None:
        nonlocal checks
        checks += 1
        if not condition and len(failures) < 30:
            failures.append(label)

    check(sha(original) == EXPECTED_SHA == package['sourceWorkbook']['sha256'], 'source SHA-256')
    prospects = [r for r in package['records'] if r['kind'] == 'PROSPECT']
    indexed = {(r['raw']['_source']['sheetName'], r['raw']['_source']['originalRowNumber']): r for r in prospects}
    check(len(indexed) == len(prospects), 'unique physical source locators')
    contacts = defaultdict(list)
    for record in package['records']:
        if record['kind'] == 'CONTACT':
            contacts[record['parentExternalId']].append(record)
    rows, sheets, seen = [], [], set()
    with zipfile.ZipFile(args.workbook) as workbook:
        strings = []
        if 'xl/sharedStrings.xml' in workbook.namelist():
            strings = [''.join(t.text or '' for t in si.iter(NS + 't'))
                       for si in ET.fromstring(workbook.read('xl/sharedStrings.xml'))]
        relationships = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(workbook.read('xl/_rels/workbook.xml.rels'))}
        for sheet in ET.fromstring(workbook.read('xl/workbook.xml')).find(NS + 'sheets'):
            name = sheet.attrib['name']
            if name == '00 SUMMARY':
                continue
            sheets.append(name)
            target = relationships[sheet.attrib[REL]]
            entry = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
            for row in ET.fromstring(workbook.read(entry)).find(NS + 'sheetData'):
                row_number, cells = int(row.attrib['r']), {}
                for cell in row.findall(NS + 'c'):
                    column = 0
                    for letter in re.match(r'[A-Z]+', cell.attrib['r'])[0]:
                        column = column * 26 + ord(letter) - 64
                    value, kind = cell.findtext(NS + 'v', default=''), cell.attrib.get('t')
                    if kind == 's':
                        value = strings[int(value)]
                    elif kind == 'inlineStr':
                        value = ''.join(t.text or '' for t in cell.iter(NS + 't'))
                    cells[column - 1] = value
                    check(cell.find(NS + 'f') is None and kind != 'e', f'formula/error {name}:{cell.attrib["r"]}')
                values = [cells.get(i, '') for i in range(len(HEADERS))]
                if row_number == 1:
                    check(values == HEADERS, f'header {name}')
                    continue
                if not any(value.strip() for value in cells.values()):
                    continue
                key = (name, row_number)
                record = indexed.get(key)
                check(record is not None, f'missing source row {key}')
                if record is None:
                    continue
                seen.add(key)
                raw = record['raw']
                check(set(raw) == set(HEADERS + ['_source']), f'raw columns {key}')
                check([str(raw[h]) if raw[h] is not None else '' for h in HEADERS] == values, f'raw values {key}')
                original_raw = {k: raw[k] for k in sorted(raw) if k != '_source'}
                check(sha(json.dumps(original_raw, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) == raw['_source']['rawRowSha256'], f'raw-row hash {key}')
                source = dict(zip(HEADERS, values))
                source.update(sheet=name, row=row_number, externalId=record['externalId'])
                rows.append(source)
                child_records = contacts.get(record['externalId'], [])
                has_contact = any(source[k].strip() for k in ['general_email', 'contact_name', 'contact_title', 'contact_email', 'phone'])
                check(bool(child_records) == has_contact, f'contact presence {key}')
                expected_emails = {source[k].strip().lower() for k in ['general_email', 'contact_email'] if source[k].strip()}
                actual_emails = [r['normalized']['email'] for r in child_records if r['normalized'].get('email')]
                check(set(actual_emails) == expected_emails and len(actual_emails) == len(set(actual_emails)), f'email preservation/no duplicates {key}')
                if source['contact_name'].strip():
                    check(any(r['normalized'].get('fullName') == source['contact_name'].strip() for r in child_records), f'contact name {key}')
                if source['contact_title'].strip():
                    check(any(r['normalized'].get('title') == source['contact_title'].strip() for r in child_records), f'contact title {key}')
                general = source['general_email'].strip().lower()
                if general and general != source['contact_email'].strip().lower():
                    check(all(not r['normalized'].get('fullName') and not r['normalized'].get('title') for r in child_records if r['normalized'].get('email') == general), f'general inbox not assigned to a person {key}')
    check(seen == set(indexed), 'no package-only or lost workbook rows')
    check((len(sheets), len(rows)) == (85, 16725), 'canonical sheet and row totals')
    check(sum(bool(row['website'].strip()) for row in rows) == 14804, 'canonical direct website count')
    check(len(contacts) == 6183 and sum(map(len, contacts.values())) == 8212, 'contact-row and expanded-contact reconciliation')
    contact_fields = ['general_email', 'contact_name', 'contact_title', 'contact_email', 'phone']
    ref = lambda row: {k: row[k] for k in ['sheet', 'row', 'venue_name', 'externalId']}
    exceptions = {
        'missing_website': [ref(r) for r in rows if not r['website'].strip()],
        'missing_source_urls': [ref(r) for r in rows if not r['source_urls'].strip()],
        'missing_research_date': [ref(r) for r in rows if not r['research_date'].strip()],
        'owner_name_only_not_a_contact': [ref(r) for r in rows if r['owner_name'].strip() and not any(r[k].strip() for k in contact_fields)],
        'contact_without_source_urls': [ref(r) for r in rows if not r['source_urls'].strip() and any(r[k].strip() for k in contact_fields)],
        'contact_title_only': [ref(r) for r in rows if r['contact_title'].strip() and not any(r[k].strip() for k in contact_fields if k != 'contact_title')],
    }
    websites = Counter(row['website'] for row in rows if row['website'].strip())
    check(sha(args.workbook.read_bytes()) == EXPECTED_SHA, 'source unchanged after reconciliation')
    receipt = {
        'schema': 'torchiko.workbook-source-reconciliation/v1', 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'passed': not failures, 'checks': checks, 'failures': failures,
        'sourceSha256': EXPECTED_SHA, 'packageFileSha256': sha(package_bytes),
        'counts': {'sourceRows': len(rows), 'packageProspects': len(prospects), 'packageRecords': len(package['records']),
                   'acceptedRows': len(seen), 'rejectedRows': 0 if not failures else None, 'skippedRows': 0,
                   'territories': len(sheets), 'directWebsites': 14804, 'contactSourceRows': len(contacts),
                   'contactRecords': sum(map(len, contacts.values())), 'evidenceRecords': package['counts']['EVIDENCE'],
                   'sharedWebsiteGroups': sum(n > 1 for n in websites.values()),
                   'sharedWebsiteExtraRows': sum(n - 1 for n in websites.values() if n > 1)},
        'territoryRows': dict(sorted(Counter(r['sheet'] for r in rows).items())),
        'exceptionMeaning': 'Retained source unknowns/interpretation boundaries, not rejected or skipped prospects.',
        'exceptionCounts': {k: len(v) for k, v in exceptions.items()}, 'exceptions': exceptions,
        'historicalScoresRawOnly': sum(bool(r['pathfinder_fit_score'].strip()) for r in rows),
        'historicalFitReasonsRawOnly': sum(bool(r['fit_reason'].strip()) for r in rows),
        'nullSemantics': 'Blank/missing workbook cells compare as empty text; exact converter null values and row hashes remain in the immutable package.'}
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(receipt, output, ensure_ascii=False, indent=2)
    print(json.dumps({k: receipt[k] for k in ['passed', 'checks', 'failures', 'counts', 'exceptionCounts']}, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
