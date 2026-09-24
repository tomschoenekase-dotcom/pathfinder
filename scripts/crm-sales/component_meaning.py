"""Adapt ORIGINAL Composer claim/language/meaning contracts to native revisions.

No copied semantic validator, bundle writes, path overrides, network or approval.
The native database owns revision/recipient/source/CAS lifecycle. Composer's
unchanged pure checking entrypoints own annotation, language and meaning checks.
The separate upstream filesystem-bundle lifecycle validator is not invoked here.
"""
from __future__ import annotations
import copy
import json


def assess(base, draft, submission, owners):
    common, validator = owners['common'], owners['validator']
    common.require(isinstance(submission, dict) and set(submission) == {
        'bindingHash', 'draftId', 'preparationId', 'contentHash', 'annotations',
        'languageUses', 'reviewer', 'assessments', 'answers', 'unsupportedClaims'},
        'EXACT_NATIVE_MEANING_SUBMISSION_REQUIRED')
    preparation = base['preparation']
    context = preparation['writerContext']
    d = {'subject': draft['subject'], 'body': draft['body'],
         'draft_sha256': common.sha(common.draft_bytes(draft)),
         'preparation_id': preparation['metadata']['preparation_id'],
         'annotations': copy.deepcopy(submission['annotations']),
         'language_uses': copy.deepcopy(submission['languageUses'])}
    reviewer = submission['reviewer']
    common.require(isinstance(reviewer, dict) and set(reviewer) == {'kind', 'identity'},
                   'EXACT_REVIEWER_ATTRIBUTION_REQUIRED')
    receipt = {'reviewer': reviewer['identity'], 'reviewer_kind': reviewer['kind'],
               'draft_sha256': d['draft_sha256'], 'preparation_id': d['preparation_id'],
               'annotations_sha256': common.fingerprint(d['annotations']),
               'language_uses_sha256': common.fingerprint(d['language_uses']),
               'assessments': copy.deepcopy(submission['assessments']),
               'answers': copy.deepcopy(submission['answers']),
               'unsupported_claims': copy.deepcopy(submission['unsupportedClaims'])}
    findings = []

    def error(code, detail):
        findings.append({'code': code, 'detail': str(detail)})

    # These are the actual installed owner functions, not look-alike implementations.
    validator.check_annotations(d, context, preparation['request'], error)
    validator.check_language(d, context, error)
    meaning_status = validator.check_meaning_review(d, context, receipt, error)
    check = base['draftCheck']
    for flag in check['claimRiskFlags']:
        error(flag, 'Original Composer conservative risk screen requires this assertion to be removed or supported by a future explicit contract.')
    for finding in check['WLT_check']['errors']:
        error('WLT_' + finding['kind'].upper(), finding)
    high_risk = {'unsupplied_contact_or_url', 'possible_example_detail', 'unsupplied_number',
                 'eight_word_overlap', 'possible_participant_scope_change'}
    for finding in check['WLT_check']['warnings']:
        if finding['kind'] in high_risk:
            error('WLT_' + finding['kind'].upper(), finding)
    catalog = {claim['claim_id']: claim for claim in context['allowed_claims']}
    assessments = {a['annotation_id']: a for a in submission['assessments']}
    evidence = []
    for annotation in d['annotations']:
        evidence.append({
            'annotation': annotation,
            'assessment': assessments.get(annotation['annotation_id']),
            'sources': [copy.deepcopy(catalog[cid]) for cid in annotation['claim_ids'] if cid in catalog],
            'unknownClaimIds': [cid for cid in annotation['claim_ids'] if cid not in catalog],
            'supportIsAttributedAssessment': True,
        })
    return {
        'schema': 'torchiko.native-composer-meaning/1',
        'bindingHash': submission['bindingHash'], 'draftId': submission['draftId'],
        'preparationId': submission['preparationId'], 'contentHash': submission['contentHash'],
        'submissionSha256': common.sha(json.dumps(submission, sort_keys=True,
            ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')),
        'composerDraftSha256': d['draft_sha256'],
        'composerPreparationId': d['preparation_id'],
        'status': 'BLOCKED' if findings else 'ASSESSED_NO_SEND',
        'meaningReviewStatus': meaning_status,
        'receipt': receipt, 'annotations': d['annotations'], 'languageUses': d['language_uses'],
        'claimEvidence': evidence, 'findings': findings,
        'unresolvedHolds': [f['code'] + ': ' + f['detail'] for f in findings],
        'operationalHolds': copy.deepcopy(owners['composer'].HARD_HOLDS),
        'reviewer': reviewer,
        'upstreamFunctions': ['validator.check_annotations', 'validator.check_language', 'validator.check_meaning_review'],
        'filesystemBundleValidatorInvoked': False,
        'scope': 'ORIGINAL_COMPOSER_CLAIM_LANGUAGE_MEANING_CHECKS_WITH_NATIVE_REVISION_LIFECYCLE',
        'sourceRefsAreDatedSnapshots': True,
        'reviewerAuthentication': 'ATTRIBUTED_ONLY_NOT_AUTHENTICATED_BY_COMPOSER',
        'semanticCertification': False, 'humanApproval': 'ABSENT', 'voiceResemblance': 'UNRATED',
        'SEND_AUTHORIZED': False,
    }
