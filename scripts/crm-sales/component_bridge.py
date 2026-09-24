"""Read-only adapters to the ORIGINAL gate, Composer, WLT and correspondence owners.

JSON stdin/stdout, no shell, network, database, source writes or delivery. This is
an explicit identity crosswalk, not another implementation of those components.
The native caller owns persistence, freshness/CAS and human/operator review.
"""
from __future__ import annotations

import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import socket
import sys
from datetime import timedelta
from urllib.parse import quote

sys.dont_write_bytecode = True
VERSION = 'torchiko.native-sales-components/1'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def digest(value):
    return sha(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False))


def no_network(*_args, **_kwargs):
    raise RuntimeError('NO_SEND: network capability is absent from the component bridge')


def owners():
    vault = Path(os.environ['TORCHIKO_CRM_VAULT']).resolve(strict=True)
    staging = vault / '95 AI Staging'
    roots = {
        'gate': staging / 'Torchiko Research Gate 2026-09-20',
        'composer': staging / 'Torchiko Outreach Composer 2026-09-20',
        'correspondence': staging / 'Torchiko Correspondence Engine 2026-09-20',
    }
    for root in roots.values():
        require(root.resolve(strict=True).is_relative_to(vault), 'Component escaped configured vault')
        sys.path.insert(0, str(root / 'implementation'))
    gate = importlib.import_module('gate')
    fixtures = importlib.import_module('pilot_fixtures')
    composer = importlib.import_module('composer')
    contracts = importlib.import_module('contracts')
    correspondence = importlib.import_module('correspondence_composer')
    reducer = importlib.import_module('correspondence_reducer')
    common = importlib.import_module('common')
    validator = importlib.import_module('validator')
    # The Composer binds a pinned WLT runtime. Check the installed entrypoint as
    # well, so a moved personal skill cannot be silently represented as current.
    installed_wlt = vault / '.agents/skills/write-like-tom/SKILL.md'
    require(installed_wlt.resolve(strict=True).is_relative_to(vault),
            'INSTALLED_WLT_ENTRYPOINT_OUTSIDE_VAULT')
    installed_text = installed_wlt.read_text(encoding='utf-8-sig')
    match = re.search(r'Open this exact runtime skill before drafting:\s*`([^`]+)`', installed_text)
    require(match is not None and Path(match.group(1)).resolve(strict=True) ==
            (common.WLT / 'SKILL.md').resolve(strict=True), 'INSTALLED_WLT_RUNTIME_MISMATCH')
    hashes = {}
    for root in roots.values():
        for path in sorted((root / 'implementation').glob('*.py')):
            hashes[str(path.relative_to(vault)).replace('\\', '/')] = sha(path.read_bytes())
    hashes.update(common.dependency_hashes())
    hashes['installed-write-like-tom-entrypoint'] = sha(installed_wlt.read_bytes())
    hashes['research-gate-freshness-policy'] = sha((roots['gate'] / 'FRESHNESS-POLICY.json').read_bytes())
    hashes['pilot-source-records'] = sha((staging / 'Torchiko Sales Pilot 2026-09-20/SELECTED-PROSPECTS.json').read_bytes())
    hashes['verified-contact-source-records'] = sha((staging / 'Torchiko Sales Pilot 2026-09-20/contact-verification-r001/VERIFIED-CONTACTS.json').read_bytes())
    hashes['native-component-bridge'] = sha(Path(__file__).read_bytes())
    product = Path(__file__).resolve().parents[2]
    for relative in (
        'scripts/crm-sales/component_meaning.py',
        'scripts/crm-sales/component_native_evidence.py',
        'scripts/crm-sales/component_synthetic_preparation.py',
        'packages/db/src/helpers/prospect-source-admission.ts',
        'packages/db/src/helpers/prospect-sales-writer.ts',
        'packages/db/src/helpers/prospect-reply-projection.ts',
        'packages/db/src/helpers/prospect-native-origin.ts',
        'packages/db/src/helpers/prospect-native-handoff.ts',
        'packages/db/src/helpers/prospect-frozen-native-origin.ts',
        'packages/db/src/helpers/prospect-outreach-actions.ts',
        'packages/db/src/helpers/prospect-send-outbox-actions.ts',
        'packages/db/src/helpers/prospect-contactability-actions.ts',
        'packages/db/src/helpers/prospect-inbound-reply-actions.ts',
        'packages/db/src/helpers/prospect-inbound-reply-review-actions.ts',
        'packages/api/src/prospect-writer-contract.ts',
        'packages/api/src/prospect-first-send-contract.ts',
        'packages/api/src/prospect-first-send-workflow.ts',
        'packages/api/src/prospect-mailbox-reconciliation.ts',
        'packages/api/src/correspondence/gmail.ts',
        'packages/api/src/correspondence/gmail-http-client.ts',
        'packages/api/src/correspondence/fake.ts',
        'packages/api/src/correspondence/body-retention.ts',
        'packages/api/src/correspondence/reply-text.ts',
        'packages/api/src/correspondence/inbound-sync.ts',
        'packages/api/src/correspondence/prisma-inbound-store.ts',
        'apps/workers/src/processors/send-prospect-outreach.ts',
        'apps/workers/src/processors/send-email-queue.ts',
        'packages/config/src/local-crm-sales-components.ts',
        'packages/api/src/prospect-evidence-contract.ts',
        'packages/api/src/prospect-meaning-contract.ts',
        'packages/api/src/prospect-sales-contract.ts',
        'packages/api/src/prospect-sales-workflow.ts',
        'packages/api/src/prospect-sales-meaning-view.ts',
        'packages/api/src/prospect-sales-read-view.ts',
        'packages/api/src/routers/admin/prospect-crm-sales.ts',
        'packages/api/src/routers/admin/prospect-crm-outreach.ts',
        'apps/dashboard/app/dev-fixtures/prospect-research/sales/route.ts',
        'apps/dashboard/app/dev-fixtures/prospect-research/[prospectId]/page.tsx',
        'apps/dashboard/lib/local-prospect-sales-boundary.ts',
        'apps/dashboard/components/admin/ProspectEvidenceAdmission.tsx',
        'apps/dashboard/components/admin/ProspectClaimMeaningReview.tsx',
        'apps/dashboard/components/admin/ProspectWriterRoundtrip.tsx',
        'apps/dashboard/components/admin/ProspectOperationalHandoff.tsx',
        'apps/dashboard/components/admin/ProspectSalesReviewPanel.tsx',
        'packages/db/src/helpers/prospect-sales-actions.ts',
        'packages/db/src/helpers/prospect-sales-meaning.ts',
        'packages/db/src/helpers/prospect-sales-snapshot.ts',
    ):
        path = product / relative
        if path.exists():
            hashes['native:' + relative] = sha(path.read_bytes())
    # A library history/head change is relevant even with unchanged library code.
    for path in sorted((common.LANGUAGE / 'approved-language').rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            hashes[str(path.relative_to(vault)).replace('\\', '/')] = sha(path.read_bytes())
    for path in sorted((roots['composer'] / 'integration/correspondence-engine-v01/synthetic-reply-source').rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            hashes[str(path.relative_to(vault)).replace('\\', '/')] = sha(path.read_bytes())
    return locals()


def crosswalk(native, records):
    """Workbook + sheet/row + ALL source cells; never join merely by name/domain.

The pilot XML reader represented empty cells as '', the accepted XLSX adapter as
null. This one declared reversible comparison normalization is not a source edit.
Both original row hashes and both original identities are retained separately.
"""
    matches = []
    for source in native['importRecords']:
        if source['recordKind'] != 'PROSPECT':
            continue
        raw = source['rawPayload']
        locator = raw.get('_source', {})
        cells = {k: v for k, v in raw.items() if k != '_source'}
        for record in records.values():
            row = record['row']
            if not row or source['sourceWorkbookHash'] != row['source_workbook_sha256']:
                continue
            if locator.get('sheetName') != row['territory'] or locator.get('originalRowNumber') != row['source_row']:
                continue
            require(source['canonicalOrganizationId'] == native['organization']['id'] and
                    source['canonicalVenueId'] == native['venue']['id'], 'NATIVE_SOURCE_IDENTITY_CONFLICT')
            require(all(v is None or isinstance(v, str) for v in cells.values()), 'UNSUPPORTED_RAW_CELL_REPRESENTATION')
            normalized = {k: '' if v is None else v for k, v in cells.items()}
            require(normalized == row['raw'], 'SOURCE_ROW_CELL_CONFLICT: native/pilot original cells differ')
            require(digest(cells) == locator.get('rawRowSha256'), 'NATIVE_RAW_ROW_HASH_CONFLICT')
            require(native['venue']['name'] == row['raw']['venue_name'], 'NATIVE_VENUE_NAME_CHANGED_REVIEW_REQUIRED')
            evidence_ids = {s.get('canonicalEvidenceId') for s in native['importRecords']
                            if s.get('recordKind') == 'EVIDENCE' and
                            s.get('sourceWorkbookHash') == source['sourceWorkbookHash'] and
                            s.get('canonicalOrganizationId') == native['organization']['id'] and
                            s.get('canonicalVenueId') == native['venue']['id']}
            require(any(e['id'] in evidence_ids for e in native['sources']),
                    'NATIVE_SOURCE_EVIDENCE_CROSSWALK_MISSING')
            matches.append((record, {
                'nativeOrganizationId': native['organization']['id'],
                'nativeVenueId': native['venue']['id'],
                'nativeImportRecordId': source['id'],
                'nativeEvidenceIds': [e['id'] for e in native['sources']],
                'nativeExternalRecordId': source['externalRecordId'],
                'nativeRawRowSha256': locator['rawRowSha256'],
                'componentProspectId': row['stable_identity'],
                'componentPilotId': row['pilot_id'],
                'componentRowSha256': row['row_sha256'],
                'sourceWorkbookSha256': row['source_workbook_sha256'],
                'sourceLocator': row['source_locator'],
                'comparison': 'EXACT_ALL_CELLS_WITH_DECLARED_NULL_EMPTY_NORMALIZATION',
                'sourceMutation': False,
            }))
    require(len(matches) <= 1, 'AMBIGUOUS_NATIVE_COMPONENT_CROSSWALK')
    return matches[0] if matches else (None, None)


def unknown_gate(native, o):
    venue = native['venue']
    candidates = [c for c in native['contacts'] if c.get('normalizedEmail') and not c.get('archivedAt')]
    route = candidates[0]['normalizedEmail'] if len(candidates) == 1 else None
    return {
        'schema_version': o['contracts'].VERSION, 'request_id': 'CRM-' + native['snapshotHash'][:24],
        'as_of': native['asOf'],
        'prospect': {'id': venue['id'], 'namespace': 'canonical', 'name': venue['name'],
                     'location': ', '.join(v for v in [venue.get('city'), venue.get('region')] if v) or 'location unknown'},
        'task': {'mode': 'cold', 'purpose': 'Assess whether a bounded visitor-guide discussion can be prepared',
                 'readiness': 'review_only', 'route_kind': 'public_email', 'route_value': route,
                 'fit_hypothesis': 'Explore a small venue-controlled visitor guide; no promised result or deployment.'},
        'relationship': {'state': 'unknown' if native['threads'] else 'cold',
                         'source_ref': 'native:' + native['organization']['id'],
                         'checked_at': native['asOf'], 'thread_id': native['threads'][0]['id'] if native['threads'] else None},
        'safety': {'suppression': 'SUPPRESSED' if native['suppression']['blocked'] else 'NONE_KNOWN',
                   'source_ref': 'native:suppression:' + native['snapshotHash'], 'checked_at': native['asOf']},
        # Workbook assertions do not become primary website/routing evidence.
        'facts': [], 'intended_claims': [], 'source_heads': {}, 'attempts': [], 'research_usage': None,
    }


def business_freshness_review_due_at(gate_request, decision, o):
    """Freeze the original Gate's earliest selected-fact expiry for dispatch.

    Dispatch rereads current CRM identities/heads, while this deadline prevents
    unchanged database bytes from making time-limited evidence immortal. Voice
    corpus and reference revisions are writing provenance, not this deadline.
    """
    selected = set(decision['selected_claim_ids'])
    facts = {fact['claim_id']: fact for fact in gate_request['facts']}
    require(selected <= facts.keys(), 'GATE_SELECTED_FACT_MISSING')
    due = []
    for claim_id in selected:
        fact = facts[claim_id]
        kind = fact['kind']
        days = o['contracts'].KINDS[kind]['max_age_days']
        if days is not None:
            due.append(o['contracts'].when(fact['observed_at']) + timedelta(days=days))
        for value in (fact['valid_until'], fact['freshness']['expires_at']):
            if value:
                due.append(o['contracts'].when(value))
        if kind == 'announcement':
            due.append(o['contracts'].when(fact['published_at']) + timedelta(days=7))
    if gate_request['task']['readiness'] == 'current_message':
        for owner in ('relationship', 'safety'):
            due.append(o['contracts'].when(gate_request[owner]['checked_at']) + timedelta(days=1))
    return min(due).isoformat().replace('+00:00', 'Z') if due else None


def native_thread(native, route, component_id, o, selected_thread_id=None):
    if selected_thread_id is None:
        require(len(native['threads']) == 1, 'EXPLICIT_THREAD_SELECTION_REQUIRED')
        thread = native['threads'][0]
    else:
        require(isinstance(selected_thread_id, str) and 0 < len(selected_thread_id) <= 191,
                'INVALID_SELECTED_THREAD_ID')
        selected = [t for t in native['threads'] if t['id'] == selected_thread_id]
        require(len(selected) == 1, 'EXACT_SELECTED_THREAD_REQUIRED')
        thread = selected[0]
    require(len(thread['providerMappings']) == 1, 'EXACT_PROVIDER_THREAD_MAPPING_REQUIRED')
    mapping = thread['providerMappings'][0]
    account = mapping['providerAccount']
    synthetic = account['provider'] == 'FAKE'
    if synthetic:
        require(not account['deliveryEnabled'] and not account['capabilities']
                and account['connectionStatus'] in {'DISCONNECTED', 'DISABLED'},
                'ONLY_DISABLED_SYNTHETIC_PROVIDER_SUPPORTED')
        require(thread['id'].startswith('SYN-') and account['externalAccountId'].startswith('SYN-'),
                'SYNTHETIC_IDENTITIES_REQUIRED')
    else:
        require(account['provider'] == 'GMAIL' and account['connectionStatus'] == 'CONNECTED'
                and 'RECEIVE' in account['capabilities'] and
                account['externalAccountId'].casefold() == account['mailboxAddress'].casefold() and
                not thread['id'].startswith('SYN-') and not account['externalAccountId'].startswith('SYN-'),
                'CONNECTED_GMAIL_SOURCE_REQUIRED')
    require(route['kind'] == 'email', 'FORM_ROUTE_CANNOT_BECOME_EMAIL_REPLY')
    provider = {'name': 'synthetic' if synthetic else 'gmail',
                'account_id': account['id'], 'thread_id': mapping['providerThreadId']}
    owner = {'identity_id': account['id'], 'name': 'Tom', 'address': account['mailboxAddress']}
    recipient = {'identity_id': route['routing_id'], 'name': None, 'address': route['recipient']}
    messages = []
    def component_message_id(value):
        return value if not synthetic or value.startswith('SYN-') else 'SYN-' + value
    rfc_ids = {m['internetMessageId']: component_message_id(m['id'])
               for m in thread['messages'] if m.get('internetMessageId')}
    for message in thread['messages']:
        require(message['providerAccountId'] == account['id'], 'PROVIDER_MESSAGE_ACCOUNT_CONFLICT')
        require(message['organizationId'] == native['organization']['id'] and
                message['venueId'] == native['venue']['id'] and message['threadId'] == thread['id'],
                'PROVIDER_MESSAGE_SCOPE_CONFLICT')
        if synthetic:
            require((message.get('sourceReference') or '').startswith('synthetic:crm-sales:'),
                    'SYNTHETIC_SOURCE_DECLARATION_REQUIRED')
        else:
            expected_ref = ('https://mail.google.com/mail/u/' + quote(account['externalAccountId'], safe='') +
                            '/#all/' + quote(message['providerMessageId'], safe=''))
            require(message.get('sourceReference') == expected_ref, 'GMAIL_SOURCE_IDENTITY_CONFLICT')
            require(message.get('bodyRetentionState') == 'TEMPORARY' and
                    message.get('bodyExpiresAt') and
                    o['contracts'].when(message['bodyExpiresAt']) > o['contracts'].when(native['asOf']) and
                    not message.get('bodyRemovedAt'), 'GMAIL_BODY_UNAVAILABLE_OR_EXPIRED')
        require(message.get('textBody') and message.get('providerMessageId'), 'COMPLETE_MESSAGE_BODY_AND_ID_REQUIRED')
        inbound = message['direction'] == 'INBOUND'
        raw_text = message['textBody']
        derived = message.get('replyProjection')
        if derived is not None:
            require(derived.get('rawBodySha256') == sha(raw_text) and
                    derived.get('sourceReference') == message['sourceReference'] and
                    derived.get('scope') == 'CONSERVATIVE_DISPLAY_PROJECTION_NOT_RAW_SOURCE',
                    'RAW_REPLY_PROJECTION_BINDING_CONFLICT')
            message_text = derived.get('text')
        else:
            message_text = raw_text
        require(isinstance(message_text, str) and message_text.strip(), 'EMPTY_REPLY_PROJECTION')
        require(not o['reducer'].CHAIN.search(message_text),
                'UNRESOLVED_QUOTED_REPLY_SOURCE: inspect the retained raw/source owner')
        sender = recipient if inbound else owner
        require(message['fromAddress'] == sender['address'], 'NATIVE_MESSAGE_SENDER_CONFLICT')
        require(message['toAddresses'] == [owner['address'] if inbound else recipient['address']], 'MULTI_OR_CHANGED_RECIPIENT_HOLD')
        require(not message['ccAddresses'] and not message['bccAddresses'], 'COPIED_RECIPIENT_REVIEW_REQUIRED')
        messages.append({
            'message_id': component_message_id(message['id']), 'thread_id': thread['id'], 'prospect_id': component_id,
            'routing_id': route['routing_id'], 'provider': {**provider,
                'message_id': component_message_id(message['providerMessageId'])},
            'direction': message['direction'], 'timestamp': message['occurredAt'],
            'sender': sender, 'recipients': [owner if inbound else recipient], 'subject': message['subject'],
            'kind': 'HUMAN', 'content': {'text': message_text, 'sha256': sha(message_text),
                'source_ref': message['sourceReference'], 'complete': True, 'quotation_free': True},
            'reply_to_message_ids': [rfc_ids.get(ref, ref) for ref in message['references']],
            'delivery': {'state': message['status'], 'hard_bounce_for_routing_id': None,
                         'source_ref': message['sourceReference']},
        })
    ref = 'native:thread:' + thread['id']
    snapshot = {
        'schema_version': o['correspondence'].VERSION,
        'snapshot_id': ('SYN-snapshot-' if synthetic else 'crm-snapshot-') + digest(thread)[:24],
        'synthetic_correspondence': synthetic, 'source_mode': 'real', 'thread_id': thread['id'],
        'prospect_id': component_id, 'provider': provider, 'captured_at': thread['updatedAt'],
        'source_ref': ref, 'owner': owner,
        'routing': {'routing_id': route['routing_id'], 'contact_id': route['contact_id'], 'address': route['recipient'],
                    'verification': {'status': 'VERIFIED_SNAPSHOT', 'source_ref': 'component:' + route['source_id']}},
        'completeness': {'complete': thread['_count']['messages'] == len(messages),
                         'expected_message_count': thread['_count']['messages'], 'source_ref': ref},
        'messages': messages, 'suppression_events': [], 'SEND_AUTHORIZED': False,
    }
    if native['suppression']['blocked']:
        snapshot['suppression_events'].append({'event_id': 'native-hold-' + native['snapshotHash'][:24],
            'kind': 'venue_hold', 'scope': 'venue', 'target_id': component_id,
            'timestamp': thread['updatedAt'], 'source_ref': 'native:suppression:' + native['snapshotHash'],
            'message_id': None, 'reason': '; '.join(native['suppression']['reasons'])[:1000]})
    return snapshot


def reply_gate(gq, snapshot, projection, o):
    q = copy.deepcopy(gq)
    q['task'].update(mode='reply', route_kind='existing_thread', route_value=snapshot['routing']['address'],
                     purpose='Prepare a normal response to the exact latest inbound point')
    q['relationship'].update(state='existing', thread_id=snapshot['thread_id'], source_ref=snapshot['source_ref'],
                              checked_at=snapshot['captured_at'])
    q['intended_claims'] = []
    q['facts'] = [f for f in q['facts'] if f['binding'] is None]
    if not projection['latest_inbound']:
        return q
    latest = next(m for m in snapshot['messages'] if m['message_id'] == projection['latest_inbound']['message_id'])
    source = {'source_id': latest['message_id'], 'type': 'correspondence', 'ref': latest['content']['source_ref'],
              'content_sha256': latest['content']['sha256'], 'hash_scope': 'source_bytes', 'quality': 'owner_record'}
    binding = {'thread_id': snapshot['thread_id'], 'message_id': latest['message_id'], 'message_state': 'INCOMING',
               'body_sha256': latest['content']['sha256'], 'route_value': snapshot['routing']['address']}
    for cid, key, kind, value in (
        ('NATIVE-LATEST', 'thread.latest', 'latest_incoming', latest['content']['text']),
        ('NATIVE-ROUTE', 'route.thread', 'thread_route', snapshot['routing']['address']),
        ('NATIVE-HISTORY', 'relationship.latest', 'relationship_history', latest['content']['text']),
    ):
        q['facts'].append(o['contracts'].fact(claim_id=cid, prospect_id=q['prospect']['id'], fact_key=key,
            kind=kind, value=value, source=source, observed_at=latest['timestamp'],
            retrieved_at=snapshot['captured_at'], binding=binding))
    return q


def native_catalog_reply_request(snapshot, q, projection, answer):
    """Bind a canonical selected source to reducer-owned reply state.

    The historical Correspondence Composer resolves only pilot fixture rows;
    native_catalog remains the Composer's source/route owner for real CRM rows.
    """
    require(snapshot['routing']['address'] == q['routing']['value'] or
            snapshot['routing']['address'] == q['routing'].get('recipient'),
            'SELECTED_NATIVE_REPLY_ROUTE_CHANGED')
    latest = next(m for m in snapshot['messages']
                  if m['message_id'] == projection['reply_to_message_id'])
    prior = [m for m in snapshot['messages']
             if m['direction'] == 'OUTBOUND' and m['delivery']['state'] in {'SENT', 'DELIVERED'}]
    require(all(len(m['content']['text']) <= 2000 for m in prior[-3:]),
            'PRIOR_OUTBOUND_EXCEEDS_COMPOSER_BOUND')
    q.update(mode='reply', relationship_state='existing', language_purpose='reply',
             conversation_state={
                 'interested': 'interested', 'asked_question': 'information-requested',
                 'requested_more_information': 'information-requested',
                 'hesitant': 'hesitant', 'scheduling': 'scheduling',
             }.get(projection['relationship_state'], 'relationship-review'))
    q['thread_state'] = {
        'thread_id': snapshot['thread_id'], 'prospect_id': snapshot['prospect_id'],
        'routing_id': snapshot['routing']['routing_id'],
        'source_ref': snapshot['source_ref'] + '#snapshot-sha256=' + projection['snapshot_sha256'],
        'latest_message': {'message_id': latest['message_id'], 'direction': 'INCOMING',
                           'body': latest['content']['text'], 'sha256': latest['content']['sha256']},
        'prior_outbound': [{'message_id': m['message_id'], 'state': 'SENT',
                            'body': m['content']['text'], 'sha256': m['content']['sha256']}
                           for m in prior[-3:]],
        'questions': [{'question_id': point['point_id'], 'quote': point['quote'],
                       'answer_claim_ids': ['H-RESPONSE']}
                      for point in projection['live_points']],
    }
    return q


def run(payload):
    require(isinstance(payload, dict) and not set(payload) - {'action', 'native', 'answerText', 'selectedThreadId', 'draft', 'review', 'capture', 'admission'}, 'INVALID_BRIDGE_FIELDS')
    action = payload.get('action')
    require(action in {'catalog', 'evaluate', 'prepare', 'check', 'meaning', 'capture', 'admission'}, 'NO_SENDER_OR_UNKNOWN_ACTION')
    require(('review' in payload) == (action == 'meaning'), 'MEANING_ACTION_REQUIRED_FOR_REVIEW')
    require(('capture' in payload) == (action == 'capture'), 'CAPTURE_ACTION_REQUIRED')
    require(('admission' in payload) == (action == 'admission'), 'ADMISSION_ACTION_REQUIRED')
    o = owners()
    records = o['fixtures'].records()
    if action == 'catalog':
        return {'schema': VERSION, 'records': [
            {'pilotId': r['row']['pilot_id'], 'workbookHash': r['row']['source_workbook_sha256'],
             'sheet': r['row']['territory'], 'row': r['row']['source_row'], 'raw': r['row']['raw']}
            for r in records.values() if r['row']], 'SEND_AUTHORIZED': False}
    native = payload['native']
    record, mapping = crosswalk(native, records)
    base = {'schema': VERSION, 'nativeSnapshotHash': native['snapshotHash'], 'crosswalk': mapping,
            'componentCodeHashes': o['hashes'], 'SEND_AUTHORIZED': False, 'senderAvailable': False,
            'sourceMutation': False, 'correspondence': None, 'preparation': None, 'blocker': None,
            'scope': 'LOCAL_PREPARE_REVIEW_ONLY', 'contactCandidates': native['contacts']}
    snapshot = None
    if native['venue']['id'].startswith('SYN-CRM-FIRSTSEND-'):
        require(action not in {'capture', 'admission'}, 'Synthetic component source is fixed, not a website capture')
        from component_synthetic_preparation import prepare as synthetic_prepare
        result = synthetic_prepare(native, payload, o, sys.modules[__name__], base)
        if result is None: return base
        q, files, meta, snapshot, gq = result
    elif not record:
        from component_native_evidence import resolve, capture_check
        base['gate'] = o['gate'].evaluate(unknown_gate(native, o))
        if action == 'capture':
            base['captureCheck'] = capture_check(native, payload['capture'], o)
            require(owners()['hashes'] == o['hashes'], 'COMPONENT_CHANGED_DURING_CAPTURE_CHECK')
            return base
        info, admitted = resolve(native, o, payload.get('admission'))
        base['evidenceAdmission'] = info
        if admitted is None:
            base['blocker'] = 'No admitted native evidence. Inspect a retained official capture and select the exact task claims/route. No crawl was started.'
            return base
        base['gate'], base['crosswalk'] = admitted['gate'], admitted['mapping']
        gq = admitted['gateRequest']
        if native['threads']:
            selected_thread_id = payload.get('selectedThreadId')
            selected_threads = [t for t in native['threads'] if t['id'] == selected_thread_id] if selected_thread_id else native['threads']
            if len(selected_threads) != 1 or len(selected_threads[0].get('providerMappings', [])) != 1:
                base['blocker'] = 'EXPLICIT_THREAD_SELECTION_REQUIRED: exact provider mapping and retained body required'
                return base
            snapshot = native_thread(native, admitted['mapping']['routing'],
                                     admitted['mapping']['componentProspectId'], o, selected_thread_id)
            projection = o['reducer'].reduce_thread(snapshot)
            base['correspondence'] = {'snapshot': snapshot, 'projection': projection,
                                     'notice': 'Exact retained canonical correspondence; no send authority.'}
            gq = reply_gate(gq, snapshot, projection, o)
            base['gate'] = o['gate'].evaluate(gq)
            if not projection['ordinary_reply_preparation_allowed']:
                base['blocker'] = 'Correspondence owner holds preparation: ' + projection['reply_action']
                return base
        if not base['gate']['can_prepare']:
            base['blocker'] = 'Native evidence is missing, conflicted or stale for the selected task; original Research Gate holds preparation.'
        if action == 'admission':
            base['admissionCheck'] = {'selectionHash': digest(payload['admission']), 'SEND_AUTHORIZED': False}
            require(owners()['hashes'] == o['hashes'], 'COMPONENT_CHANGED_DURING_ADMISSION_CHECK')
        if not base['gate']['can_prepare'] or action in {'evaluate', 'admission'}:
            return base
        q = admitted['q']
        if snapshot:
            answer = payload.get('answerText')
            require(isinstance(answer, str) and 12 <= len(answer.strip()) <= 2000,
                    'HUMAN_RESPONSE_DIRECTION_REQUIRED: supply the intended answer to the exact live point')
            q['supplied_facts'] = [{'claim_id': 'H-RESPONSE', 'category': 'TASK CONSTRAINT',
                                  'text': answer, 'source_ref': 'request:' + q['request_id']}]
            q = native_catalog_reply_request(snapshot, q, projection, answer)
        files, meta = o['composer'].assemble(q, native_catalog=admitted['catalog'])
    else:
        require(action not in {'capture', 'admission'}, 'Pilot compatibility source owner is unchanged; native admission is for nonpilot prospects')
        row = record['row']
        q = o['common'].read_json(o['composer'].ROOT / 'examples/r003/requests' / (row['pilot_id'] + '.json'))
        q['request_id'] = 'CRM-' + native['snapshotHash'][:24] + '-' + digest(payload.get('answerText'))[:8]
        for fact in q['supplied_facts']:
            fact['source_ref'] = 'request:' + q['request_id']
        gq = o['fixtures'].make_request(row['pilot_id'], records)
        gq.update(as_of=native['asOf'], request_id=q['request_id'])
        gq['safety'] = {'suppression': 'SUPPRESSED' if native['suppression']['blocked'] else 'NONE_KNOWN',
                        'source_ref': 'native:suppression:' + native['snapshotHash'], 'checked_at': native['asOf']}
        resolved = o['composer'].resolve_route(q['routing'], row, record['contact'])
        matching = [c for c in native['contacts'] if c.get('normalizedEmail') and resolved['recipient'] and
                    c['normalizedEmail'].casefold() == resolved['recipient'].casefold() and not c.get('archivedAt')]
        require(len(matching) <= 1, 'AMBIGUOUS_NATIVE_ROUTING_CONTACT')
        mapping.update(nativeContactId=matching[0]['id'] if matching else None,
                       nativeEmailReadiness=matching[0]['emailReadiness'] if matching else 'UNKNOWN',
                       nativePermissionState=matching[0]['permissionState'] if matching else 'UNKNOWN',
                       componentRoutingId=resolved['routing_id'], componentContactId=resolved['contact_id'],
                       routing=resolved, recipientSelectedByTom=False)
        if native['threads']:
            snapshot = native_thread(native, resolved, row['stable_identity'], o, payload.get('selectedThreadId'))
            if snapshot['synthetic_correspondence']:
                mapping['correspondenceMessageIds'] = {
                    (m['id'] if m['id'].startswith('SYN-') else 'SYN-' + m['id']): m['id']
                    for m in next(t for t in native['threads'] if t['id'] == snapshot['thread_id'])['messages']}
            projection = o['reducer'].reduce_thread(snapshot)
            base['correspondence'] = {'snapshot': snapshot, 'projection': projection,
                                     'notice': 'SYNTHETIC correspondence. No venue sent these fixture messages.'}
            gq = reply_gate(gq, snapshot, projection, o)
            if not projection['ordinary_reply_preparation_allowed']:
                base['gate'] = o['gate'].evaluate(gq)
                base['blocker'] = 'Correspondence owner holds preparation: ' + projection['reply_action']
                return base
        base['gate'] = o['gate'].evaluate(gq)
        if not base['gate']['can_prepare'] or action == 'evaluate':
            return base
        if snapshot:
            answer = payload.get('answerText')
            require(isinstance(answer, str) and 12 <= len(answer.strip()) <= 2000,
                    'HUMAN_RESPONSE_DIRECTION_REQUIRED: supply the intended answer to the exact live point, not new research')
            q['supplied_facts'] = [{'claim_id': 'H-RESPONSE', 'category': 'TASK CONSTRAINT',
                                  'text': answer, 'source_ref': 'request:' + q['request_id']}]
            q['fact_ids'] = ['F-VENUE']
            q['research_references'] = []
            q['language_evidence'] = {}
            q['purpose'] = gq['task']['purpose']
            task = {'composer_request': q, 'answer_bindings': {p['point_id']: ['H-RESPONSE']
                    for p in base['correspondence']['projection']['live_points']}}
            q, projection, _ = o['correspondence'].make_request(snapshot, task)
            files, meta = o['composer'].assemble(q)
        else:
            adapter = importlib.import_module('composer_adapter')
            result, files = adapter.prepare_with_gate(gq, q)
            require(result['can_continue_to_writer'], result.get('blocker', 'COMPOSER_CONTRACT_HOLD'))
            meta = result['composer_metadata']
    context = json.loads(files['writer-context.json'])
    base['preparation'] = {
        'metadata': meta, 'request': q, 'writerContext': context,
        'businessFreshnessReviewDueAt': business_freshness_review_due_at(gq, base['gate'], o),
        'writerMarkdown': files['writer-context.md'].decode('utf-8'),
        'wltRequest': json.loads(files['wlt-request.json']), 'wltResult': json.loads(files['wlt-result.json']),
        'researchSnapshot': json.loads(files['research-snapshot.json']),
        'fileSha256s': {name: sha(content) for name, content in files.items()},
        'answerText': payload.get('answerText'), 'SEND_AUTHORIZED': False,
    }
    if action in {'check', 'meaning'}:
        draft = payload.get('draft')
        require(isinstance(draft, dict) and set(draft) == {'subject', 'body'}, 'EXACT_SUBJECT_BODY_REQUIRED')
        subject, body = draft['subject'], draft['body']
        require(isinstance(subject, str) and 1 <= len(subject.strip()) <= 160 and not re.search(r'[\r\n\x00]', subject), 'INVALID_SUBJECT')
        require(isinstance(body, str) and 1 <= len(body.strip()) <= 12000 and '\r' not in body and '\x00' not in body, 'INVALID_BODY')
        require(not o['reducer'].CHAIN.search(body) and not re.search(r'(?im)^\s*(?:Tom|Venue|Customer|Assistant|User|Subject):', body),
                'THREAD_OR_TRANSCRIPT_DUMP')
        if snapshot:
            for message in snapshot['messages']:
                old = message['content']['text']
                require(old.strip() not in body and not (o['validator'].ngrams(old) and
                    len(o['validator'].ngrams(old) & o['validator'].ngrams(body)) / len(o['validator'].ngrams(old)) >= .65),
                    'REPLY_MUST_NOT_COPY_THE_CHAIN')
        _, _, w, runtime = o['common'].dependencies()
        wq = copy.deepcopy(base['preparation']['wltRequest'])
        wq.pop('approved_language_context', None)
        wr = base['preparation']['wltResult']
        wcheck = w.check(wq, body, runtime, (wr['style_packet'], wr['style_receipt']))
        flags = [code for code, pattern in o['validator'].DENY.items() if re.search(pattern, subject + '\n' + body, re.I | re.S)]
        base['draftCheck'] = {'composerDraftSha256': sha(o['common'].draft_bytes(draft)),
            'bodySha256': sha(body), 'WLT_packet_identity': context['WLT_packet_identity'],
            'WLT_check': wcheck, 'claimRiskFlags': flags,
            'scope': 'NATIVE_INTEGRITY_AND_ORIGINAL_WLT_CHECK_NOT_FULL_COMPOSER_MEANING_VALIDATION',
            'claimAnnotations': 'NOT_SUPPLIED', 'meaningReview': 'REQUIRED', 'humanApproval': 'ABSENT',
            'SEND_AUTHORIZED': False}
        if action == 'meaning':
            from component_meaning import assess
            base['meaningCheck'] = assess(base, draft, payload['review'], o)
            base['draftCheck'].update(
                claimAnnotations='SUPPLIED_FOR_EXACT_NATIVE_REVISION',
                meaningReview=base['meaningCheck']['status'],
                scope=base['meaningCheck']['scope'])
        # Fail closed on files changed while assembling/checking this snapshot.
        require(owners()['hashes'] == o['hashes'], 'COMPONENT_CHANGED_DURING_ASSESSMENT')
    return base


def main():
    socket.socket = no_network
    socket.create_connection = no_network
    socket.getaddrinfo = no_network
    try:
        raw = sys.stdin.buffer.read(750001)
        require(len(raw) <= 750000, 'BRIDGE_INPUT_TOO_LARGE')
        result = run(json.loads(raw.decode('utf-8-sig')))
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8'))
    except Exception as exc:
        sys.stdout.write(json.dumps({'error': str(exc), 'SEND_AUTHORIZED': False, 'senderAvailable': False}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
