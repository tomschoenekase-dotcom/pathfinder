"""Focused offline adapter tests against the unchanged installed component owners."""
import copy
import os
import socket
import unittest
from pathlib import Path
from urllib.parse import quote

os.environ.setdefault('TORCHIKO_CRM_VAULT', str(Path.home() / 'Downloads/AwesomeVault'))
import component_bridge as b


def native_fixture(pilot='P02'):
    record = b.owners()['fixtures'].records()[pilot]
    row = record['row']
    raw = {k: None if v == '' else v for k, v in row['raw'].items()}
    raw['_source'] = {'sheetName': row['territory'], 'originalRowNumber': row['source_row'], 'rawRowSha256': b.digest(raw)}
    source = {'id': 'native-import-1', 'recordKind': 'PROSPECT', 'sourceWorkbookHash': row['source_workbook_sha256'],
              'externalRecordId': 'native-source-1', 'rawPayload': raw,
              'canonicalOrganizationId': 'native-org-1', 'canonicalVenueId': 'native-venue-1', 'canonicalEvidenceId': None}
    cq = b.owners()['common'].read_json(b.owners()['composer'].ROOT / 'examples/r003/requests' / (pilot + '.json'))
    route = b.owners()['composer'].resolve_route(cq['routing'], row, record['contact'])
    contact = {'id': 'native-contact-1', 'normalizedEmail': route['recipient'], 'email': route['recipient'],
               'emailReadiness': 'UNKNOWN', 'permissionState': 'UNKNOWN', 'archivedAt': None,
               'doNotContact': False, 'suppressedAt': None, 'unsubscribedAt': None}
    return {'organization': {'id': 'native-org-1'}, 'venue': {'id': 'native-venue-1', 'name': row['raw']['venue_name'],
             'city': row['raw']['city'], 'region': row['raw']['state']}, 'contacts': [contact],
            'sources': [{'id': 'native-evidence-1'}], 'importRecords': [source, {
                'recordKind': 'EVIDENCE', 'canonicalEvidenceId': 'native-evidence-1',
                'canonicalOrganizationId': 'native-org-1', 'canonicalVenueId': 'native-venue-1',
                'sourceWorkbookHash': row['source_workbook_sha256']}],
            'threads': [], 'suppression': {'blocked': False, 'reasons': []},
            'snapshotHash': b.digest({'pilot': pilot}), 'asOf': '2026-09-21T05:00:00.000Z'}


def add_thread(native, body='Could we start with just one room?'):
    route = b.run({'action': 'evaluate', 'native': native})['crosswalk']['routing']
    account = {'id': 'SYN-account', 'externalAccountId': 'SYN-no-send-account', 'provider': 'FAKE',
               'mailboxAddress': 'crm-owner@example.invalid', 'deliveryEnabled': False,
               'capabilities': [], 'connectionStatus': 'DISABLED'}
    common = {'threadId': 'SYN-thread', 'organizationId': native['organization']['id'], 'venueId': native['venue']['id'],
              'providerAccountId': account['id'], 'subject': 'A small visitor guide', 'ccAddresses': [], 'bccAddresses': [],
              'sourceReference': 'synthetic:crm-sales:test-message'}
    outbound = dict(common, id='SYN-out', providerMessageId='SYN-provider-out', direction='OUTBOUND', status='SENT',
                    fromAddress=account['mailboxAddress'], toAddresses=[route['recipient']], references=[],
                    textBody='Would a small visitor-guide discussion be useful?', occurredAt='2026-09-21T03:00:00.000Z')
    inbound = dict(common, id='SYN-in', providerMessageId='SYN-provider-in', direction='INBOUND', status='RECEIVED',
                   fromAddress=route['recipient'], toAddresses=[account['mailboxAddress']], references=['SYN-out'],
                   textBody=body, occurredAt='2026-09-21T04:00:00.000Z')
    native['threads'] = [{'id': 'SYN-thread', 'updatedAt': '2026-09-21T04:00:01.000Z',
                          '_count': {'messages': 2},
                          'providerMappings': [{'providerThreadId': 'SYN-provider-thread', 'providerAccount': account}],
                          'messages': [outbound, inbound]}]
    native['snapshotHash'] = b.digest(native['threads'])
    return native


def gmail_thread(native):
    native = add_thread(native)
    thread = native['threads'][0]
    thread['id'] = 'crm-real-thread'
    mapping = thread['providerMappings'][0]
    account = mapping['providerAccount']
    account.update(id='crm-gmail-account', externalAccountId='owner@example.com',
                   provider='GMAIL', mailboxAddress='owner@example.com',
                   capabilities=['RECEIVE'], connectionStatus='CONNECTED')
    mapping['providerThreadId'] = 'gmail-thread-1'
    for message in thread['messages']:
        message.update(threadId=thread['id'], providerAccountId=account['id'],
                       providerMessageId='gmail-' + message['id'],
                       bodyRetentionState='TEMPORARY', bodyExpiresAt='2026-09-22T05:00:00.000Z',
                       sourceReference='https://mail.google.com/mail/u/' + quote(account['externalAccountId'], safe='') +
                       '/#all/' + quote('gmail-' + message['id'], safe=''))
        if message['direction'] == 'OUTBOUND':
            message['fromAddress'] = account['mailboxAddress']
        else:
            message['toAddresses'] = [account['mailboxAddress']]
    native['snapshotHash'] = b.digest(thread)
    return native


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        socket.socket = b.no_network
        socket.create_connection = b.no_network
        socket.getaddrinfo = b.no_network

    def test_exact_native_crosswalk_and_distinct_hashes(self):
        result = b.run({'action': 'evaluate', 'native': native_fixture()})
        self.assertEqual(result['crosswalk']['nativeVenueId'], 'native-venue-1')
        self.assertNotEqual(result['crosswalk']['nativeRawRowSha256'], result['crosswalk']['componentRowSha256'])
        self.assertEqual(result['gate']['decision'], 'ENOUGH_EVIDENCE')

    def test_candidate_stays_unknown(self):
        native = native_fixture(); before = copy.deepcopy(native)
        result = b.run({'action': 'prepare', 'native': native})
        self.assertEqual(native, before)
        self.assertEqual(result['crosswalk']['nativeEmailReadiness'], 'UNKNOWN')
        self.assertEqual(result['crosswalk']['nativePermissionState'], 'UNKNOWN')
        self.assertFalse(result['crosswalk']['recipientSelectedByTom'])

    def test_selected_business_evidence_has_a_frozen_review_deadline(self):
        native = native_fixture()
        result = b.run({'action': 'prepare', 'native': native})
        due = result['preparation']['businessFreshnessReviewDueAt']
        self.assertIsNotNone(due)
        self.assertGreater(b.owners()['contracts'].when(due),
                           b.owners()['contracts'].when(native['asOf']))
        later = native_fixture()
        later['asOf'] = '2027-09-21T05:00:00.000Z'
        self.assertIsNone(b.run({'action': 'prepare', 'native': later})['preparation'])

    def test_no_approved_language_and_real_wlt(self):
        result = b.run({'action': 'prepare', 'native': native_fixture()})
        context = result['preparation']['writerContext']
        self.assertEqual(context['approved_language_snapshot']['current_approved_count'], 0)
        self.assertEqual(context['approved_language_snapshot']['selected_entries'], [])
        self.assertTrue(context['WLT_packet_identity'])
        self.assertFalse(result['SEND_AUTHORIZED'])

    def test_form_route_not_fake_email(self):
        result = b.run({'action': 'prepare', 'native': native_fixture('P06')})
        self.assertEqual(result['crosswalk']['routing']['kind'], 'contact_form')
        self.assertIsNone(result['crosswalk']['routing']['recipient'])
        self.assertIsNone(result['crosswalk']['nativeContactId'])

    def test_unknown_source_research_is_bounded(self):
        native = native_fixture(); native['importRecords'] = []; native['sources'] = []
        result = b.run({'action': 'evaluate', 'native': native})
        self.assertEqual(result['gate']['decision'], 'RESEARCH_REQUIRED')
        self.assertLessEqual(len(result['gate']['research_plan']), 4)
        self.assertIsNone(result['preparation'])

    def test_human_input_for_unknown_relationship(self):
        native = native_fixture(); native['importRecords'] = []; native['threads'] = [{'id': 'unknown-thread'}]
        result = b.run({'action': 'evaluate', 'native': native})
        self.assertEqual(result['gate']['decision'], 'HUMAN_INPUT_REQUIRED')

    def test_source_cell_conflict(self):
        native = native_fixture(); native['importRecords'][0]['rawPayload']['city'] = 'Elsewhere'
        with self.assertRaisesRegex(ValueError, 'SOURCE_ROW_CELL_CONFLICT'):
            b.run({'action': 'prepare', 'native': native})

    def test_raw_hash_conflict(self):
        native = native_fixture(); native['importRecords'][0]['rawPayload']['_source']['rawRowSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'NATIVE_RAW_ROW_HASH_CONFLICT'):
            b.run({'action': 'prepare', 'native': native})

    def test_evidence_from_another_workbook_cannot_satisfy_pilot_crosswalk(self):
        native = native_fixture()
        native['importRecords'][1]['sourceWorkbookHash'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'NATIVE_SOURCE_EVIDENCE_CROSSWALK_MISSING'):
            b.run({'action': 'prepare', 'native': native})

    def test_suppression_before_composer(self):
        native = native_fixture(); native['suppression'] = {'blocked': True, 'reasons': ['native hold']}
        result = b.run({'action': 'prepare', 'native': native})
        self.assertEqual(result['gate']['decision'], 'HUMAN_INPUT_REQUIRED')
        self.assertIsNone(result['preparation'])

    def test_native_thread_reducer_and_reply_preparation(self):
        native = add_thread(native_fixture())
        result = b.run({'action': 'prepare', 'native': native,
                        'answerText': 'We could discuss starting with just one room, using the material you choose.'})
        self.assertEqual(result['correspondence']['projection']['relationship_state'], 'asked_question')
        self.assertEqual(result['preparation']['request']['mode'], 'reply')
        self.assertEqual(result['preparation']['request']['thread_state']['latest_message']['message_id'], 'SYN-in')
        self.assertTrue(result['correspondence']['snapshot']['synthetic_correspondence'])
        self.assertFalse(result['preparation']['writerContext']['synthetic'])

    def test_gmail_source_adapter_builds_transient_reply_from_exact_source(self):
        native = gmail_thread(native_fixture())
        route = b.run({'action': 'evaluate', 'native': native})['crosswalk']['routing']
        snapshot = b.native_thread(native, route, 'component-real', b.owners())
        self.assertFalse(snapshot['synthetic_correspondence'])
        self.assertEqual(snapshot['provider']['name'], 'gmail')
        result = b.run({'action': 'prepare', 'native': native,
                        'answerText': 'We could discuss starting with one room and the material you choose.'})
        self.assertEqual(result['preparation']['request']['mode'], 'reply')
        self.assertEqual(result['preparation']['request']['thread_state']['latest_message']['body'],
                         'Could we start with just one room?')
        self.assertFalse(result['SEND_AUTHORIZED'])
        native['threads'][0]['messages'][1]['sourceReference'] = 'https://mail.google.com/other'
        with self.assertRaisesRegex(ValueError, 'GMAIL_SOURCE_IDENTITY_CONFLICT'):
            b.native_thread(native, route, 'component-real', b.owners())

    def test_expired_gmail_body_cannot_enter_reply_adapter(self):
        native = gmail_thread(native_fixture())
        route = b.run({'action': 'evaluate', 'native': native})['crosswalk']['routing']
        native['threads'][0]['messages'][1]['bodyExpiresAt'] = native['asOf']
        with self.assertRaisesRegex(ValueError, 'GMAIL_BODY_UNAVAILABLE_OR_EXPIRED'):
            b.native_thread(native, route, 'component-real', b.owners())

    def test_multiple_threads_require_exact_selected_thread(self):
        native = gmail_thread(native_fixture())
        second = copy.deepcopy(native['threads'][0])
        second['id'] = 'crm-real-thread-2'
        second['providerMappings'][0]['providerThreadId'] = 'gmail-thread-2'
        for message in second['messages']:
            message['threadId'] = second['id']
            message['id'] += '-2'
            message['providerMessageId'] += '-2'
            message['sourceReference'] += '-2'
        native['threads'].append(second)
        native['threads'][0]['messages'][-1]['bodyExpiresAt'] = native['asOf']
        native['snapshotHash'] = b.digest(native['threads'])
        with self.assertRaisesRegex(ValueError, 'EXPLICIT_THREAD_SELECTION_REQUIRED'):
            b.run({'action': 'prepare', 'native': native,
                   'answerText': 'We can discuss beginning with one room and material you choose.'})
        result = b.run({'action': 'prepare', 'native': native,
            'selectedThreadId': second['id'],
            'answerText': 'We can discuss beginning with one room and material you choose.'})
        self.assertEqual(result['correspondence']['projection']['thread_id'], second['id'])
        with self.assertRaisesRegex(ValueError, 'GMAIL_BODY_UNAVAILABLE_OR_EXPIRED'):
            b.run({'action': 'prepare', 'native': native,
                'selectedThreadId': native['threads'][0]['id'],
                'answerText': 'We can discuss beginning with one room and material you choose.'})

    def test_reply_needs_operator_answer_not_speculative_research(self):
        with self.assertRaisesRegex(ValueError, 'HUMAN_RESPONSE_DIRECTION_REQUIRED'):
            b.run({'action': 'prepare', 'native': add_thread(native_fixture())})

    def test_provider_message_identity_conflict(self):
        native = add_thread(native_fixture())
        native['threads'][0]['messages'][-1]['providerAccountId'] = 'SYN-other-account'
        with self.assertRaisesRegex(ValueError, 'PROVIDER_MESSAGE_ACCOUNT_CONFLICT'):
            b.run({'action': 'evaluate', 'native': native})

    def test_no_transcript_dump(self):
        with self.assertRaisesRegex(ValueError, 'THREAD_OR_TRANSCRIPT_DUMP'):
            b.run({'action': 'check', 'native': native_fixture(), 'draft': {'subject': 'Hello', 'body': 'From: sender\nTo: venue\nAn old email'}})

    def test_idempotent_read(self):
        native = add_thread(native_fixture())
        self.assertEqual(b.run({'action': 'evaluate', 'native': native}), b.run({'action': 'evaluate', 'native': native}))

    def test_stop_message_wins(self):
        result = b.run({'action': 'prepare', 'native': add_thread(native_fixture(), 'Please stop emailing me.')})
        self.assertTrue(result['correspondence']['projection']['suppression']['blocked'])
        self.assertIsNone(result['preparation'])

    def test_no_sender_action_or_network(self):
        with self.assertRaisesRegex(ValueError, 'NO_SENDER_OR_UNKNOWN_ACTION'):
            b.run({'action': 'send', 'native': native_fixture()})
        with self.assertRaisesRegex(RuntimeError, 'network capability is absent'):
            socket.create_connection(('example.invalid', 443))


if __name__ == '__main__':
    unittest.main(verbosity=2)
