import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set(['.git', '.next', '.turbo', 'dist', 'node_modules'])
const sourceExtensions = new Set(['.ts', '.tsx'])
const safeMethods = new Set(['$queryRaw', '$executeRaw'])
const prohibitedMethods = new Set(['$queryRawUnsafe', '$executeRawUnsafe', '$queryRawTyped'])
const rawMethods = new Set([...safeMethods, ...prohibitedMethods])
const prismaFragmentHelpers = new Set(['sql', 'raw', 'join', 'empty'])
const approvedPolicies = new Set([
  'platform-intake-source-agent-recovery',
  'tenant-intake-source-routing-lock',
  'tenant-agent-task-operation-lock',
  'tenant-intake-v1-package-authority-share-lock',
  'tenant-approval-grant-consumption-lock',
  'tenant-intake-source-mapping-operation-lock',
  'tenant-intake-source-mapping-source-lock',
  'tenant-intake-v1-package-proposal-operation-lock',
  'platform-intake-v1-processing-discovery',
  'platform-intake-v1-source-lease',
  'tenant-intake-v1-processing-exact-lease',

  'tenant-intake-v1-operation-lock',
  'tenant-intake-v1-owner-revision-lock',
  'tenant-intake-v1-selected-source-snapshot',
  'tenant-agent-delegation-operation-lock',
  'tenant-workflow-approval-request-lock',
  'tenant-workflow-execution-lease',
  'tenant-workflow-authority-share-lock',
  'tenant-workflow-activation-revoke',
  'tenant-agent-outcome-source-provenance-lock',
  'tenant-agent-routine-operation-lock',

  'tenant-media-identity-request-lock',
  'tenant-media-identity-exact-receipt',
  'tenant-media-project-source-lock',
  'tenant-media-temporal-request-lock',
  'system-probe',
  'public-venue-slug',
  'public-venue-id',
  'public-venue-session-token',
  'tenant-and-venue',
  'permission-filtered-record-id-set',
  'tenant-venue-revision-source',
  'tenant-venue-entity-lease',
  'tenant-venue-range-generation-lease',
  'tenant-venue-range-answer-analysis-lease-renew',
  'tenant-venue-range-weekly-report-lease-renew',
  'tenant-venue-range-generation-dispatch-consume',
  'platform-generation-dispatch-lease',
  'tenant-venue-record-generation-dispatch-lease',
  'platform-expired-generation-discovery',
  'platform-expired-voice-session-recovery',
  'platform-due-agent-question-discovery',
  'tenant-agent-question-operation-lock',
  'platform-dispatch-lease',
  'tenant-venue-revision-lease',
  'tenant-optional-venue-cursor-audit',
  'tenant-venue-revision-canary-insert',
  'tenant-venue-exact-invariant-repair',
  'transaction-content-history-context',
  'tenant-content-history-entity-lock',
  'tenant-venue-content-mutation-lock',
  'tenant-venue-report-mutation-lock',
  'tenant-venue-create-slug-lock',
  'platform-client-create-id-lock',
  'platform-client-create-request-lock',
  'tenant-offboarding-request-lock',
  'tenant-onboarding-request-lock',
  'tenant-onboarding-venue-slug-lock',
  'tenant-onboarding-question-lock',
  'tenant-onboarding-question-resume-lock',
  'tenant-intake-upload-request-lock',
  'tenant-intake-upload-quota-lock',
  'tenant-intake-upload-record-lock',
  'tenant-intake-upload-multipart-lock',
  'tenant-intake-file-extraction-lock',
  'tenant-intake-file-extraction-review-lock',
  'platform-intake-v1-file-extraction-discovery',
  'tenant-intake-interview-clarification-resolution-lock',
  'tenant-intake-proposal-request-lock',
  'tenant-intake-website-research-lock',
  'tenant-client-assistant-preference-lock',
  'tenant-client-assistant-turn-operation-lock',
  'tenant-client-assistant-thread-lock',
  'tenant-client-assistant-generation-lock',
  'tenant-client-assistant-completion-lock',
  'tenant-client-assistant-handoff-lock',
  'tenant-customer-access-request-lock',
  'tenant-billing-effect-lock',
  'tenant-first-week-review-lock',
  'tenant-support-operation-lock',
  'tenant-support-agent-run-operation-lock',
  'tenant-support-request-lineage-lock',
  'tenant-guest-chat-turn-lock',
  'tenant-guest-disposition-authorization',
  'tenant-guest-disposition-current-content',
  'tenant-venue-voice-quota-lock',
  'platform-prospect-mailbox-send-reservation-lock',
  'platform-prospect-campaign-send-reservation-lock',
  'platform-prospect-inbound-reply-review-lock',
])

// Hashes bind exact SQL template and interpolation text; only CRLF/LF differences are normalized.
// Run with --print-inventory after a reviewed query change, then update only the intended entry.
// An omitted count permits exactly one occurrence. Reviewed repeated templates must declare
// their exact positive count; adding or removing a call remains an inventory review event.
const approvedOperations = [
  // Authenticated platform-admin authority is durably recorded by the exact database
  // procedure. Although invoked through $queryRaw for its receipt, this call writes.
  {
    file: 'packages/db/src/helpers/guest-conversation-disposition.ts',
    method: '$queryRaw',
    hash: '14cfaf856908a0df009aa382947fe2babf7add6903a7d9d88916bf5c7607df31',
    policy: 'tenant-guest-disposition-authorization',
    effect: 'write',
  },
  // Reviewed QR launch read: the helper first binds tenantId + venueId, then
  // performs this parameterized global LIMIT 2 slug lookup solely to reject
  // ambiguous or foreign destinations. It returns no foreign content. Existing
  // venue-launch-source.test.ts covers wrong-tenant and duplicate-slug rejection.
  {
    file: 'packages/db/src/helpers/venue-launch-source.ts',
    method: '$queryRaw',
    hash: '596048da982d98338c6e2e36c8edf9d9fac8db9c8734d6e51d0cf70ee386587e',
    policy: 'public-venue-slug',
  },
  // Content readers fail closed on the exact scoped disposition tombstone lookup.
  {
    file: 'packages/db/src/helpers/guest-conversation-disposition.ts',
    method: '$queryRaw',
    hash: 'd25f2735654dbdd63ee62b92f7d5c89cd5f0baba888068b173e32779989b2006',
    policy: 'tenant-guest-disposition-current-content',
    effect: 'read',
  },
  // Platform-admin export preflight reads aggregate counts and row byte sizes for the exact
  // tenant, venue, active recipient support ACL, and explicitly requested sections only.
  {
    file: 'packages/db/src/helpers/support-portable-export-read.ts',
    method: '$queryRaw',
    hash: 'fe48cb33620ec27e105f325ed722dd69b631bbcd29267855bebde28038b55550',
    policy: 'tenant-and-venue',
  },
  // Human-admin adjudication locks exact proposal, answered question and canonical target; no publication.
  {
    file: 'packages/api/src/lib/semantic-conflict-resolution-service.ts',
    method: '$queryRaw',
    hash: '4500bf4b402bad7181d178d8cdb216eebcbae652653850b77a642edc1ca98f9e',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/api/src/lib/semantic-conflict-resolution-service.ts',
    method: '$queryRaw',
    hash: 'b28a6fa0efa60e3c850b616585834d29ab8d7ae83bc27c4ba2f6b1ec7267e0de',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/api/src/lib/semantic-conflict-resolution-service.ts',
    method: '$queryRaw',
    hash: 'd17de739c620d48fc43a5951fd1b5ef27c2551bd1040832b6cb6757cfe9c94b6',
    policy: 'tenant-and-venue',
  },
  // Human-admin duplicate evidence locks exact proposal and matched target through immutable receipt.
  {
    file: 'packages/api/src/lib/semantic-duplicate-resolution-service.ts',
    method: '$queryRaw',
    hash: '4500bf4b402bad7181d178d8cdb216eebcbae652653850b77a642edc1ca98f9e',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/api/src/lib/semantic-duplicate-resolution-service.ts',
    method: '$queryRaw',
    hash: '5d261c4084fe0e99488dd31e6dca66dced26e7e822321235008a91fcdffeafba',
    policy: 'tenant-and-venue',
  },
  // Human-admin decline locks tenant/venue/proposal before revision-checked rejection and audit.
  {
    file: 'packages/api/src/lib/semantic-reviewed-decline-service.ts',
    method: '$queryRaw',
    hash: '4500bf4b402bad7181d178d8cdb216eebcbae652653850b77a642edc1ca98f9e',
    policy: 'tenant-and-venue',
  },
  // Capability-gated reader locks credential tenant/venue/receipt before current worker admission.
  {
    file: 'packages/api/src/mcp/question-source-reader.ts',
    method: '$executeRaw',
    hash: '4a5dcd847e45a88332be5cd0bd9f34a98e2f7904d15494aad412f5b1042f622f',
    policy: 'tenant-intake-file-extraction-review-lock',
  },
  // Lock exact run/lease, scoped identity, worker, credential and session; grants and post-lock expiry remain checked.
  {
    file: 'packages/db/src/helpers/agent-current-worker-claim.ts',
    method: '$queryRaw',
    hash: 'f53865604b46e68acc0ee3c0a4e7b19c8933ee159022d01da3c87b1ed6509f82',
    policy: 'tenant-workflow-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-current-worker-claim.ts',
    method: '$queryRaw',
    hash: 'aedebf90c6cd851fcbf6914ea7d02a86f34f81e44ad74adb3a29f7fd6f7520f0',
    policy: 'tenant-workflow-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-current-worker-claim.ts',
    method: '$queryRaw',
    hash: '5f511e9efe727652c74d9652c9110666a6bec11977dd2e7a1ead6ef9c3becbb6',
    policy: 'tenant-workflow-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-current-worker-claim.ts',
    method: '$queryRaw',
    hash: 'a17e17cc1738b51962a177f1cba108dc52d56669ca12c755e29062ff945cc83c',
    policy: 'tenant-workflow-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-current-worker-claim.ts',
    method: '$queryRaw',
    hash: '0a9efb82eda3c4ea6ff23fabfb40dd996c760a9fa365c6dbfe65859af3ffe78f',
    policy: 'tenant-workflow-authority-share-lock',
  },
  // Post-lock database time rejects expired worker/run/credential/session authority.
  {
    file: 'packages/db/src/helpers/agent-current-worker-claim.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },
  // Source run claim locks exact tenant/venue/run and current Content identity authority through CAS.
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: '8bac01d46c0c0b79c331b18ab4888ddf53259cb67fe375df420db7c75e734d1f',
    policy: 'tenant-workflow-authority-share-lock',
  },
  // Routine creation serializes one exact tenant/venue/key definition before
  // replay/conflict evaluation; subsequent runtime locks one opaque routine ID.
  {
    file: 'packages/db/src/helpers/agent-routine-actions.ts',
    method: '$executeRaw',
    hash: '05d320583175a1b8e9518bd761c9b5880fcf55574de417d46b89d1009a2bb0ea',
    policy: 'tenant-agent-routine-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-routine-actions.ts',
    method: '$executeRaw',
    hash: '1ab0da9456471fd0179ac70e9c08eaf9e77163fdbb4d40164a6df72e987ffc4c',
    policy: 'tenant-agent-routine-operation-lock',
    count: 2,
  },
  // Isolated routine worker performs only a database readiness probe before
  // registering its bridge-only maintenance queue.
  {
    file: 'apps/workers/src/agent-routines-only-runtime.ts',
    method: '$queryRaw',
    hash: '1730fc082ddaf286020215008c78754a2d980d4e7aefc39e339c6684fca76e7c',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: 'd49e59454415cc2faf74d70bf2b667e537f6627e3316c43f80890b879d704759',
    policy: 'tenant-workflow-authority-share-lock',
  },
  // Exactly one receipt lock in HUMAN creation and one in trusted SYSTEM admission; no arbitrary repetition.
  {
    file: 'packages/db/src/helpers/agent-task-actions.ts',
    method: '$executeRaw',
    hash: '4c77d7ce1d6d0c5ff6e67c3eca67b2eca60d7151bb114a4d1c994cd87776d5b3',
    policy: 'tenant-intake-file-extraction-review-lock',
    count: 2,
  },
  // Exactly one tenant/operation lock in each HUMAN and SYSTEM path; SYSTEM admission precedes replay.
  {
    file: 'packages/db/src/helpers/agent-task-actions.ts',
    method: '$executeRaw',
    hash: 'e8cfcc6a6d01c8fccf5d6fdd587f5d70c0ddac12c64970eb4c86f9073db54122',
    policy: 'tenant-agent-task-operation-lock',
    count: 2,
  },
  // Bounded platform discovery/backfill joins exact tenant/venue/run/receipt, inserts metadata only and deduplicates.
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '0c0868cae679b924672ef332a56e5a16178e8596a7d20ba914f79ac334b3d1de',
    policy: 'platform-intake-source-agent-recovery',
  },
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$executeRaw',
    hash: '156bed656dc71c87a83a6a4a7afef0c9713ff0fe02f02391b62603b23fa7bf3c',
    policy: 'platform-intake-source-agent-recovery',
  },
  // Lock exact tenant/venue/receipt before source state and dispatch decisions.
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$executeRaw',
    hash: '0861976d66413ceeaef51c6ff09efa1a37a65daabcdc40d64a8b2364ed166f6e',
    policy: 'tenant-intake-file-extraction-review-lock',
  },
  // Lock exact dispatch; advance only its retry timestamp when recovering its immutable completed task.
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$queryRaw',
    hash: 'cfce72dd0299249fc61cf6b63eb1135b37b866b3c00be6928860e7eb044a6df7',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$executeRaw',
    hash: '24286a7c6d35c112414910e2af6a60c040a7a1785b6777c52463ac1510ef486c',
    policy: 'tenant-and-venue',
  },
  // Database time bounds retry delays.
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },
  // Serialize one scoped source task operation before trusted system admission.
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$executeRaw',
    hash: '2b0fd752e8e23e2a14dd0f6c4308c57356a2fe276217a7c38d7916a00dee6440',
    policy: 'tenant-agent-task-operation-lock',
  },
  // Serialize exact routing policy with dispatch admission.
  {
    file: 'packages/db/src/helpers/intake-source-agent-dispatch-actions.ts',
    method: '$executeRaw',
    hash: '3ef120582fa0ffe10b2d7cfbff2bc986e98ea7f91d64ebb603f4378ddc7402d8',
    policy: 'tenant-intake-source-routing-lock',
  },
  // Scoped configuration and admission locks keep routing revision coherent; no provider work.
  {
    file: 'packages/db/src/helpers/intake-source-agent-routing-actions.ts',
    method: '$executeRaw',
    hash: '14976f2a0c1d5e5fea2e17a0204154470516dfaa8c4d480b42ca99834e5deb0d',
    policy: 'tenant-intake-source-routing-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-source-agent-routing-actions.ts',
    method: '$executeRaw',
    hash: '6d7fbbf9e55216698bb8acf5911043d8a262af4d51ac133755b4575013b94fee',
    policy: 'tenant-intake-source-routing-lock',
  },
  // Lock exact tenant identity; subsequent scoped Content query and capability checks decide eligibility.
  {
    file: 'packages/db/src/helpers/intake-source-agent-routing-actions.ts',
    method: '$queryRaw',
    hash: '5b1692321497e60173601a9a7be12f006b43058078f7003876f0516f1acba976',
    policy: 'tenant-workflow-authority-share-lock',
  },
  // Revalidate exact proposal and canonical target under SHARE locks before current fulfillment readback.
  {
    file: 'packages/db/src/helpers/support-no-change-fulfillment.ts',
    method: '$queryRaw',
    hash: '54666e4dfa8d57d5505b5e124fa8de18e42a9983425ddd55ece0f41e7d707e9e',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/support-no-change-fulfillment.ts',
    method: '$queryRaw',
    hash: '0a6e837ec57e9513cccd2c1dbe66c11e31796c63e46dc89125a57f366435310f',
    policy: 'tenant-and-venue',
  },
  // Scoped immutable decline/replacement fulfillment locks the exact referenced proposal.
  {
    file: 'packages/db/src/helpers/support-proposal-resolution-fulfillment.ts',
    method: '$queryRaw',
    hash: 'c04ca8673535932ee16d637fb98e5d2e1a66e8bea001022f46602f7e9a6a5301',
    policy: 'tenant-and-venue',
  },
  // Serialize founder review against art revision writes on the exact scoped candidate.
  {
    file: 'packages/db/src/helpers/character-candidate-reviews.ts',
    method: '$queryRaw',
    hash: 'e9ef58d166c85dab962bafbcbd5b692ef9a07173e1646635ae69420b8abf71db',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/conversation-learning-actions.ts',
    method: '$executeRaw',
    hash: '56c1814d0b991854fb97fb6d05a1b2d8f88f2106ee565bb76db483f696757012',
    policy: 'system-probe',
  },
  // Source-backed outcome observations share-lock the exact terminal run before
  // its exact tenant/venue question so the immutable answer revision is coherent.
  {
    file: 'packages/db/src/helpers/agent-outcome-actions.ts',
    method: '$queryRaw',
    hash: '747a09e0973eb2382f014a79eefb5ea9dac86600ae1d130fa24d478d3407c40d',
    policy: 'tenant-agent-outcome-source-provenance-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-outcome-actions.ts',
    method: '$queryRaw',
    hash: 'e5904b160d247d3933516ced688b94c7769b81ba123b08bfb816d8a83addc6ae',
    policy: 'tenant-agent-outcome-source-provenance-lock',
  },
  // Machine V1 finalization shares exact identity/worker/credential authority
  // locks and checks all retained expiry values against post-lock database time.
  {
    file: 'packages/db/src/helpers/intake-v1-package-machine-authority.ts',
    method: '$queryRaw',
    hash: '466fa3cc0db23a3b88f3f7007be33e73a33cfd28720f6403dab3f6de34ad94e6',
    policy: 'tenant-intake-v1-package-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-package-machine-authority.ts',
    method: '$queryRaw',
    hash: '65a9e01ca737230678b0700b87b724af4de1e11e453cb65673cfc00afd10202b',
    policy: 'tenant-intake-v1-package-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-package-machine-authority.ts',
    method: '$queryRaw',
    hash: 'aeae117e9963cc1334c40fbe940451075ecab07921494bc98997bb934737257f',
    policy: 'tenant-intake-v1-package-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-package-machine-authority.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },
  // Exact immutable grant scope is locked before replay and a separate database
  // clock sample prevents authority from surviving expiration during a lock wait.
  {
    file: 'packages/db/src/helpers/approval-grants.ts',
    method: '$queryRaw',
    hash: 'c2c7db1d51af0ed92337b4995852b12032a3c00e69c57f64f748c19a49424223',
    policy: 'tenant-approval-grant-consumption-lock',
  },
  {
    file: 'packages/db/src/helpers/approval-grants.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },
  // Exact tenant-operation locks serialize immutable proposal/review replay;
  // source mapping holds the exact tenant+venue source row through projection.
  {
    file: 'packages/db/src/helpers/intake-source-mapping-review-actions.ts',
    method: '$executeRaw',
    hash: 'bfb6f758d0b92268d708d29ba3a632ea700b8ec162b0a1e64ddc46012a75671b',
    policy: 'tenant-intake-source-mapping-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-source-mapping-review-actions.ts',
    method: '$queryRaw',
    hash: 'ec529e098ed9b6a869685c1eb08a97b21687c399dc33e4743133bee371733bae',
    policy: 'tenant-intake-source-mapping-source-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-package-draft-proposal-actions.ts',
    method: '$executeRaw',
    hash: '969f4b326032d80274d75d4b5145d342870e4b05b3ba60f95237b69611d8a521',
    policy: 'tenant-intake-v1-package-proposal-operation-lock',
  },
  // Bounded internal discovery yields opaque IDs; claim locks the canonical source
  // before exact dispatch mutation. Receipt transitions lock exact tenant/venue rows,
  // use the post-lock database clock, and retain immutable member/run/hash scope.
  {
    file: 'packages/db/src/helpers/intake-v1-processing-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '7a2a36db16086e38e986b473a4681c9a8db52de1bb3342ec65e2ecf0b0df5aec',
    policy: 'platform-intake-v1-processing-discovery',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-processing-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '04b6d025360a303ba039f70c14852f62af38d595a824e7452e57d76c8989cfa2',
    policy: 'platform-intake-v1-source-lease',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-processing-dispatch-actions.ts',
    method: '$queryRaw',
    hash: 'a1369122a40b9d061924bb7cd33f7dac2c1278fc890303a270b4e345ec332683',
    policy: 'platform-intake-v1-source-lease',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-processing-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '9b1a314bedad8d1fb89be3a932b704ac562cf8495ea3b9141e9840586dc3e181',
    policy: 'tenant-intake-v1-processing-exact-lease',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-processing-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '12ac824e00b1e48d4f904be1aa2a0f4441b5db7ca2a4fa00b2e09ac4b00ad485',
    policy: 'tenant-intake-v1-processing-exact-lease',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-processing-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },

  // V1 uses READ COMMITTED: operation replay precedes current material reads.
  // Amendment locks exact owner/venue aggregate; bounded selected sources and
  // their scoped receipt rows stay SHARE-locked through immutable snapshot writes.
  {
    file: 'packages/db/src/helpers/intake-v1-submission-actions.ts',
    method: '$executeRaw',
    hash: '6d191475b0fd6dd5f56e5e85b837a67498ac245cabf14bdc8d0377a0649a37d6',
    policy: 'tenant-intake-v1-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-submission-actions.ts',
    method: '$queryRaw',
    hash: '474c35ad5c49c9666ffbc3df0691f3c32ef3eaceba38d3374bb6f9c36f8fc4ba',
    policy: 'tenant-intake-v1-owner-revision-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-submission-actions.ts',
    method: '$queryRaw',
    hash: '565578e189c0e5df7374d8da7f8c515b969329039e0e050df467e4a5418598e1',
    policy: 'tenant-intake-v1-selected-source-snapshot',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-submission-actions.ts',
    method: '$queryRaw',
    hash: '63b030e633418c27f17f3984e7ff0b30b0f87791c8044454875d33af6e48dc21',
    policy: 'tenant-intake-v1-selected-source-snapshot',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-submission-actions.ts',
    method: '$queryRaw',
    hash: 'f295f89e8de246ce3f99cb2e3d1082dbbc72c8cdcf605168cc337d501d9da302',
    policy: 'tenant-intake-v1-selected-source-snapshot',
  },
  // Exact tenant/operation replay is serialized before parent authority checks.
  // This grants no delegation authority; bound parents still require a live lease.
  // Parent and ancestor row locks fence cancellation with exact tenant+venue+run IDs.
  {
    file: 'packages/db/src/helpers/agent-delegation-actions.ts',
    method: '$queryRaw',
    hash: '96aa37a4aa208f76b23391db55eca095086b68f01a85e1a0253981a106deaa07',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-delegation-actions.ts',
    method: '$queryRaw',
    hash: 'd91c35addea1f6a15ccaa99669dd517a296e60f0d3d1e6265b8b7e6d2c2bc254',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-delegation-actions.ts',
    method: '$executeRaw',
    hash: 'f9b34b15bd77ea8df1b9751db50a427912d8a679cb2c869861dacf04636d2af4',
    policy: 'tenant-agent-delegation-operation-lock',
  },
  // Serialize immutable approval-request retries by exact tenant and operation UUID.
  // This lock grants no activation authority; canonical apply still checks approval.
  {
    file: 'packages/db/src/helpers/agent-workflow-activation-approval-requests.ts',
    method: '$executeRaw',
    hash: 'eb5d16c6a962a5f7484f72522cfa390740984f4d869601f29746efbeffafcba8',
    policy: 'tenant-workflow-approval-request-lock',
  },
  // Checkout reservation and result finalization share the exact tenant lock;
  // provider work remains outside both transactions.
  {
    file: 'packages/billing/src/service.ts',
    method: '$executeRaw',
    hash: '7b38aa25cd1def5b224727e4c592a17c80ad0ed7c2651152b5e6bcd9eff93264',
    policy: 'tenant-billing-effect-lock',
    count: 2,
  },
  // Reviewed workflow activation: sorted scoped heads precede exact leased runs;
  // SHARE-locked authority is rechecked with PostgreSQL time after locks. Revoke
  // touches only effective bindings of one scoped activation; clocks read no data.
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: '82699e7ac0ed8ab5c7c185f5a172fa8e17fcf973330fc8e1c1e2b67d27009d47',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: '4b92f5672746aa13786582e9916bd33a42f201517639607b9d136188c35573cc',
    policy: 'tenant-workflow-execution-lease',
  },
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: '7086af287fd812bcc8249640510fe18a0e63afce3c6a72848dd021c87ec815d4',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: '47ed31eefb6ae4cffb2461299c36659acdcf08ec834364dadf20725ea02effad',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: '96016eb58000a4a2f98fe91bf601e052fb9cf9770450e6c53c6c768f5626f80a',
    policy: 'tenant-workflow-execution-lease',
  },
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: '5090f953102fe80ae5c5102351db598a95fa21d6e3b2b3cc467a0c31e08d9739',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/agent-run-execution-actions.ts',
    method: '$queryRaw',
    hash: 'e1cdea708ae6e588875c34ce0d590300a395cef38ea0fe5df20c3e249a6b18f6',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-activation-actions.ts',
    method: '$queryRaw',
    hash: '36f9a1731ba9589cae5e734475d2123bfc5cae5fae3d83eb8f29a5e49e781ec0',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-activation-actions.ts',
    method: '$executeRaw',
    hash: 'd857e9c52d5df15c314f29e530d26311f067b741d1ca034f192180d6b1a3b7ff',
    policy: 'tenant-workflow-activation-revoke',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-promotion-assessment-actions.ts',
    method: '$queryRaw',
    hash: '516577282936e1ce33a4dda8ea9fdceba95974887691e3836a95678c3b7ab189',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-binding.ts',
    method: '$queryRaw',
    hash: 'e060f48e58c4b3a646b235175e35f7a9f051a8c8baa8ea75fa6fea980e1ba100',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-binding.ts',
    method: '$queryRaw',
    hash: '46269797090cef44dd9ad0a8889461022a9113836c5cea2cae7552e11eca7d02',
    policy: 'tenant-workflow-execution-lease',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-binding.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-lease.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-lease.ts',
    method: '$queryRaw',
    hash: '78d80b823c8d1599f99fe0a43a736a734e7e02c25aa2bc0064b1cd6d3b9cb78e',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-lease.ts',
    method: '$queryRaw',
    hash: '2355e0b6fb70275ad24b7c1ad687c8cacf646fef89976f60b34bcc9caee0ddb4',
    policy: 'tenant-workflow-execution-lease',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-lease.ts',
    method: '$queryRaw',
    hash: 'e31cc90439ba273289b5f87bdbf68e03e0581fa601afb106b7381523c7c560c8',
    policy: 'tenant-workflow-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-lease.ts',
    method: '$queryRaw',
    hash: '475d11139e965652f52e42fa44267a5d41c9c418614b2f9de2973f2003c02701',
    policy: 'tenant-workflow-authority-share-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-workflow-run-lease.ts',
    method: '$queryRaw',
    hash: '44296a1afaaf2c1ee40110d1edf9e267a591dd2b7f58f8532d4076e3dd869332',
    policy: 'tenant-workflow-authority-share-lock',
  },

  // Expiry reads and locks use exact question/run + tenant + venue scope. The
  // maintenance-only global discovery returns at most 400 due IDs; each candidate
  // is rechecked under run-before-question locks before any canonical mutation.
  ...[
    '89c052291c34fdf450c70ddf9768a7257df2032e1415ab94b99078571e5cbf50',
    'b19b9a954e9640377e6703143db1763e3aae6676e218d564f345460134eb5155',
    'd0899a9a28fbf80bd8e8f0a3269480c95c3d57ba32c8c9e73cc962be7e65afa6',
    '5c1cf2f7068b6c5fbbbfeb1de7953950036972077dc12e082cd59d1dfcd5aa39',
    '304879535e5a827827ae47f48da3fe6c97dba2125ad97cae34eedb840ba82234',
    'f238aa770dd1e06b16b78a88bc3de7a67389bff06731e5414b64be944364ece8',
  ].map((hash) => ({
    file: 'packages/db/src/helpers/agent-question-expiration-actions.ts',
    method: '$queryRaw',
    hash,
    policy: 'tenant-and-venue',
  })),
  {
    file: 'packages/db/src/helpers/agent-question-expiration-actions.ts',
    method: '$queryRaw',
    hash: '661cfc305660418646f172fb820658fc5fa03eba5005d8fb3b86eb8bf2650760',
    policy: 'platform-due-agent-question-discovery',
  },
  // Initial client resumption and exact replay serialize the scoped run and read
  // cancellation intent before determining whether remaining blockers permit work.
  ...[
    '6e9121087729ce13c540262ef95dbe26a73d4acf7513509304fd23f3b0f7e1ab',
    '2f8d286d17e0e4c25ccee1dd5040d6ee13a39e04022171900bc970aea0692768',
  ].map((hash) => ({
    file: 'packages/db/src/helpers/onboarding-question-actions.ts',
    method: '$queryRaw',
    hash,
    policy: 'tenant-and-venue',
  })),
  // Serialize question creation/resolution on the exact tenant+venue run so
  // simultaneous final answers cannot strand an otherwise resumable run.
  {
    file: 'packages/db/src/helpers/agent-question-actions.ts',
    method: '$queryRaw',
    hash: '1df6ea64e4eec249ead41436d458f0e4c30ac605ee3b18f0702f9b51add6a27a',
    policy: 'tenant-and-venue',
  },
  // Exact tenant/operation replay is serialized before creating or resolving a
  // question, so concurrent retries retain one immutable question outcome.
  {
    file: 'packages/db/src/helpers/agent-question-actions.ts',
    method: '$executeRaw',
    hash: '1ca95f06f2d57599907e39d171d2b5eb0185396c0fbcfdfc72417c47de4168fb',
    policy: 'tenant-agent-question-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-question-actions.ts',
    method: '$queryRaw',
    hash: '9719ce3dac8ab21ca2d891e58ac74e3aa020bd9d5cad8d41fd23c66422291323',
    policy: 'tenant-and-venue',
  },
  // Compact temporal review receipts serialize one tenant request, lock the exact current
  // tenant+venue+project generation, and retain only source rows from that scoped project.
  {
    file: 'packages/api/src/lib/media-temporal-review-service.ts',
    method: '$executeRaw',
    hash: 'ffa3be9ceadb182b9c4dd6d21ae60b7fa586eb9a8951cb15427cabefc4861e15',
    policy: 'tenant-media-temporal-request-lock',
  },
  ...[
    '364897d03a112883c8ef9ac72214842fed1d7de44053dfc2cfe9b0fde2313ad6',
    '4292d8fc0cc921fe8e03abd50990e32f3cccb13f0a5970c4b85b2db5b1622e42',
  ].map((hash) => ({
    file: 'packages/api/src/lib/media-temporal-review-service.ts',
    method: '$queryRaw',
    hash,
    policy: 'tenant-venue-revision-source',
  })),
  // Reviewed relation application: exact request replay, scoped revision/source reads,
  // and a transaction lock fence one tenant+venue canonical inactive draft.
  ...[
    ['b627491e5b8425d8eb591069bf62585da275a87cd54f603024cb1844ab0be929', '$executeRaw'],
    ['0c6d1caaeb6d5dfbf70100c6e396f4e1e173b716cfcf847483d3c9d679d44105', '$queryRaw'],
    ['218a6f246feaac82d923756927fb740d0c7af42fd765cee64d2f9b6f396de03e', '$queryRaw'],
    ['40c98988471c833ed0b8ac3c23afc156176474c53e8cdc81201853255fd65d8f', '$queryRaw'],
    ['45a70a947acc0b88bec8571a4acfb5b18b42842a88bad8de8413e9b73702b1d9', '$queryRaw'],
    ['555774db49c3c795f2c23b3c062685357a6a97cb6d9dd637d91a9480afae2d06', '$queryRaw'],
    ['8578a5f4879bfff11a6977fc6b40ee6cdbc502a60f867f73ed882dbac0fbc1cc', '$queryRaw'],
    ['bd160997d939f10173fe6f64c40b4c1b6e25a60ba33481ad483f0ba47d85ae32', '$queryRaw'],
    ['ea272b8468ec7204808150792da482777988e0206256d6ff3a5e20b028d2e8a7', '$queryRaw'],
  ].map(([hash, method]) => ({
    file: 'packages/api/src/lib/media-relation-application-service.ts',
    method,
    hash,
    policy:
      method === '$executeRaw'
        ? 'tenant-venue-content-mutation-lock'
        : 'tenant-venue-revision-source',
  })),
  {
    file: 'packages/api/src/lib/media-temporal-review.ts',
    method: '$queryRaw',
    hash: '80f9460a454d56ce1304b770a18a86b5128ed59a3d13646d8e78c9ed145389f1',
    policy: 'tenant-venue-revision-source',
  },
  ...[
    '094b270122668dfd13b2f63a7fcb0bbc20aec66cd951bd9deef04dcd06b10038',
    '4c5e89a67cc067eb5da334883f56c24a2240b2e59267479a6a458d8d939a1b12',
    'aa1860d6671c060c3f4d7028e57b25a7bc7cf4e28fbac8202b525a366e0283f2',
    'fb3e50a1d03f5a741c2b7b9f76aeb8be2d6ab3173042b671f9069d219057ec46',
  ].map((hash) => ({
    file: 'packages/api/src/lib/media-relation-route-loader.ts',
    method: '$queryRaw',
    hash,
    policy: 'tenant-venue-revision-source',
  })),
  // Reviewed identity ledger: tenant-wide request replay checks exact input+actor hash;
  // project/generation row locks and source hashes fence every new immutable revision.
  {
    file: 'packages/api/src/lib/media-resolution-service.ts',
    method: '$executeRaw',
    hash: 'f04dbe5b35ba6b83006c1a06beecf695cbab2ea49f02fc0a8158411725182fd6',
    policy: 'tenant-media-identity-request-lock',
  },
  {
    file: 'packages/api/src/lib/media-resolution-service.ts',
    method: '$queryRaw',
    hash: 'f9150aa473bef501a5120aec080cbcffe3c33f2640751d8d2eb8cb1eb4fbfe86',
    policy: 'tenant-media-identity-exact-receipt',
  },
  {
    file: 'packages/api/src/lib/media-resolution-service.ts',
    method: '$queryRaw',
    hash: '4873d82c5b58bbfc8d385b5d10355eef6b82795d50c1b349150544ebc07d4858',
    policy: 'tenant-media-identity-exact-receipt',
  },
  {
    file: 'packages/api/src/lib/media-resolution-service.ts',
    method: '$queryRaw',
    hash: '932a9adea7500915f17755d2b4b47783c3c714d7da886a72270670568e52db27',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/api/src/lib/media-resolution-service.ts',
    method: '$queryRaw',
    hash: 'c641196769779465e9f36622a1ab2c7bb35f012b7eb66c2fd619beffb1d893f0',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/api/src/lib/media-resolution-service.ts',
    method: '$queryRaw',
    hash: '767bbb2da1c9ea66a6637812b1f0b29cc293b002e6bd1d00da7c997f88c2a024',
    policy: 'tenant-media-project-source-lock',
  },
  {
    file: 'packages/api/src/lib/media-resolution-service.ts',
    method: '$queryRaw',
    hash: '336c5118208bd5dab565a796804e6aad38aabd7691c74d04345df58c165e6d6f',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/api/src/routers/admin/media-ingestion-resolution.ts',
    method: '$queryRaw',
    hash: 'cb1cea67ccfb589572408255efb6995c098ae8b9a08645328d04fcc640779519',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/api/src/lib/media-intake-handoff-service.ts',
    method: '$queryRaw',
    hash: '19b46d35139a3cfaf644efbc6f9b2980f9910d3cc163b2dc69c7a14e71f20c73',
    policy: 'tenant-venue-revision-source',
  },

  // Reviewed canonical media handoff and legacy adoption: exact scoped receipts,
  // transaction locks, and bounded metadata reads excluding large media snapshots.
  {
    file: 'packages/api/src/lib/legacy-knowledge-adoption-service.ts',
    method: '$executeRaw',
    hash: '5ca1c7f89ae929c4cea16ff527a04b8d124ad0af2797ac3dd52c5bdd62f6eabb',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/api/src/lib/legacy-knowledge-adoption-service.ts',
    method: '$queryRaw',
    hash: '4de97d6f2aa6c63290ea8d36d386adc8dac2decefcf78d6ba90f079a5030abf8',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/api/src/lib/media-intake-handoff-service.ts',
    method: '$executeRaw',
    hash: '5598666b25b310169d74eefba5f79ecbf981d0c88b29347cd4e0ac52aa9f005e',
    policy: 'tenant-intake-proposal-request-lock',
  },
  {
    file: 'packages/api/src/lib/media-intake-handoff-service.ts',
    method: '$queryRaw',
    hash: '7dd3562c8d5b1ad58e70358d8d9e9271dea90b042066687a5450487cb63c0007',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/api/src/lib/media-intake-handoff-service.ts',
    method: '$queryRaw',
    hash: '8c79ad7491613a903db3f120c58da90d6dfdd4e68fa0572b4b8e3045b54e4530',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/intake-actions.ts',
    method: '$queryRaw',
    hash: 'c534db8c52d4a5d5808d3389bda56b54886b55d5520b245dfe0a1444372609ae',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/onboarding-bootstrap-actions.ts',
    method: '$queryRaw',
    hash: '81a8946c8cdc85cbf0ffcc10d7513c09a994e58eb6b0a4a9f535c7d8be762f2d',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/onboarding-bootstrap-actions.ts',
    method: '$queryRaw',
    hash: 'c0e3460f24ed42fdc8dbae7b23923f8af30044153a8d711e8da0ef221671f197',
    policy: 'tenant-and-venue',
  },

  {
    file: 'packages/billing/src/service.ts',
    method: '$executeRaw',
    hash: 'bf3421dfb1b691819b8baed107ec5de13a07d17407153a1b3738a8b12e631d00',
    policy: 'tenant-billing-effect-lock',
  },
  {
    file: 'packages/db/src/helpers/prospect-inbound-reply-review-actions.ts',
    method: '$executeRaw',
    hash: '571cc6b90febeeadd6a856c15b82e0397952b20c374d77b1e589910e8327d252',
    policy: 'platform-prospect-inbound-reply-review-lock',
  },
  {
    file: 'packages/api/src/lib/intake-file-clarifications.ts',
    method: '$executeRaw',
    hash: 'ad270206ff0271c0cc33994929056409b9aabb3bd4cabceae9ec3cbb4f98caac',
    policy: 'tenant-intake-file-extraction-review-lock',
  },
  {
    file: 'packages/api/src/lib/intake-interview-clarifications.ts',
    method: '$executeRaw',
    hash: 'c28bc4427cf5a42191d2e901c3a0e4ce6e36c3bce09c8f3a108751db7bdb019b',
    policy: 'tenant-intake-interview-clarification-resolution-lock',
  },
  {
    file: 'packages/db/src/helpers/agent-question-actions.ts',
    method: '$executeRaw',
    hash: '9f523bcda2b4316a85a39f6165c597b1cf238f8d62f4496b8776867538f4c86b',
    policy: 'tenant-intake-file-extraction-review-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-file-extraction-review-actions.ts',
    method: '$executeRaw',
    hash: 'ad270206ff0271c0cc33994929056409b9aabb3bd4cabceae9ec3cbb4f98caac',
    policy: 'tenant-intake-file-extraction-review-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-file-extraction-actions.ts',
    method: '$executeRaw',
    hash: '1b537add52a7e067453bc3d075c4bd9caf9a6a6702e146f6493231b40dc64a10',
    policy: 'tenant-intake-file-extraction-lock',
  },
  // File-extraction workers discover bounded opaque dispatch IDs, then lock the
  // immutable upload and exact dispatch before validating the scoped lease.
  {
    file: 'packages/db/src/helpers/intake-v1-file-extraction-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '498eafbaec739130949bf88d5a4479096f1d3db9f871665424d30de503ab1205',
    policy: 'platform-intake-v1-file-extraction-discovery',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-file-extraction-dispatch-actions.ts',
    method: '$queryRaw',
    hash: 'e48c5a59da51066ef897ab6a3446b522ad69e951c915ec8fcce277cb138b0831',
    policy: 'tenant-intake-file-extraction-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-file-extraction-dispatch-actions.ts',
    method: '$queryRaw',
    hash: 'c071b70fe93232e12c50af37d6def83122eb164f8f7952b2074ab5db950c1676',
    policy: 'tenant-intake-file-extraction-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-v1-file-extraction-dispatch-actions.ts',
    method: '$queryRaw',
    hash: '2bdaff0ca21dc3c8f7781fbdc754ed2e7ccdc49d18c986e8d64ff949d680b114',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/intake-website-research-actions.ts',
    method: '$executeRaw',
    hash: '0fd09329fbefc35b5e37e2277ea7e3f4b4bcba971e6d3e3ecd16bc133b8dcbe8',
    policy: 'tenant-intake-website-research-lock',
  },
  {
    file: 'packages/db/src/helpers/prospect-send-outbox-actions.ts',
    method: '$queryRaw',
    hash: '9908635032ded233ca16520ef8d6a5e2d0237d8cddea0c1a0d540a7d36659560',
    policy: 'platform-prospect-mailbox-send-reservation-lock',
  },
  {
    file: 'packages/db/src/helpers/prospect-send-outbox-actions.ts',
    method: '$queryRaw',
    hash: 'b5099aba3a4cc0141790ce821a68b7a40f61c0fd705282b380427480301eb6fc',
    policy: 'platform-prospect-campaign-send-reservation-lock',
  },
  {
    file: 'packages/db/src/helpers/universal-content-publication-actions.ts',
    method: '$queryRaw',
    hash: '6ca3fda67d8916a7bb39fcb8dce89f5e51ea5b3c8010980ef9dfde622b0f8206',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/venue-package-semantic-duplicates.ts',
    method: '$queryRaw',
    hash: 'ec62a926017b4a92b557826492c23c69ca0dca7939eb44c81c54eb3cb29b4336',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/venue-package-semantic-duplicates.ts',
    method: '$queryRaw',
    hash: '2752c8221f7086e6d85a223b7cda5db7ca956d3a25f40dccbbb5580c38b6d1c4',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/venue-package-semantic-duplicates.ts',
    method: '$queryRaw',
    hash: '5c5c0997e54f1b14fdf172b7d5b7b1801034b84c0e02bb3acd3f05141ed351bc',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/venue-content-lock.ts',
    method: '$executeRaw',
    hash: 'daa2dc53e993865ebc671cc1dee04d1085ea1fbf70f976b84a024176f5e4b785',
    policy: 'tenant-venue-report-mutation-lock',
  },
  {
    file: 'packages/db/src/helpers/venue-content-lock.ts',
    method: '$executeRaw',
    hash: '7b8ca4a6794c0a66b50f6096cb4eca5ed1930726090adfc8c90126ad74693adf',
    policy: 'tenant-venue-content-mutation-lock',
  },
  {
    file: 'packages/db/src/helpers/venue-content-lock.ts',
    method: '$executeRaw',
    hash: 'd75c7b3a8cb2ab2686d582a8007e702694bf8a1da158d671f801631a0d6f6617',
    policy: 'tenant-guest-chat-turn-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: '847fa7ac679ecfb036d7bf675f4eb6da381e3f183487b3601d402f68b690ec45',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: 'f28fd9aa5617bff72b76ee6b4a651e3a5c486a8a44a96500361d71c103fd3fd3',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: '9ccd41762a4ccb60ee4e28199bef30cfef8fb0ae10b6c4c2a445e032cc62b356',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: '175d67ebe56f69da7dec92181e81611dcee0cc452aa119869916131addc3e7c0',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: 'cd5bb9920d3a963f06d894c51a04cda1c2b3baa759ee5c8e5275c16b0af49a94',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: '7431972afdc1ba30a8e8e22f53931236195fd7878538c3e588fc8d994107d69c',
    policy: 'transaction-content-history-context',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$executeRaw',
    hash: 'daa2dc53e993865ebc671cc1dee04d1085ea1fbf70f976b84a024176f5e4b785',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$queryRaw',
    hash: '2679d81ae1880a220185b63a111b458048e20db8c2648b236dd7e742ad41e42f',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$queryRaw',
    hash: '49ae29957c480c5f3f70af0ea124cb2e022f59d89cbd4c70143979129e2a0812',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$queryRaw',
    hash: '2e827b7734fc4c676c8316a0e7a5eda20c940d74f63b1d3cb41ed1e006ed4edf',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/content-version-context.ts',
    method: '$queryRaw',
    hash: 'e9b9f6cfa56e3e8b0b2f2af1a7e6757e4b20d6aaa8aead46abb844fb73fc138f',
    policy: 'tenant-content-history-entity-lock',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: 'ced88be1d97236cb5813ebb32caacb3b4939f20a4ab0368835f9846ac019c635',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: '3e0a4da968b3cefbecee1942ee0fcdde47a2e8242bcf62e441db3fd29fde315c',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: '68e27cda94ba3c6e1c7007b6dbb4f47ba0eaa3fe543ee1dbc6fb8fff4efa0a39',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: '09469ab3b7115c4b6390e19b5386407bf48491670664129ef00a87600f68d254',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: 'e299e9f7bab197669aa91d392996a7936d507317d7b6a0a0303e5610bbd75bda',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$queryRaw',
    hash: 'd2c558ce20afed52b4b8c3935b1a940e982f6885451c898a91a09dcc33f1100b',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/embedding-claim-repair.ts',
    method: '$executeRaw',
    hash: '0ab4f9519b6ea989e9401086deb53e137ddc377ca51b3280a812a3062ddbd63a',
    policy: 'tenant-venue-exact-invariant-repair',
  },
  {
    file: 'packages/db/src/helpers/health.ts',
    method: '$queryRaw',
    hash: '1730fc082ddaf286020215008c78754a2d980d4e7aefc39e339c6684fca76e7c',
    policy: 'system-probe',
  },
  {
    file: 'packages/db/src/helpers/operational-health.ts',
    method: '$queryRaw',
    hash: 'f3213179c524faf7a45f25668f8e8ea8066b50a4f716a18ca8208a098c3f5a76',
    policy: 'system-probe',
  },
  {
    file: 'packages/api/src/routers/analytics.ts',
    method: '$queryRaw',
    hash: '46303d6622b41aff5fc44f7d2d9201ba9b6cfada52486596296c0ce5784a8056',
    policy: 'public-venue-id',
  },
  // Public chat bootstrap is exact-venue scoped; slug and presentation/photo toggles do not grant
  // tenant discovery or media approval authority.
  {
    file: 'packages/api/src/routers/chat.ts',
    method: '$queryRaw',
    hash: '0ff40061b6629a12113dd50a970a6a4188af21409137ff429984df9c2ed2bd2d',
    policy: 'public-venue-id',
  },
  {
    file: 'packages/api/src/routers/chat.ts',
    method: '$queryRaw',
    hash: '10d43fc1b577cb2d44e86cdf5259dfb5fa1190447ef037c8e861b5a1204d7ea1',
    policy: 'public-venue-id',
  },
  {
    file: 'packages/api/src/routers/chat.ts',
    method: '$queryRaw',
    hash: '9f933fbd0e5d46ac945b7ff5e17c64a15aeba8272d768ec3b45266b71f3acb80',
    policy: 'public-venue-session-token',
  },
  {
    file: 'packages/api/src/routers/venue.ts',
    method: '$queryRaw',
    hash: 'cffc7451aea5e65d6206c8818bd2fa09bfd43cee708ede3cb002892911a2032d',
    policy: 'public-venue-slug',
  },
  {
    file: 'packages/api/src/routers/venue.ts',
    method: '$queryRaw',
    hash: 'da288dfe334d78f79e062fec93723952542dce7973344f6956cd2eaef5eecc74',
    policy: 'public-venue-slug',
  },
  {
    file: 'packages/api/src/lib/venue-media-delivery.ts',
    method: '$queryRaw',
    hash: 'cf59d6bd3dcfc1cdbfe9c89d11cfd2a3153ee394dec67acfb9cbda1cda8e6abf',
    policy: 'public-venue-slug',
  },
  {
    file: 'packages/db/src/helpers/venue-create-action.ts',
    method: '$executeRaw',
    hash: '19f67dc59cfb8f7262bda219dc7c9d2feb4c8fd354150f439951d87e57faeca6',
    policy: 'tenant-venue-create-slug-lock',
  },
  {
    file: 'packages/db/src/helpers/client-account-actions.ts',
    method: '$executeRaw',
    hash: '3b698ad7e37449be6a1e831d34591b41ae1793f5ec22e27edd7151054aea45bc',
    policy: 'platform-client-create-id-lock',
  },
  {
    file: 'packages/db/src/helpers/client-create-intents.ts',
    method: '$executeRaw',
    hash: 'd318aa1b435d868e28ec324666fd4d5b38d72f2e0a3f05345ef16668b40bdb8c',
    policy: 'platform-client-create-request-lock',
  },
  {
    file: 'packages/db/src/helpers/client-assistant-actions.ts',
    method: '$executeRaw',
    hash: '135a8e6d63e3251cfdfbb93039d71765b93df8616bc4c69834bb703059d48102',
    policy: 'tenant-client-assistant-preference-lock',
  },
  {
    file: 'packages/db/src/helpers/client-assistant-actions.ts',
    method: '$executeRaw',
    hash: 'aab87d4ab8def8235dad05fc3557a4dbcc06ccdc58ce24665dd20b7efcf7ff7d',
    policy: 'tenant-client-assistant-turn-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/client-assistant-actions.ts',
    method: '$executeRaw',
    hash: '74375b322125ec3f8ff9d4bfde1297929c803fb1e00ce961d8715f87507b23fb',
    policy: 'tenant-client-assistant-thread-lock',
  },
  {
    file: 'packages/db/src/helpers/client-assistant-actions.ts',
    method: '$executeRaw',
    hash: '2b3420bcae3577afe8fcc8b31920d568595ddf6a40f9fbb59c2e622fb2db22b1',
    policy: 'tenant-client-assistant-generation-lock',
  },
  {
    file: 'packages/db/src/helpers/client-assistant-actions.ts',
    method: '$executeRaw',
    hash: '4398ffabbd421422d0628e8cc9f762e3b6b46ef016916604efef1b13b6aa28b2',
    policy: 'tenant-client-assistant-completion-lock',
  },
  {
    file: 'packages/db/src/helpers/client-assistant-actions.ts',
    method: '$executeRaw',
    hash: 'da919fd2aa26f6f73b82c4cfcce5a7d6db8ba51998196aca48ff5aa40cb675ad',
    policy: 'tenant-client-assistant-handoff-lock',
  },
  {
    file: 'packages/db/src/helpers/customer-access-execution-actions.ts',
    method: '$executeRaw',
    hash: 'cac8f03557d08d95fc8b2642544c804de72cbeab1e60dddc5ac4fe81a56015bd',
    policy: 'tenant-customer-access-request-lock',
  },
  {
    file: 'packages/db/src/helpers/first-week-account-reviews.ts',
    method: '$executeRaw',
    hash: '0188079f60cc9ec225e98669674c3812e1c034006b1f85cbf00f1a1f6eae9e2f',
    policy: 'tenant-first-week-review-lock',
  },
  {
    file: 'packages/db/src/helpers/offboarding-plan-actions.ts',
    method: '$executeRaw',
    hash: '211bb4b0b718d6cecab4a4c0a7268098075d7fa68cb01b3d19b5207dfa5a915d',
    policy: 'tenant-offboarding-request-lock',
  },
  {
    file: 'packages/db/src/helpers/native-venue-deployment-actions.ts',
    method: '$queryRaw',
    hash: 'a1306f1dfc78039c6bab6a6793310ecd57ef79b270ef6d457f8c02ac61baaef1',
    policy: 'tenant-and-venue',
  },
  // Lock the exact candidate after external export verification and before publication.
  {
    file: 'packages/db/src/helpers/native-venue-deployment-actions.ts',
    method: '$queryRaw',
    hash: '8b0e0b2e254ba4f29cf816dcad50e38cf3ba8b9ca379661e9eeea9ff802068bb',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/onboarding-bootstrap-actions.ts',
    method: '$executeRaw',
    hash: '5ee40398a3024504c858f238560e4cdf3f1a30d0a7b855cb621a3d8414314b60',
    policy: 'tenant-onboarding-request-lock',
  },
  {
    file: 'packages/db/src/helpers/onboarding-bootstrap-actions.ts',
    method: '$executeRaw',
    hash: '9ec9ca659853101e04b88da0b648f6244f3ebb97dbfd3d110ef695db80c408db',
    policy: 'tenant-onboarding-venue-slug-lock',
  },
  {
    file: 'packages/db/src/helpers/onboarding-question-actions.ts',
    method: '$executeRaw',
    hash: '2ee70d40bc4f79f0f0d02d0f28c74f6a0a7d9882394cf929d00d3063208bbb17',
    policy: 'tenant-onboarding-question-lock',
  },
  {
    file: 'packages/db/src/helpers/onboarding-question-actions.ts',
    method: '$executeRaw',
    hash: 'c6a29ed10894781357d4f4220aae129bb0e597db6111772bf4e89aeb21329fcf',
    policy: 'tenant-onboarding-question-resume-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-upload-actions.ts',
    method: '$executeRaw',
    hash: '38c3506f295d7ee11b73d6bc224e1cdabb77d34e0edd4d6479fb573d1ee78b1d',
    policy: 'tenant-intake-upload-request-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-upload-actions.ts',
    method: '$executeRaw',
    hash: 'a8cdc500a0d333fc87298ecf342ebb9cc2514071fdd688b13708d2660c31b877',
    policy: 'tenant-intake-upload-quota-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-upload-actions.ts',
    method: '$executeRaw',
    hash: '14558cd28b5584b17dcaa50eefc4a6639f974e410fd9accaf2ec0217ffdfb98b',
    policy: 'tenant-intake-upload-record-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-upload-actions.ts',
    method: '$executeRaw',
    hash: 'a50b4d4684fda38829f56ae749ac8e3ea508124c144d3c09b22d42f1fbc559d6',
    policy: 'tenant-intake-upload-multipart-lock',
  },
  {
    file: 'packages/db/src/helpers/intake-actions.ts',
    method: '$executeRaw',
    hash: '04e05445d3d8fb4c72e1cc6deff3821fc6eaa7a66274d9be4c5fcecb9f304150',
    policy: 'tenant-intake-proposal-request-lock',
  },
  {
    file: 'packages/db/src/helpers/support-actions.ts',
    method: '$executeRaw',
    hash: 'ac9bd70473f28cfc680e3d8c842f5832c202258671e8d5ecd9162e74758ee3ea',
    policy: 'tenant-support-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/support-request-lock.ts',
    method: '$executeRaw',
    hash: '9a55ebe92ba434f21b836c16d41ce54bd9c7c28b8f0b4f2bf6b7d10cc26963f9',
    policy: 'tenant-support-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/support-participant-actions.ts',
    method: '$executeRaw',
    hash: '22fdd4471306219d371c62e8c50eda90105555479bd2c322b8668bced4d8e70c',
    policy: 'tenant-support-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/support-agent-run-lineage.ts',
    method: '$executeRaw',
    hash: '116b78a643ec8c5c693f15573037538304f5d1ae2691cb835256f4e6f853b13d',
    policy: 'tenant-support-agent-run-operation-lock',
  },
  {
    file: 'packages/db/src/helpers/support-agent-run-lineage.ts',
    method: '$executeRaw',
    hash: '22fdd4471306219d371c62e8c50eda90105555479bd2c322b8668bced4d8e70c',
    policy: 'tenant-support-request-lineage-lock',
  },
  {
    file: 'packages/db/src/helpers/embedding-dispatches.ts',
    method: '$queryRaw',
    hash: 'a925e18ada96c0708399943037bf1131d99e9debefa92a74b8300a24b84a4b93',
    policy: 'platform-dispatch-lease',
  },
  {
    file: 'packages/db/src/helpers/embedding-dispatches.ts',
    method: '$executeRaw',
    hash: '34a9f3a5858c7cdddfcf5741a8eb74e56bd42611ba5ec0750b464baca2d1ae71',
    policy: 'tenant-venue-revision-lease',
  },
  {
    file: 'apps/workers/src/lib/embedding-freshness.ts',
    method: '$queryRaw',
    hash: '5f63160357e15ccea6e9a0572be64daa8ede1ba29f6c061eb4e5651bc714297a',
    policy: 'tenant-optional-venue-cursor-audit',
  },
  {
    file: 'apps/workers/src/lib/embedding-freshness.ts',
    method: '$queryRaw',
    hash: 'ef7a4ce0b2e86b9128ffcd478352c60ffcc2e6ef4730e1b653de4f8ecf8be408',
    policy: 'tenant-optional-venue-cursor-audit',
  },
  {
    file: 'packages/db/src/helpers/embedding-freshness-canary.ts',
    method: '$executeRaw',
    hash: '1de2f3c55a4f758efa80db716662a1d3f72702c21dfb88c81ddd92fa159c5b77',
    policy: 'tenant-venue-revision-canary-insert',
  },
  {
    file: 'packages/db/src/helpers/embedding-freshness-canary.ts',
    method: '$executeRaw',
    hash: '38ffe9c2bb013165ca00df8197f324134f35bc57bd907a42f8868523bf6e2cd9',
    policy: 'tenant-venue-revision-canary-insert',
  },
  {
    file: 'packages/db/src/helpers/embedding-work-claims.ts',
    method: '$queryRaw',
    hash: '1f0ad38f8215a2f31f3be7ba79e0bc9a747393876618b5c753c9d1924b4e55fc',
    policy: 'tenant-venue-entity-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: 'a917f2b20dda562ab47f4bf99199196840072890bafa9a9b837b1b7e1adfce12',
    policy: 'tenant-venue-range-generation-dispatch-consume',
  },
  {
    file: 'packages/db/src/helpers/generation-recovery.ts',
    method: '$queryRaw',
    hash: 'd8d5dc88ee097448c22246158d2595357932f583c571d91aa9224244249827ed',
    policy: 'platform-expired-generation-discovery',
  },
  {
    file: 'packages/db/src/helpers/voice-session-recovery.ts',
    method: '$queryRaw',
    hash: 'd1b6e1f4a302ba10b883dd5495008ee10ff02e6eb8b4c62c401e1a5ea8f45975',
    policy: 'platform-expired-voice-session-recovery',
  },
  {
    file: 'packages/db/src/helpers/generation-recovery.ts',
    method: '$queryRaw',
    hash: '1d2474f8b0dc709ce3b1f040861aeeaf734d61955bb842dbb9a4098389167d41',
    policy: 'platform-expired-generation-discovery',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: 'd3259ba2ce1e08660a5dc30e7378baf9cde5ad7e18608b72dbff42b5134efe82',
    policy: 'tenant-venue-range-generation-dispatch-consume',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '47e430bcf4bf1b655a8a6aafc6d54833eaede4cdd668cf39545174f4b25250a5',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '58e08dbc39ff44dea12c780ca1cba56b147b66ff3513c0b4dac0a7d5131ae14b',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '02fd8db6260eb21d7c0909d43c58c92cf7baf51a7369f0bd8201ee8e49bcae32',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '0a65595d7250a65e3d5a51d002f0d91f0a816834ea89c85a29b79ffd3a4402e1',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '7109c8ace2427545375fc14b8923de1f520e5d9df6c657c1d53257d4d353128d',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: 'e6d37a7a7452145e1b77c7b787342abcae11c1911d3739c347f6a4607a0043f3',
    policy: 'tenant-venue-range-generation-lease',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: '7bb04955ee2a6c98de035fa23b2ba57b09e2ce287d9c2297731207afa521f993',
    policy: 'tenant-venue-range-answer-analysis-lease-renew',
  },
  {
    file: 'packages/db/src/helpers/generation-execution-claims.ts',
    method: '$executeRaw',
    hash: 'a99d0289e70f9cf5284f6b52ad599ed460a7353d5fd7900381fcec9ded9a5239',
    policy: 'tenant-venue-range-weekly-report-lease-renew',
  },
  {
    file: 'packages/db/src/helpers/generation-request-dispatches.ts',
    method: '$queryRaw',
    hash: '6b23c58927c22c4cfe1b81a9be4fa1376d3a9a9be2b0204c13492f44e526c071',
    policy: 'platform-generation-dispatch-lease',
  },
  ...[
    '6bb900882644e8bf41e1cc7f23ca66f52c2846caa7b820013bc76aee22d59bad',
    '73c658b1642ca6816f76e7d96ce26710da19709e7357faec1e301044905a9d2d',
    '959b0f199065e8791a348a79973d260ac0a058c970986fc085445e0fcd905f08',
    'a10b854673a1e54550ab850c8890963a38ad1b3949e0c72d2641946546650ff8',
    'e41a8be47a563338f25f7030cab02bae22ecf6b5e70bc86b498b1a149698a603',
    'e9750a92b9237076ced2fb1732875f9da4ba80c84f301804114b5ac16d705e24',
    'f405fd6f8d927d39541e5e820ea14f124b83d80a584fcbdf5f6bc2923498a432',
  ].map((hash) => ({
    file: 'packages/db/src/helpers/generation-request-dispatches.ts',
    method: '$executeRaw',
    hash,
    policy: 'tenant-venue-record-generation-dispatch-lease',
  })),
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$queryRaw',
    hash: 'a6719fdd8a8d63e206a4a7740f1b318841ec3bae33b60812ac37b6204873f191',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$queryRaw',
    hash: 'b93628be655f43adc46abaca11768486f41412e2f92198437ee07d658675aa92',
    policy: 'permission-filtered-record-id-set',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$executeRaw',
    hash: 'fa8acf3d6b5e28dfa8611f61c4c80432d6e87b1fd62a33410fee2d2a45931fdf',
    policy: 'tenant-venue-entity-lease',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$executeRaw',
    hash: 'a074100896e870e6222c82cc1777a4e5682cb63e58de6601f6e1e1041d3851e8',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$queryRaw',
    hash: 'afa1d9a5c2b9bf70adf8eb6569e9ad01c918266aaf82efe861dbbed52c4d5ab8',
    policy: 'tenant-and-venue',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$executeRaw',
    hash: '62067bac1ff9fc9bdb241f6d57cc1087edcdd7b8b7b981684fd767c158f0b2a3',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/db/src/helpers/semantic-search.ts',
    method: '$executeRaw',
    hash: '8aaa4d066a819127d3760716ec372c0e42c64e8eb3a7d39649b75a386557f2bb',
    policy: 'tenant-venue-revision-source',
  },
  {
    file: 'packages/api/src/routers/feedback.ts',
    method: '$queryRaw',
    hash: '25b4134eb0bafbff40ded71be120dd4926af3c53a70857dd5a7698defdd35026',
    policy: 'public-venue-session-token',
  },
  {
    file: 'packages/api/src/routers/location-public-scope.ts',
    method: '$queryRaw',
    hash: '6861d67dbba1a0831a9f7d62730e387416e47a06caa1c1a7acee11f145f029ad',
    policy: 'public-venue-session-token',
  },
  {
    file: 'packages/api/src/routers/voice.ts',
    method: '$executeRaw',
    hash: '4a88ffd044aff187c68868de6333be95795afed26f5256b4df67a55ab050120d',
    policy: 'tenant-venue-voice-quota-lock',
  },
  {
    file: 'packages/api/src/routers/voice.ts',
    method: '$queryRaw',
    // Same public session-token/venue join; includes current server photo/link policy.
    hash: '8db9374c8142930b79f5f20fd00d554105c96ebc45c546b7e0f450c95b30def6',
    policy: 'public-venue-session-token',
  },
  {
    file: 'packages/api/src/routers/widget.ts',
    method: '$queryRaw',
    hash: 'c459b550f7fb55a4454ca8c33f8959b27c97bfe844e3c99d37a980f5df913d58',
    policy: 'public-venue-slug',
  },
]

const approvedEffectOverrides = new Map([
  [
    [
      'packages/db/src/helpers/guest-conversation-disposition.ts',
      '$queryRaw',
      '14cfaf856908a0df009aa382947fe2babf7add6903a7d9d88916bf5c7607df31',
    ].join('\0'),
    'write',
  ],
  [
    [
      'packages/db/src/helpers/guest-conversation-disposition.ts',
      '$queryRaw',
      'd25f2735654dbdd63ee62b92f7d5c89cd5f0baba888068b173e32779989b2006',
    ].join('\0'),
    'read',
  ],
])
const rawSqlEffects = new Set(['read', 'write'])

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)))
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute)
  }
  return files
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/')
}

function isTestPath(fileName) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fileName)
}

function canonicalSql(sql) {
  // Preserve all semantic text, including whitespace inside literals/comments.
  return sql.replace(/\r\n?/g, '\n')
}

function canonicalExpression(expression, sourceFile) {
  return expression.getText(sourceFile).replace(/\r\n?/g, '\n')
}

function operationForTag(node, method, sourceFile, fileName) {
  let sql = ts.isNoSubstitutionTemplateLiteral(node.template)
    ? node.template.text
    : node.template.head.text
  const expressions = []
  if (ts.isTemplateExpression(node.template)) {
    for (const span of node.template.templateSpans) {
      expressions.push(canonicalExpression(span.expression, sourceFile))
      sql += ` $${expressions.length} ${span.literal.text}`
    }
  }
  const canonical = canonicalSql(sql)
  const signatureInput = `${method}\0${canonical}\0${expressions.join('\0')}`
  return {
    file: fileName,
    method,
    hash: createHash('sha256').update(signatureInput).digest('hex'),
    bindings: expressions,
    sql: canonical,
  }
}

function unwrapExpression(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function constantString(node) {
  const current = unwrapExpression(node)
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(current.left)
    const right = constantString(current.right)
    return left === null || right === null ? null : left + right
  }
  return null
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return constantString(node.argumentExpression)
  return null
}

function isDbReceiver(node, aliases) {
  const current = unwrapExpression(node)
  if (ts.isIdentifier(current)) return current.text === 'db' || aliases.has(current.text)
  return ts.isPropertyAccessExpression(current) && current.name.text === 'db'
}

function collectDbAliases(sourceFile) {
  const aliases = new Set()
  const declarations = []
  const collect = (node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node)
    ts.forEachChild(node, collect)
  }
  collect(sourceFile)

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        isDbReceiver(declaration.initializer, aliases) &&
        !aliases.has(declaration.name.text)
      ) {
        aliases.add(declaration.name.text)
        changed = true
      }
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const sourceName =
            element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile)
          if (
            sourceName === 'db' &&
            ts.isIdentifier(element.name) &&
            !aliases.has(element.name.text)
          ) {
            aliases.add(element.name.text)
            changed = true
          }
        }
      }
    }
  }
  return aliases
}

function hasDirectRuntimePrismaImport(sourceFile) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return false
    if (statement.moduleSpecifier.text !== '@prisma/client') return false
    const clause = statement.importClause
    if (
      !clause ||
      clause.isTypeOnly ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      return false
    return clause.namedBindings.elements.some(
      (element) => !element.isTypeOnly && element.name.text === 'Prisma' && !element.propertyName,
    )
  })
}

function hasRuntimePrismaAliasImport(sourceFile) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return false
    if (statement.moduleSpecifier.text !== '@prisma/client') return false
    const clause = statement.importClause
    if (
      !clause ||
      clause.isTypeOnly ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      return false
    return clause.namedBindings.elements.some(
      (element) =>
        !element.isTypeOnly &&
        element.propertyName?.text === 'Prisma' &&
        element.name.text !== 'Prisma',
    )
  })
}

function isDirectRuntimePrismaAnyNull(node, hasPrismaImport) {
  return (
    hasPrismaImport &&
    ts.isIdentifier(node) &&
    node.text === 'Prisma' &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.name.text === 'AnyNull'
  )
}

function analyzeSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const operations = []
  const violations = []
  const dbAliases = collectDbAliases(sourceFile)
  const hasPrismaImport = hasDirectRuntimePrismaImport(sourceFile)
  if (hasRuntimePrismaAliasImport(sourceFile)) {
    violations.push(`${fileName}: Prisma namespace access is prohibited in production source`)
  }

  const isTypeOnlyReference = (node) => {
    let current = node
    while (current.parent) {
      current = current.parent
      if (ts.isTypeNode(current)) return true
      if (ts.isImportClause(current)) return current.isTypeOnly
      if (ts.isImportDeclaration(current) || ts.isStatement(current)) return false
    }
    return false
  }

  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === 'Prisma' &&
      !isTypeOnlyReference(node) &&
      !ts.isImportSpecifier(node.parent) &&
      !isDirectRuntimePrismaAnyNull(node, hasPrismaImport)
    ) {
      violations.push(`${fileName}: Prisma namespace access is prohibited in production source`)
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const specifier = node.arguments[0]
      if (
        (isDynamicImport || isRequire) &&
        specifier &&
        constantString(specifier) === '@prisma/client'
      ) {
        violations.push(`${fileName}: dynamic Prisma client access is prohibited`)
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Reflect' &&
        node.expression.name.text === 'get' &&
        node.arguments[0] &&
        isDbReceiver(node.arguments[0], dbAliases)
      ) {
        violations.push(`${fileName}: reflected database method access is prohibited`)
      }
    }

    const name = propertyName(node)
    if (name && rawMethods.has(name)) {
      if (ts.isElementAccessExpression(node)) {
        violations.push(`${fileName}: computed raw SQL reference ${name} is prohibited`)
      } else if (prohibitedMethods.has(name)) {
        violations.push(`${fileName}: Prisma raw method ${name} is prohibited`)
      } else if (!(ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node)) {
        violations.push(`${fileName}: ${name} must be used only as a direct tagged template`)
      } else {
        operations.push(operationForTag(node.parent, name, sourceFile, fileName))
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isTaggedTemplateExpression(node.parent) &&
      node.parent.tag === node &&
      name === null
    ) {
      violations.push(`${fileName}: computed tagged-template access is prohibited`)
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node &&
      !(
        fileName === 'packages/api/src/lib/character-artifact-storage.ts' &&
        ts.isPropertyAccessExpression(node.argumentExpression) &&
        ts.isIdentifier(node.argumentExpression.expression) &&
        node.argumentExpression.expression.text === 'Symbol' &&
        node.argumentExpression.name.text === 'asyncIterator' &&
        !isDbReceiver(node.expression, dbAliases)
      )
    ) {
      violations.push(`${fileName}: computed method calls are prohibited in production source`)
    }
    if (
      ts.isElementAccessExpression(node) &&
      name === null &&
      isDbReceiver(node.expression, dbAliases)
    ) {
      violations.push(`${fileName}: dynamic database method access is prohibited`)
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Prisma' &&
      prismaFragmentHelpers.has(node.name.text)
    ) {
      violations.push(`${fileName}: Prisma.${node.name.text} raw SQL fragments are prohibited`)
    }

    if (
      ts.isIdentifier(node) &&
      rawMethods.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      violations.push(`${fileName}: detached raw SQL reference ${node.text} is prohibited`)
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      rawMethods.has(node.text) &&
      !isTypeOnlyReference(node) &&
      !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
    ) {
      violations.push(`${fileName}: computed raw SQL reference ${node.text} is prohibited`)
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { operations, violations }
}

function operationKey(operation) {
  return `${operation.file}\0${operation.method}\0${operation.hash}`
}

function auditInventory(files, approved, effectOverrides = new Map()) {
  const violations = []
  const operations = []
  const approvedKeys = new Set()
  const approvedCounts = new Map()
  const approvedByKey = new Map()

  for (const entry of approved) {
    const key = operationKey(entry)
    if (approvedKeys.has(key)) violations.push(`duplicate raw SQL allowlist entry: ${key}`)
    approvedKeys.add(key)
    approvedByKey.set(key, entry)
    const count = entry.count === undefined ? 1 : entry.count
    if (!Number.isSafeInteger(count) || count < 1) {
      violations.push(`${entry.file}: invalid raw SQL occurrence count for ${entry.hash}`)
    } else {
      approvedCounts.set(key, count)
    }
    if (!approvedPolicies.has(entry.policy)) {
      violations.push(`${entry.file}: invalid or missing raw SQL policy '${entry.policy}'`)
    }
    const expectedEffect = effectOverrides.get(key)
    if (entry.effect !== undefined && !rawSqlEffects.has(entry.effect)) {
      violations.push(`${entry.file}: invalid raw SQL effect '${entry.effect}' for ${entry.hash}`)
    } else if (entry.effect !== undefined && expectedEffect === undefined) {
      violations.push(`${entry.file}: unapproved raw SQL effect override for ${entry.hash}`)
    } else if (entry.effect !== undefined && entry.effect !== expectedEffect) {
      violations.push(
        `${entry.file}: raw SQL effect override must be '${expectedEffect}' for ${entry.hash}`,
      )
    } else if (entry.effect === undefined && expectedEffect !== undefined) {
      violations.push(`${entry.file}: missing raw SQL effect override for ${entry.hash}`)
    }
  }
  for (const key of effectOverrides.keys()) {
    if (!approvedKeys.has(key)) violations.push(`stale raw SQL effect override: ${key}`)
  }

  for (const { fileName, source } of files) {
    if (isTestPath(fileName)) continue
    const result = analyzeSource(source, fileName)
    operations.push(...result.operations)
    violations.push(...result.violations)
  }

  const observedCounts = new Map()
  for (const operation of operations) {
    const key = operationKey(operation)
    const count = (observedCounts.get(key) ?? 0) + 1
    if (count > (approvedCounts.get(key) ?? 1)) {
      violations.push(`${operation.file}: duplicate raw SQL operation signature ${operation.hash}`)
    }
    observedCounts.set(key, count)
    if (!approvedKeys.has(key)) {
      violations.push(
        `${operation.file}: unapproved ${operation.method} signature ${operation.hash}`,
      )
    }
  }
  for (const entry of approved) {
    const key = operationKey(entry)
    const observed = observedCounts.get(key) ?? 0
    if (observed === 0) {
      violations.push(`${entry.file}: stale ${entry.method} signature ${entry.hash}`)
    } else if (approvedCounts.has(key) && observed !== approvedCounts.get(key)) {
      violations.push(
        `${entry.file}: expected ${approvedCounts.get(key)} occurrence(s), observed ${observed} for ${entry.hash}`,
      )
    }
  }

  return {
    operations: operations.map((operation) => {
      const entry = approvedByKey.get(operationKey(operation))
      return {
        ...operation,
        effect: entry?.effect ?? (operation.method === '$queryRaw' ? 'read' : 'write'),
      }
    }),
    violations,
  }
}

function expectFixtureFailure(name, files, approved, fragment) {
  const result = auditInventory(files, approved)
  if (!result.violations.some((violation) => violation.includes(fragment))) {
    throw new Error(`Raw SQL verifier failed its ${name} self-test`)
  }
}

function runSelfTests() {
  const fileName = 'packages/api/src/fixture.ts'
  const source = 'const rows = db.$queryRaw`SELECT id FROM places WHERE tenant_id = ${tenantId}`'
  const analyzed = analyzeSource(source, fileName)
  if (analyzed.violations.length > 0 || analyzed.operations.length !== 1) {
    throw new Error('Raw SQL verifier failed its clean parser self-test')
  }
  const approved = [{ ...analyzed.operations[0], policy: 'tenant-and-venue' }]
  const repeatedSource = `${source};\n${source.replace('const rows', 'const repeatedRows')}`
  const repeatedApproval = [{ ...approved[0], count: 2 }]
  if (auditInventory([{ fileName, source: repeatedSource }], repeatedApproval).violations.length) {
    throw new Error('Raw SQL verifier failed its exact repeated count self-test')
  }
  expectFixtureFailure(
    'undeclared repeated count',
    [{ fileName, source: repeatedSource }],
    approved,
    'duplicate raw SQL operation signature',
  )
  expectFixtureFailure(
    'missing repeated occurrence',
    [{ fileName, source }],
    repeatedApproval,
    'expected 2 occurrence(s), observed 1',
  )
  expectFixtureFailure(
    'excess repeated occurrence',
    [
      {
        fileName,
        source: `${repeatedSource};\n${source.replace('const rows', 'const extraRows')}`,
      },
    ],
    repeatedApproval,
    'expected 2 occurrence(s), observed 3',
  )
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    expectFixtureFailure(
      'invalid occurrence count',
      [{ fileName, source }],
      [{ ...approved[0], count }],
      'invalid raw SQL occurrence count',
    )
  }
  expectFixtureFailure(
    'duplicate counted allowlist row',
    [{ fileName, source: repeatedSource }],
    [...repeatedApproval, ...repeatedApproval],
    'duplicate raw SQL allowlist entry',
  )
  expectFixtureFailure(
    'new signature beside counted operation',
    [{ fileName, source: `${repeatedSource};\n${source.replace('tenantId', 'foreignTenantId')}` }],
    repeatedApproval,
    'unapproved $queryRaw signature',
  )
  if (auditInventory([{ fileName, source }], approved).violations.length > 0) {
    throw new Error('Raw SQL verifier failed its clean inventory self-test')
  }

  const exactEffectOverrides = new Map([[operationKey(approved[0]), 'write']])
  const effectResult = auditInventory(
    [{ fileName, source }],
    [{ ...approved[0], effect: 'write' }],
    exactEffectOverrides,
  )
  if (effectResult.violations.length > 0 || effectResult.operations[0]?.effect !== 'write') {
    throw new Error('Raw SQL verifier failed its exact effect override self-test')
  }
  expectFixtureFailure(
    'unapproved effect override',
    [{ fileName, source }],
    [{ ...approved[0], effect: 'write' }],
    'unapproved raw SQL effect override',
  )
  expectFixtureFailure(
    'invalid effect override',
    [{ fileName, source }],
    [{ ...approved[0], effect: 'execute' }],
    'invalid raw SQL effect',
  )
  const missingEffectResult = auditInventory([{ fileName, source }], approved, exactEffectOverrides)
  if (
    !missingEffectResult.violations.some((violation) =>
      violation.includes('missing raw SQL effect'),
    )
  ) {
    throw new Error('Raw SQL verifier failed its missing effect override self-test')
  }
  const wrongEffectResult = auditInventory(
    [{ fileName, source }],
    [{ ...approved[0], effect: 'read' }],
    exactEffectOverrides,
  )
  if (!wrongEffectResult.violations.some((violation) => violation.includes("must be 'write'"))) {
    throw new Error('Raw SQL verifier failed its mismatched effect override self-test')
  }
  const staleEffectResult = auditInventory([], [], exactEffectOverrides)
  if (
    !staleEffectResult.violations.some((violation) => violation.includes('stale raw SQL effect'))
  ) {
    throw new Error('Raw SQL verifier failed its stale effect override self-test')
  }

  const literalWhitespaceA = analyzeSource(
    "const rows = db.$queryRaw`SELECT 'a b' WHERE tenant_id = ${tenantId}`",
    fileName,
  ).operations[0]
  const literalWhitespaceB = analyzeSource(
    "const rows = db.$queryRaw`SELECT 'a  b' WHERE tenant_id = ${tenantId}`",
    fileName,
  ).operations[0]
  if (!literalWhitespaceA || literalWhitespaceA.hash === literalWhitespaceB?.hash) {
    throw new Error('Raw SQL verifier failed its literal-whitespace collision self-test')
  }
  expectFixtureFailure(
    'semantic drift',
    [{ fileName, source: source.replace('tenant_id', 'venue_id') }],
    approved,
    'unapproved',
  )
  expectFixtureFailure(
    'binding drift',
    [{ fileName, source: source.replace('${tenantId}', '${venueId}') }],
    approved,
    'unapproved',
  )
  expectFixtureFailure(
    'unsafe method',
    [{ fileName, source: 'db.$queryRawUnsafe("SELECT 1")' }],
    [],
    'Prisma raw method $queryRawUnsafe is prohibited',
  )
  expectFixtureFailure(
    'function call',
    [{ fileName, source: 'db.$queryRaw("SELECT 1")' }],
    [],
    'direct tagged template',
  )
  expectFixtureFailure(
    'detached alias',
    [{ fileName, source: 'const { $queryRaw } = db; $queryRaw`SELECT 1`' }],
    [],
    'detached raw SQL reference',
  )
  expectFixtureFailure(
    'element access',
    [{ fileName, source: 'db["$queryRaw"]`SELECT 1`' }],
    [],
    'computed raw SQL reference',
  )
  expectFixtureFailure(
    'computed concatenation',
    [{ fileName, source: "db['$query' + 'Raw']`SELECT 1`" }],
    [],
    'computed raw SQL reference',
  )
  expectFixtureFailure(
    'dynamic computed tag',
    [{ fileName, source: 'const method = getMethod(); db[method]`SELECT 1`' }],
    [],
    'computed tagged-template access',
  )
  expectFixtureFailure(
    'dynamic database method',
    [{ fileName, source: 'const client = db; const method = getMethod(); client[method](query)' }],
    [],
    'dynamic database method access',
  )
  expectFixtureFailure(
    'wrapped dynamic method',
    [
      {
        fileName,
        source: 'const holder = { client: db }; holder.client[getMethod()](query)',
      },
    ],
    [],
    'computed method calls are prohibited',
  )
  expectFixtureFailure(
    'reflected database method',
    [{ fileName, source: 'Reflect.get(db, method)(query)' }],
    [],
    'reflected database method access',
  )
  expectFixtureFailure(
    'typed raw',
    [{ fileName, source: 'db.$queryRawTyped(query)' }],
    [],
    'Prisma raw method $queryRawTyped is prohibited',
  )
  expectFixtureFailure(
    'Prisma fragment',
    [{ fileName, source: 'const fragment = Prisma.sql`tenant_id = ${tenantId}`' }],
    [],
    'raw SQL fragments are prohibited',
  )
  expectFixtureFailure(
    'Prisma alias',
    [
      {
        fileName,
        source: "import { Prisma as P } from '@prisma/client'; P.sql`SELECT 1`",
      },
    ],
    [],
    'Prisma namespace access is prohibited',
  )
  const typeOnlyPrisma = analyzeSource(
    "import type { Prisma } from '@prisma/client'; type Json = Prisma.InputJsonValue",
    fileName,
  )
  if (typeOnlyPrisma.violations.length > 0) {
    throw new Error('Raw SQL verifier rejected a type-only Prisma namespace self-test')
  }
  const directAnyNull = analyzeSource(
    "import { Prisma } from '@prisma/client'; const value = Prisma.AnyNull",
    fileName,
  )
  if (directAnyNull.violations.length > 0) {
    throw new Error('Raw SQL verifier rejected direct runtime Prisma.AnyNull self-test')
  }
  expectFixtureFailure(
    'aliased Prisma.AnyNull',
    [
      {
        fileName,
        source: "import { Prisma as P } from '@prisma/client'; const value = P.AnyNull",
      },
    ],
    [],
    'Prisma namespace access is prohibited',
  )
  expectFixtureFailure(
    'Prisma raw helper after AnyNull allowance',
    [
      {
        fileName,
        source: "import { Prisma } from '@prisma/client'; const fragment = Prisma.raw('SELECT 1')",
      },
    ],
    [],
    'Prisma.raw raw SQL fragments are prohibited',
  )
  expectFixtureFailure(
    'computed Prisma.AnyNull',
    [
      {
        fileName,
        source: "import { Prisma } from '@prisma/client'; const value = Prisma['AnyNull']",
      },
    ],
    [],
    'Prisma namespace access is prohibited',
  )
  const typeOnlyClient = analyzeSource("type Client = Pick<typeof db, '$queryRaw'>", fileName)
  if (typeOnlyClient.violations.length > 0) {
    throw new Error('Raw SQL verifier rejected a type-only client method selection')
  }
  const artifactIterator = analyzeSource(
    'const iterator = body[Symbol.asyncIterator]()',
    'packages/api/src/lib/character-artifact-storage.ts',
  )
  if (artifactIterator.violations.length > 0) {
    throw new Error('Raw SQL verifier rejected reviewed artifact stream iteration')
  }
  expectFixtureFailure(
    'runtime method string remains prohibited',
    [{ fileName, source: "const method = '$queryRaw'; client[method](query)" }],
    [],
    'computed raw SQL reference',
  )
  expectFixtureFailure(
    'symbol does not bypass database receiver checks',
    [
      {
        fileName: 'packages/api/src/lib/character-artifact-storage.ts',
        source: 'db[Symbol.asyncIterator]()',
      },
    ],
    [],
    'computed method calls are prohibited',
  )
  expectFixtureFailure(
    'dynamic Prisma access',
    [{ fileName, source: "const p = await import('@prisma/client')" }],
    [],
    'dynamic Prisma client access is prohibited',
  )
  expectFixtureFailure('stale allowlist', [], approved, 'stale')
  expectFixtureFailure(
    'duplicate allowlist',
    [{ fileName, source }],
    [...approved, ...approved],
    'duplicate raw SQL allowlist entry',
  )
}

runSelfTests()

const sourceFiles = (
  await Promise.all(
    ['apps', 'packages'].map((directory) => collectFiles(path.join(repositoryRoot, directory))),
  )
).flat()
const files = await Promise.all(
  sourceFiles.map(async (absolute) => ({
    fileName: relativePath(absolute),
    source: await readFile(absolute, 'utf8'),
  })),
)
const result = auditInventory(files, approvedOperations, approvedEffectOverrides)

if (process.argv.includes('--print-inventory')) {
  console.log(JSON.stringify(result.operations, null, 2))
  if (result.violations.length > 0) {
    console.error('Raw SQL boundary violations:')
    for (const violation of [...new Set(result.violations)].sort()) console.error(`- ${violation}`)
    process.exit(1)
  }
  process.exit(0)
}

if (result.violations.length > 0) {
  console.error('Raw SQL boundary violations:')
  for (const violation of [...new Set(result.violations)].sort()) console.error(`- ${violation}`)
  process.exit(1)
}

const reads = result.operations.filter((operation) => operation.effect === 'read').length
const writes = result.operations.length - reads
console.log(
  `Verified ${result.operations.length} raw SQL operations: ${reads} reads, ${writes} writes.`,
)
