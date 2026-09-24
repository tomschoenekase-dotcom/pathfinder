"""Explicit local rehearsal of the ORIGINAL source/Gate/Composer/WLT owners.

Only a fixed pre-existing synthetic Composer package is admitted. No raw HTTP
facts, fixture paths, verified flags, or real-to-synthetic source conversion.
"""
import copy
import os
from pathlib import Path

PREFIX = 'SYN-CRM-FIRSTSEND-'

def prepare(native, payload, owners, bridge, base):
    require = bridge.require
    require(os.environ.get('TORCHIKO_LOCAL_CRM_REHEARSAL') == '1', 'SYNTHETIC_REHEARSAL_NOT_ENABLED')
    require(native['organization']['id'].startswith(PREFIX) and native['venue']['id'].startswith(PREFIX)
            and native['organization']['canonicalName'].startswith('SYNTHETIC '), 'SYNTHETIC_REHEARSAL_IDENTITIES_REQUIRED')
    require(len(native['contacts']) == 1 and native['contacts'][0]['id'].startswith(PREFIX)
            and native['contacts'][0]['normalizedEmail'] == 'fixture@example.invalid', 'EXACT_SYNTHETIC_CONTACT_REQUIRED')
    require(not native['importRecords'], 'REHEARSAL_MUST_NOT_BORROW_REAL_WORKBOOK_LINEAGE')
    # Use the correspondence owner's already installed synthetic source for both
    # cold and reply, so make_request retains its unchanged source/path checks.
    sources = owners['composer'].source_set(owners['correspondence'].SYNTHETIC_CONFIG)
    row, contact = owners['composer'].resolve('venue-synthetic-fixture', sources)
    require(native['venue']['name'] == row['raw']['venue_name'] == contact['venue'], 'SYNTHETIC_SOURCE_NAME_MISMATCH')
    pinned = {str(p): bridge.sha(p.read_bytes()) for p in (sources['pilot'], sources['contacts'])}
    claims = [s for s in native['sources'] if s['sourceType'] == 'CRM_SYNTHETIC_COMPONENT_FIXTURE_V1']
    require(len(claims) == 1, 'EXPLICIT_SYNTHETIC_SOURCE_RECORD_REQUIRED')
    record = claims[0]['capturedValue']
    require(record == {'synthetic': True, 'fixtureOwnerHashes': pinned, 'SEND_AUTHORIZED': False}, 'SYNTHETIC_SOURCE_PINS_CHANGED')
    rid = 'CRM-SYN-' + native['snapshotHash'][:24] + '-' + bridge.digest(payload.get('answerText'))[:8]
    q = owners['common'].read_json(owners['composer'].ROOT / 'examples/r003/synthetic-prepared/prep-fb11df29bdb12a7508a283ed/request.json')
    q.update(request_id=rid, language_evidence={}, purpose='Exercise isolated native preparation and versioned model-result storage with non-sales diagnostic text; not a venue message')
    q['supplied_facts'] = [
        {'claim_id': 'H-SCOPE', 'category': 'SALES HYPOTHESIS', 'text': 'Propose exploring a small guide for a few objects, using material the venue chooses. No delivery, result, price or visit is agreed.', 'source_ref': 'request:' + rid},
        {'claim_id': 'H-ASK', 'category': 'SALES HYPOTHESIS', 'text': 'Ask whether a brief conversation about this proposal would be useful. No agreement or meeting is established.', 'source_ref': 'request:' + rid},
        # Current owner requests non-sales QA. This is explicit task direction in
        # this isolated synthetic source, not a new venue fact or model assertion.
        {'claim_id': 'T-DIAGNOSTIC', 'category': 'TASK CONSTRAINT',
         'text': 'Write a synthetic CRM storage check, not venue outreach. Include the diagnostic marker caf\u00e9 \U0001f33f. State that no send or approval is requested. Make no venue, product, pricing, delivery, consent or visit claim.',
         'source_ref': 'request:' + rid},
    ]
    # A later explicitly requested fictional outreach rehearsal can exercise
    # editorial writing, not only the predecessor's storage diagnostic. Keep
    # the original fixture identities, source pins, no-send boundary and default
    # diagnostic unchanged. Direction is NOT a new product/venue fact.
    if not native['threads'] and payload.get('answerText') is not None:
        direction = payload['answerText']
        require(isinstance(direction, str) and 12 <= len(direction.strip()) <= 2000,
                'BOUNDED_SYNTHETIC_WRITING_DIRECTION_REQUIRED')
        q['purpose'] = direction
        q['supplied_facts'] = q['supplied_facts'][:2] + [{
            'claim_id': 'T-SYNTHETIC-DIRECTION', 'category': 'TASK CONSTRAINT',
            'text': direction, 'source_ref': 'request:' + rid,
        }]
    route = owners['composer'].resolve_route(q['routing'], row, contact)
    c = native['contacts'][0]
    base['crosswalk'] = {'nativeOrganizationId': native['organization']['id'], 'nativeVenueId': native['venue']['id'],
        'nativeContactId': c['id'], 'nativeEmailReadiness': c['emailReadiness'], 'nativePermissionState': c['permissionState'],
        'nativeEvidenceIds': [claims[0]['id']], 'componentProspectId': row['stable_identity'], 'componentPilotId': row['pilot_id'],
        'componentRoutingId': route['routing_id'], 'componentContactId': route['contact_id'], 'routing': route,
        'comparison': 'EXPLICIT_EXISTING_SYNTHETIC_SOURCE_FIXTURE_NOT_WORKBOOK_OR_REAL_VENUE',
        'synthetic': True, 'recipientSelectedByTom': False}
    gq = bridge.unknown_gate(native, owners)
    gq['request_id'] = rid
    gq['prospect'].update(id=row['stable_identity'], namespace='synthetic')
    gq['task'].update(purpose=q['purpose'], fit_hypothesis=q['supplied_facts'][0]['text'], route_value=route['recipient'])
    gq['relationship'].update(state='cold', thread_id=None)
    observed = str(contact['verified_general_route']['checked_date'])
    for fid, key, kind, value in (
        ('E-ID', 'venue.identity', 'identity', contact['venue']),
        ('E-SITE', 'venue.official_site', 'official_site', contact['official_website']),
        ('E-WEB', 'venue.understanding', 'venue_description', row['web_evidence']['observed_fact']),
        ('E-ROUTE', 'route.public', 'public_route', route['recipient']),
    ):
        source = {'source_id': 'SYN-REHEARSAL-' + fid, 'type': 'official_snapshot', 'quality': 'primary_summary',
                  'ref': 'SYNTHETIC_FIXTURE_ONLY:' + str(sources['contacts']), 'content_sha256': bridge.digest(pinned), 'hash_scope': 'local_record'}
        gq['facts'].append(owners['contracts'].fact(claim_id=fid, prospect_id=row['stable_identity'], fact_key=key,
            kind=kind, value=value, source=source, observed_at=observed, retrieved_at=observed))
    snapshot = None
    if native['threads']:
        snapshot = bridge.native_thread(native, route, row['stable_identity'], owners,
                                        payload.get('selectedThreadId'))
        base['crosswalk']['correspondenceMessageIds'] = {
            (m['id'] if m['id'].startswith('SYN-') else 'SYN-' + m['id']): m['id']
            for m in next(t for t in native['threads'] if t['id'] == snapshot['thread_id'])['messages']}
        snapshot['source_mode'] = 'synthetic'
        projection = owners['reducer'].reduce_thread(snapshot)
        base['correspondence'] = {'snapshot': snapshot, 'projection': projection, 'notice': 'SYNTHETIC fixture messages on a FAKE provider. No venue conversation or actual email send.'}
        gq = bridge.reply_gate(gq, snapshot, projection, owners)
        if not projection['ordinary_reply_preparation_allowed']:
            base['gate'] = owners['gate'].evaluate(gq)
            base['blocker'] = 'Synthetic correspondence owner holds preparation: ' + projection['reply_action']
            return None
    base['gate'] = owners['gate'].evaluate(gq)
    base['scope'] = 'SYNTHETIC_LOCAL_REHEARSAL_ONLY_NO_EXTERNAL_SEND'
    if not base['gate']['can_prepare'] or payload['action'] == 'evaluate': return None
    if snapshot:
        answer = payload.get('answerText')
        require(isinstance(answer, str) and 12 <= len(answer) <= 2000, 'HUMAN_RESPONSE_DIRECTION_REQUIRED: state a proposed answer to the synthetic live point')
        q['supplied_facts'] = [{'claim_id': 'H-RESPONSE', 'category': 'TASK CONSTRAINT', 'text': answer, 'source_ref': 'request:' + rid}]
        q['fact_ids'] = ['F-VENUE']; q['research_references'] = []; q['purpose'] = gq['task']['purpose']
        task = {'composer_request': q, 'answer_bindings': {p['point_id']: ['H-RESPONSE'] for p in base['correspondence']['projection']['live_points']}}
        q, _, _ = owners['correspondence'].make_request(snapshot, task)
    files, metadata = owners['composer'].assemble(q, sources)
    require(bridge.owners()['hashes'] == owners['hashes'], 'SYNTHETIC_COMPONENT_CHANGED')
    return q, files, metadata, snapshot, gq
