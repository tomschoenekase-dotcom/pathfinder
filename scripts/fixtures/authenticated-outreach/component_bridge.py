"""Synthetic INPUT fixture for the real native HTTP acceptance boundary.

This is not a writer, research gate, WLT implementation or production fallback.
It neither authors an email nor accesses private source, a database or a network.
Native authentication, scope, leases, tasks, CAS, revisions and receipts remain
the actual production owners. Installed private components are a separate gate.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys

sys.dont_write_bytecode = True


def deny_network(*_args, **_kwargs):
    raise RuntimeError('SYNTHETIC_CONTRACT_NETWORK_DENIED')


socket.socket = socket.create_connection = deny_network


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def main():
    vault = Path(os.environ['TORCHIKO_CRM_VAULT']).resolve(strict=True)
    assert vault.name == 'synthetic-contract-vault'
    assert (vault / 'SYNTHETIC-HTTP-CONTRACT-ONLY').read_text() == 'No private corpus. No installed WLT. No live CRM.\n'
    raw = sys.stdin.read(750001)
    assert len(raw.encode('utf-8')) <= 750000
    request = json.loads(raw)
    assert request['action'] in ('evaluate', 'prepare', 'check')
    native = request['native']
    assert native['venue']['id'] == 'SYN-HTTP-PROSPECT'
    assert native['organization']['id'] == 'SYN-HTTP-ORG'
    assert native['venue']['name'] == 'SYNTHETIC Map Fixture Museum'
    assert not native['threads'] and not native['contacts']
    snapshot = native['snapshotHash']
    assert len(snapshot) == 64 and all(c in '0123456789abcdef' for c in snapshot)
    context = {
        'WLT_packet_identity': 'SYNTHETIC-CONTRACT-NOT-INSTALLED-WLT',
        'approved_language_snapshot': {'current_approved_count': 0, 'selected_entries': []},
        'relationship': {'state': 'synthetic cold fixture'},
    }
    result = {
        'schema': 'torchiko.native-sales-components/1', 'nativeSnapshotHash': snapshot,
        'SEND_AUTHORIZED': False, 'senderAvailable': False, 'blocker': None,
        'fixtureNotice': 'Synthetic component contract input; private owners NOT exercised.',
        'gate': {'decision': 'ENOUGH_EVIDENCE', 'can_prepare': True},
        'crosswalk': {
            'synthetic': True, 'nativeVenueId': 'SYN-HTTP-PROSPECT',
            'nativeOrganizationId': 'SYN-HTTP-ORG',
            'routing': {'kind': 'email', 'recipient': 'qa@example.invalid', 'routing_id': 'SYN-HTTP-ROUTE'},
        },
        'componentCodeHashes': {'syntheticHttpContract': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
        'preparation': {
            'SEND_AUTHORIZED': False, 'metadata': {'SEND_AUTHORIZED': False},
            'request': {'mode': 'cold', 'purpose': 'Provider-dark synthetic native persistence check, not outreach.'},
            'fileSha256s': {'context': sha(json.dumps(context, sort_keys=True))},
            'writerContext': context,
            'writerMarkdown': 'SYNTHETIC COMPONENT CONTRACT INPUT. No installed WLT or real supplied reference was used.',
        },
    }
    if request['action'] == 'check':
        draft = request['draft']
        assert isinstance(draft['subject'], str) and isinstance(draft['body'], str)
        result['draftCheck'] = {
            'composerDraftSha256': sha('Subject: ' + draft['subject'] + '\n\n' + draft['body'] + '\n'),
            'bodySha256': sha(draft['body']), 'SEND_AUTHORIZED': False,
            'scope': 'SYNTHETIC_BYTE_BINDING_ONLY_NOT_WLT_OR_MEANING_REVIEW',
        }
    print(json.dumps(result, ensure_ascii=False))


try:
    main()
except Exception:
    print(json.dumps({'error': 'SYNTHETIC_HTTP_COMPONENT_CONTRACT_REFUSED'}))
    sys.exit(1)
