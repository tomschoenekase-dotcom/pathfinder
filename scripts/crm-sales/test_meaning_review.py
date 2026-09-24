"""Serial offline integration against the actual unchanged Composer owners."""
import copy
import socket
import unittest
from unittest.mock import patch

import component_bridge as b
from test_component_bridge import native_fixture, add_thread


def reviewed_fixture(native=None):
    native = native or native_fixture('P03')
    preparation = b.run({'action': 'prepare', 'native': native})
    claims = {claim['claim_id']: claim for claim in preparation['preparation']['writerContext']['allowed_claims']}
    parts = [
        ('subject', 'Could a small visitor guide be useful?', 'SALES HYPOTHESIS', ['H-SCOPE'], 'hypothetical',
         'This asks about a possible guide and does not assert an existing feature or agreement.'),
        ('body', 'Hi,', 'NONFACTUAL', [], 'nonfactual', 'An ordinary greeting asserts no venue or relationship fact.'),
        ('body', claims['F-VENUE']['text'] + '.', 'SOURCE FACT', ['F-VENUE'], 'supported',
         'The exact venue name is supported by the bound local identity source, not by a supposed visit.'),
        ('body', 'Would it be useful to explore a small question-based guide for one room or a few objects? It could use material you choose and stay focused on that part of a visit.',
         'SALES HYPOTHESIS', ['H-SCOPE'], 'hypothetical',
         'The proposed limited scope is optional, not a factual capability, promised result or established venue need.'),
        ('body', 'Would a short conversation about that idea make sense?', 'SALES HYPOTHESIS', ['H-ASK'], 'hypothetical',
         'This is an optional question and does not assert that a meeting has been agreed.'),
        ('body', 'Thanks,\nTom', 'NONFACTUAL', [], 'nonfactual', 'Ordinary closing uses the task-supplied sender name only.'),
    ]
    draft = {'subject': parts[0][1], 'body': '\n\n'.join(part[1] for part in parts[1:])}
    annotations, assessments = [], []
    offset = 0
    for index, (section, quote, category, ids, verdict, reason) in enumerate(parts):
        start = 0 if section == 'subject' else offset
        aid = 'A%03d' % (index + 1)
        annotations.append({'annotation_id': aid, 'section': section, 'start': start,
            'end': start + len(quote), 'quote': quote, 'category': category,
            'claim_ids': ids, 'reason': reason, 'answers': []})
        assessments.append({'annotation_id': aid, 'verdict': verdict, 'reason': reason})
        if section == 'body':
            offset += len(quote) + 2
    review = {'bindingHash': 'b' * 64, 'draftId': 'native-draft-fixture', 'preparationId': 'native-prep-fixture',
              'contentHash': 'c' * 64, 'annotations': annotations, 'languageUses': [],
              'reviewer': {'kind': 'model', 'identity': 'GPT-6 Astra Pro — explicitly synthetic integration assessment'},
              'assessments': assessments, 'answers': [], 'unsupportedClaims': []}
    return {'action': 'meaning', 'native': native, 'draft': draft, 'review': review}


class MeaningIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        socket.socket = b.no_network
        socket.create_connection = b.no_network
        socket.getaddrinfo = b.no_network

    def test_original_checkers_called_and_exact_factual_source_exposed(self):
        request = reviewed_fixture()
        owner = b.owners()['validator']
        with patch.object(owner, 'check_annotations', wraps=owner.check_annotations) as annotations, \
             patch.object(owner, 'check_language', wraps=owner.check_language) as language, \
             patch.object(owner, 'check_meaning_review', wraps=owner.check_meaning_review) as meaning:
            result = b.run(request)['meaningCheck']
            self.assertEqual([annotations.call_count, language.call_count, meaning.call_count], [1, 1, 1])
        self.assertEqual(result['status'], 'ASSESSED_NO_SEND', result['findings'])
        source = result['claimEvidence'][2]['sources'][0]
        self.assertEqual(source['claim_id'], 'F-VENUE')
        self.assertTrue(source['source_id'] and source['source_pointer'] and source['evidence_sha256'])
        self.assertEqual(result['submissionSha256'], b.digest(request['review']))
        self.assertFalse(result['semanticCertification'])
        self.assertEqual(result['humanApproval'], 'ABSENT')
        self.assertFalse(result['filesystemBundleValidatorInvoked'])

    def test_unsupported_exhibit_price_and_completed_visit_cannot_be_claimed_supported(self):
        request = reviewed_fixture()
        old = request['review']['annotations'][2]['quote']
        claim = 'Your Moon Gem Gallery exhibit costs $25, and I visited it yesterday.'
        request['draft']['body'] = request['draft']['body'].replace(old, claim)
        delta = len(claim) - len(old)
        request['review']['annotations'][2]['quote'] = claim
        request['review']['annotations'][2]['end'] += delta
        for annotation in request['review']['annotations'][3:]:
            annotation['start'] += delta; annotation['end'] += delta
        # Deliberately incorrect MODEL verdict; deterministic original screens must still hold.
        result = b.run(request)['meaningCheck']
        codes = {finding['code'] for finding in result['findings']}
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertTrue({'UNSUPPORTED_PERSONALIZATION_DETAIL', 'UNSUPPORTED_NUMERIC_CLAIM',
                         'INVENTED_PRICING', 'UNVERIFIED_VISIT'} <= codes, codes)
        self.assertTrue(result['unresolvedHolds'])
        self.assertFalse(result['SEND_AUTHORIZED'])

    def test_explicit_unsupported_and_uncertain_assessments_are_retained_holds(self):
        request = reviewed_fixture()
        request['review']['assessments'][2]['verdict'] = 'unsupported'
        request['review']['unsupportedClaims'] = ['Venue assertion needs further source verification.']
        result = b.run(request)['meaningCheck']
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['receipt']['unsupported_claims'], request['review']['unsupportedClaims'])
        self.assertIn('UNSUPPORTED_OR_UNCERTAIN_MEANING', [finding['code'] for finding in result['findings']])

    def test_changed_text_invalidates_old_exact_annotations(self):
        request = reviewed_fixture()
        request['draft']['subject'] = 'A different subject after review'
        result = b.run(request)['meaningCheck']
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertTrue(any(finding['code'] in {'INVALID_SPAN', 'CHANGED_ANNOTATION_QUOTE', 'UNCOVERED_TEXT'} for finding in result['findings']))

    def test_missing_and_reordered_assessments_do_not_clear_coverage(self):
        for mutate in (lambda value: value.pop(), lambda value: value.reverse()):
            request = reviewed_fixture()
            mutate(request['review']['assessments'])
            result = b.run(request)['meaningCheck']
            self.assertIn('MEANING_COVERAGE', [finding['code'] for finding in result['findings']])

    def test_zero_approved_language_is_real_empty_not_fabricated(self):
        result = b.run(reviewed_fixture())
        self.assertEqual(result['draftCheck']['claimAnnotations'], 'SUPPLIED_FOR_EXACT_NATIVE_REVISION')
        self.assertEqual(result['draftCheck']['meaningReview'], result['meaningCheck']['status'])
        library = result['preparation']['writerContext']['approved_language_snapshot']
        self.assertEqual((library['current_approved_count'], library['selected_entries']), (0, []))
        self.assertEqual(result['meaningCheck']['languageUses'], [])
        self.assertTrue(any('approved-language/' in key for key in result['componentCodeHashes']))

    def test_language_claims_without_actual_approval_are_blocked(self):
        request = reviewed_fixture()
        request['review']['annotations'][0]['category'] = 'APPROVED REUSABLE LANGUAGE'
        result = b.run(request)['meaningCheck']
        self.assertIn('FALSE_APPROVED_LANGUAGE_LABEL', [finding['code'] for finding in result['findings']])

    def test_fact_cannot_be_laundered_as_courtesy_or_blended_with_task_direction(self):
        for category, code in [('NONFACTUAL', 'FACT_DISGUISED_AS_COURTESY'), ('TASK CONSTRAINT', 'BLENDED_EVIDENCE_CATEGORIES')]:
            request = reviewed_fixture()
            request['review']['annotations'][2]['category'] = category
            result = b.run(request)['meaningCheck']
            self.assertIn(code, [finding['code'] for finding in result['findings']])

    def test_unicode_codepoint_spans_use_original_composer_coordinates(self):
        request = reviewed_fixture()
        # A hypothesis with a non-BMP symbol shifts UTF-16 but not Python code-point offsets.
        request['draft']['subject'] += ' 🔎'
        annotation = request['review']['annotations'][0]
        annotation.update(quote=request['draft']['subject'], end=len(request['draft']['subject']))
        result = b.run(request)['meaningCheck']
        self.assertFalse(any(finding['code'] in {'INVALID_SPAN', 'CHANGED_ANNOTATION_QUOTE', 'UNCOVERED_TEXT'} for finding in result['findings']))
        annotation['end'] += 1
        changed = b.run(request)['meaningCheck']
        self.assertIn('INVALID_SPAN', [finding['code'] for finding in changed['findings']])

    def test_model_identity_is_only_attribution_and_binding_hashes_are_distinct(self):
        request = reviewed_fixture()
        result = b.run(request)['meaningCheck']
        self.assertIn('ATTRIBUTED_ONLY', result['reviewerAuthentication'])
        self.assertEqual(result['bindingHash'], request['review']['bindingHash'])
        self.assertNotEqual(result['composerDraftSha256'], result['contentHash'])
        self.assertEqual(result['receipt']['annotations_sha256'], b.owners()['common'].fingerprint(request['review']['annotations']))

    def test_no_mutation_of_inputs_and_no_sender_action(self):
        request = reviewed_fixture(); before = copy.deepcopy(request)
        b.run(request)
        self.assertEqual(request, before)
        request['action'] = 'send'
        with self.assertRaisesRegex(ValueError, 'NO_SENDER'):
            b.run(request)

    def test_reply_body_still_refuses_original_chain(self):
        native = add_thread(native_fixture())
        with self.assertRaisesRegex(ValueError, 'THREAD_OR_TRANSCRIPT_DUMP|REPLY_MUST_NOT_COPY_THE_CHAIN'):
            b.run({'action': 'check', 'native': native, 'answerText': 'We could discuss one room.',
                   'draft': {'subject': 'Re: Guide', 'body': 'From: venue\nCould we start with just one room?'}})


if __name__ == '__main__':
    unittest.main(verbosity=2)
