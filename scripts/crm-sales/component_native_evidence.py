"""Native evidence → original Research Gate → original Composer catalog seam.

No network/filesystem writes or semantic approval. Native captures/selections are
append-only source records, not replacement pilot files. All HTTP actions carry
existing IDs only; the trusted foreground capture writer is a separate entrypoint.
"""
from __future__ import annotations
import copy
import hashlib
import json
from native_catalog import validate_capture, stamp

CAPTURE_TYPE = 'CRM_NATIVE_SOURCE_CAPTURE_V1'
SELECTION_TYPE = 'CRM_NATIVE_SOURCE_SELECTION_V1'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def decode(record, require):
    stored = record['capturedValue']
    require(stored['schema'] == 'torchiko.native-component-storage/1' and stored['SEND_AUTHORIZED'] is False
            and hashlib.sha256(stored['componentJson'].encode()).hexdigest() == stored['componentSha256'],
            'NATIVE_EVIDENCE_BYTES_CHANGED')
    return json.loads(stored['componentJson'])


def lineage(native, require):
    rows = [s for s in native['importRecords'] if s['recordKind'] == 'PROSPECT']
    require(len(rows) == 1, 'Explicit unique native import lineage required; no name/domain joins')
    row = rows[0]
    cells = {k: v for k, v in row['rawPayload'].items() if k != '_source'}
    locator = row['rawPayload']['_source']
    require(row['canonicalVenueId'] == native['venue']['id'] and row['canonicalOrganizationId'] == native['organization']['id']
            and locator['rawRowSha256'] == digest(cells), 'NATIVE_IMPORT_LINEAGE_CONFLICT')
    return {'venueId': native['venue']['id'], 'organizationId': native['organization']['id'],
        'name': native['venue']['name'], 'city': native['venue']['city'], 'region': native['venue']['region'],
        'importRecordId': row['id'], 'importRecordHash': row['recordHash'], 'workbookHash': row['sourceWorkbookHash'],
        'rawRowHash': locator['rawRowSha256'], 'sourceLocator': f'{locator["sheetName"]}!row:{locator["originalRowNumber"]}'}


def capture_check(native, capture, o):
    require = o['common'].require
    validate_capture(capture)
    require(capture['identity'] == lineage(native, require), 'WRONG_NATIVE_VENUE_OR_IMPORT_LINEAGE')
    for page in capture['pages']:
        require(stamp(page['retrievedAt']) <= stamp(native['asOf']), 'FUTURE_CAPTURE_DATE')
    return {'captureId': 'native-capture_' + digest(capture)[:40], 'captureHash': digest(capture),
            'nativeSnapshotHash': native['snapshotHash'], 'SEND_AUTHORIZED': False}


def resolve(native, o, proposed=None):
    require = o['common'].require
    captures, selections = {}, []
    for source in native['sources']:
        if source.get('sourceType') == CAPTURE_TYPE:
            record = decode(source, require)
            capture = record['capture']
            checked = capture_check(native, capture, o)
            require(source['id'] == checked['captureId'] and source['venueId'] == native['venue']['id'], 'CAPTURE_NATIVE_OWNER_CONFLICT')
            captures[source['id']] = capture
        elif source.get('sourceType') == SELECTION_TYPE:
            record = decode(source, require)
            require(source['id'] == 'native-selection_' + digest(record)[:40], 'SELECTION_BYTES_CHANGED')
            selections.append((source, record))
    selections.sort(key=lambda item: (item[0]['createdAt'], item[0]['id']), reverse=True)
    selected = proposed if proposed is not None else (selections[0][1] if selections else None)
    info = {'selectionId': selections[0][0]['id'] if selections else None,
            'selection': selected, 'holds': [], 'captures': []}
    for cid, capture in captures.items():
        info['captures'].append({'id': cid, 'identity': capture['identity'], 'provenance': capture['provenance'],
            'pages': [{k: v for k, v in p.items() if k != 'rawGzipBase64'} for p in capture['pages']],
            'claims': capture['claims']})
    if selected is None:
        return info, None
    require(set(selected) == {'captureId', 'selection', 'previousSelectionId', 'SEND_AUTHORIZED'}
            and selected['SEND_AUTHORIZED'] is False, 'EXACT_NATIVE_SELECTION_REQUIRED')
    cid = selected['captureId']
    require(cid in captures, 'Selected capture is not owned by this native prospect')
    capture, task = captures[cid], selected['selection']
    require(set(task) == {'claimIds', 'routeClaimId', 'purpose', 'hypothesis'}, 'EXACT_NATIVE_TASK_SELECTION_REQUIRED')
    require(isinstance(task['claimIds'], list) and len(set(task['claimIds'])) == len(task['claimIds']) <= 8, 'Bounded unique claim selection required')
    o['common'].text(task['purpose'], 'task purpose', 500)
    o['common'].text(task['hypothesis'], 'task hypothesis', 1000)
    claims = {c['claimId']: c for c in capture['claims']}
    require(set(task['claimIds']) <= set(claims), 'Uncaptured claim cannot be admitted')
    rid = task['routeClaimId']
    require(rid is None or rid in claims and claims[rid]['kind'] == 'public_route', 'Captured route ID required')
    routeclaim = claims.get(rid)
    selected_id = 'native-selection_' + digest(selected)[:40]
    request_id = 'CRM-native-' + native['snapshotHash'][:24] + '-' + digest(task)[:8]
    source_id = lambda capture_id, c: capture_id + ':' + c['pageId']
    choice = {'kind': 'general', 'value': routeclaim['value'], 'source_id': source_id(cid, routeclaim)} if routeclaim else {'kind': 'unresolved'}
    q = {'request_id': request_id, 'prospect_id': native['venue']['id'], 'synthetic': False,
        'routing': choice, 'purpose': task['purpose'], 'mode': 'cold', 'relationship_state': 'cold',
        'conversation_state': 'first-outreach', 'venue_scale': 'unknown', 'venue_kind': 'unknown',
        'sender': {'name': 'Tom', 'organization': 'Torchiko'}, 'fact_ids': task['claimIds'],
        'supplied_facts': [{'claim_id': 'H-SCOPE', 'category': 'SALES HYPOTHESIS', 'text': task['hypothesis'], 'source_ref': 'request:' + request_id},
            {'claim_id': 'H-ASK', 'category': 'SALES HYPOTHESIS', 'text': 'Ask whether a brief conversation about the idea would be useful. No meeting, price or delivery is agreed.', 'source_ref': 'request:' + request_id}],
        'research_references': list(dict.fromkeys(source_id(cid, claims[x]) for x in task['claimIds'])),
        'language_purpose': 'pilot-proposition', 'language_evidence': {}, 'target_words': 85,
        'constraints': {'min_words': 40, 'max_words': 160, 'no_bullets': True, 'no_profanity': True, 'required_literals': []},
        'tone': {'formality': 'standard', 'polish': 'standard', 'warmth': 'neutral'}}
    catalog = {'capture': capture, 'captureId': cid, 'selection': task, 'selectionId': selected_id}
    # This is the original catalog seam's source/identity check, not a substitute
    # semantic validator. The same project() is called inside actual assemble().
    from native_catalog import project
    row, route, facts, _ = project(q, catalog)
    gq = {'schema_version': o['contracts'].VERSION, 'request_id': request_id, 'as_of': native['asOf'],
        'prospect': {'id': row['stable_identity'], 'namespace': 'canonical', 'name': native['venue']['name'],
                     'location': native['venue']['city'] + ', ' + native['venue']['region']},
        'task': {'mode': 'cold', 'purpose': task['purpose'], 'readiness': 'review_only',
                 'route_kind': 'public_form' if route['kind'] == 'contact_form' else 'public_email',
                 'route_value': routeclaim['value'] if routeclaim else None, 'fit_hypothesis': task['hypothesis']},
        'relationship': {'state': 'unknown' if native['threads'] else 'cold', 'source_ref': 'native:' + native['venue']['id'],
                         'checked_at': native['asOf'], 'thread_id': native['threads'][0]['id'] if native['threads'] else None},
        'safety': {'suppression': 'SUPPRESSED' if native['suppression']['blocked'] else 'NONE_KNOWN',
                   'source_ref': 'native:suppression:' + native['snapshotHash'], 'checked_at': native['asOf']},
        'facts': [], 'source_heads': {}, 'intended_claims': [], 'attempts': [], 'research_usage': None}
    used = set(task['claimIds']) | ({rid} if rid else set())
    used |= {c['claimId'] for c in capture['claims'] if c['kind'] in {'identity', 'official_site', 'venue_description', 'stable_mission', 'fit_basis'}}
    # Other captures cannot silently resolve a stale selected record, but active
    # contradictory values for used keys remain visible to the original Gate.
    used_keys = {(claims[x]['kind'], claims[x]['factKey']): claims[x]['value'] for x in used}
    for other_id, other in captures.items():
        pages = {p['id']: p for p in other['pages']}
        for c in other['claims']:
            key = (c['kind'], c['factKey'])
            if other_id == cid and c['claimId'] not in used:
                continue
            if other_id != cid and (key not in used_keys or c['value'] == used_keys[key]):
                continue
            if other_id != cid and c['kind'] == 'public_route' and routeclaim and c['routeKind'] != routeclaim['routeKind']:
                # A captured public form is an alternative to an email route,
                # not a contradictory assertion about the selected email.
                continue
            page = pages[c['pageId']]
            source = {'source_id': source_id(other_id, c), 'type': 'official_page', 'ref': page['url'],
                      'content_sha256': page['rawSha256'], 'hash_scope': 'source_bytes', 'quality': 'primary'}
            fact = o['contracts'].fact(claim_id='C-' + digest([other_id, c['claimId']])[:24], prospect_id=row['stable_identity'],
                fact_key=c['factKey'], kind=c['kind'], value=c['value'], source=source,
                observed_at=page['observedAt'], retrieved_at=page['retrievedAt'],
                valid_from=c['validFrom'], valid_until=c['validUntil'], published_at=c['publishedAt'],
                support_reference=f'{other_id}#/claims/{c["claimId"]}; normalized-text[{c["start"]}:{c["end"]}]')
            gq['facts'].append(fact)
    for claim_id in task['claimIds']:
        c = claims[claim_id]
        gq['intended_claims'].append({'need_id': 'USE-' + claim_id, 'fact_key': c['factKey'], 'kind': c['kind'],
            'claim': c['value'], 'use': 'body', 'expected_value': c['value']})
    decision = o['gate'].evaluate(gq)
    info['holds'] = [str(x) for x in decision.get('human_questions', [])]
    if not decision['can_prepare']:
        info['holds'] += [x['question'] for x in decision.get('research_plan', [])]
    mapping = {'nativeOrganizationId': native['organization']['id'], 'nativeVenueId': native['venue']['id'],
        'nativeImportRecordId': capture['identity']['importRecordId'], 'nativeCaptureId': cid,
        'nativeSelectionId': selected_id, 'componentProspectId': row['stable_identity'], 'componentPilotId': None,
        'sourceWorkbookSha256': capture['identity']['workbookHash'], 'sourceLocator': capture['identity']['sourceLocator'],
        'routing': route, 'nativeContactId': None, 'nativeEmailReadiness': 'UNKNOWN', 'nativePermissionState': 'UNKNOWN',
        'sourceMutation': False, 'recipientSelectedByTom': False}
    matches = [c for c in native['contacts'] if route['recipient'] and c.get('normalizedEmail') == route['recipient'].lower() and not c.get('archivedAt')]
    require(len(matches) <= 1, 'AMBIGUOUS_NATIVE_ROUTING_CONTACT')
    if matches:
        mapping.update(nativeContactId=matches[0]['id'], nativeEmailReadiness=matches[0]['emailReadiness'], nativePermissionState=matches[0]['permissionState'])
    return info, {'q': q, 'catalog': catalog, 'gateRequest': gq, 'gate': decision, 'mapping': mapping}
