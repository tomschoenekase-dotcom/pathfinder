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
  'tenant-intake-proposal-request-lock',
  'tenant-intake-website-research-lock',
  'tenant-client-assistant-preference-lock',
  'tenant-client-assistant-turn-operation-lock',
  'tenant-client-assistant-thread-lock',
  'tenant-client-assistant-generation-lock',
  'tenant-client-assistant-completion-lock',
  'tenant-client-assistant-handoff-lock',
  'tenant-customer-access-request-lock',
  'tenant-first-week-review-lock',
  'tenant-support-operation-lock',
  'tenant-support-agent-run-operation-lock',
  'tenant-support-request-lineage-lock',
  'tenant-guest-chat-turn-lock',
  'tenant-venue-voice-quota-lock',
  'platform-prospect-mailbox-send-reservation-lock',
  'platform-prospect-campaign-send-reservation-lock',
])

// Hashes bind exact SQL template and interpolation text; only CRLF/LF differences are normalized.
// Run with --print-inventory after a reviewed query change, then update only the intended entry.
const approvedOperations = [
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
    method: '$executeRaw',
    hash: '97e65da8188e2a7988bd7afe8ac2091a6fa8552d036cf92031bcd6a28dbc96a1',
    policy: 'system-probe',
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
  {
    file: 'packages/api/src/routers/chat.ts',
    method: '$queryRaw',
    hash: 'faa1ef0aa5d4570ff4b33d05ac666ef03b8229afe03e94dec0e1980049012e36',
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
    hash: 'a0b3e2a9d6e5dd6aa9c9a3f948ce6732c7d1c5933274d3bf3521cf14b997b07f',
    policy: 'public-venue-session-token',
  },
  {
    file: 'packages/api/src/routers/venue.ts',
    method: '$queryRaw',
    hash: '08e5613e8e664eff6ce54816cb84b07d58e875a62eb9efc57ba62e35decb3a36',
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
    file: 'packages/db/src/helpers/support-actions.ts',
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
    hash: '1b2d60ffbbfc05eeb54b73f5d5f3a29bf030f7b9b1786f1861f9fd66749c7660',
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
    '71af5dd181a87025efa2d1f47a96afd053926d5cfd798317c56a1c678220aac2',
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
    hash: '432e3793aad3435f27b780e999a8548b1d34e3c42ea130ef26a2af7a4b0f3993',
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
    hash: '0b6d3752a65471da430efad03bc0c607efbca8e5717da33575f662f71472d0b3',
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
    hash: '1d4774bf0591eae85be4d3405f95da8fc6f21a6cd51df44276160ca6eb2e97cf',
    policy: 'public-venue-session-token',
  },
  {
    file: 'packages/api/src/routers/widget.ts',
    method: '$queryRaw',
    hash: 'c459b550f7fb55a4454ca8c33f8959b27c97bfe844e3c99d37a980f5df913d58',
    policy: 'public-venue-slug',
  },
]

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

function analyzeSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const operations = []
  const violations = []
  const dbAliases = collectDbAliases(sourceFile)

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
    if (ts.isIdentifier(node) && node.text === 'Prisma' && !isTypeOnlyReference(node)) {
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
      node.parent.expression === node
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

function auditInventory(files, approved) {
  const violations = []
  const operations = []
  const approvedKeys = new Set()

  for (const entry of approved) {
    const key = operationKey(entry)
    if (approvedKeys.has(key)) violations.push(`duplicate raw SQL allowlist entry: ${key}`)
    approvedKeys.add(key)
    if (!approvedPolicies.has(entry.policy)) {
      violations.push(`${entry.file}: invalid or missing raw SQL policy '${entry.policy}'`)
    }
  }

  for (const { fileName, source } of files) {
    if (isTestPath(fileName)) continue
    const result = analyzeSource(source, fileName)
    operations.push(...result.operations)
    violations.push(...result.violations)
  }

  const observedKeys = new Set()
  for (const operation of operations) {
    const key = operationKey(operation)
    if (observedKeys.has(key)) {
      violations.push(`${operation.file}: duplicate raw SQL operation signature ${operation.hash}`)
    }
    observedKeys.add(key)
    if (!approvedKeys.has(key)) {
      violations.push(
        `${operation.file}: unapproved ${operation.method} signature ${operation.hash}`,
      )
    }
  }
  for (const entry of approved) {
    if (!observedKeys.has(operationKey(entry))) {
      violations.push(`${entry.file}: stale ${entry.method} signature ${entry.hash}`)
    }
  }

  return { operations, violations }
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
  if (auditInventory([{ fileName, source }], approved).violations.length > 0) {
    throw new Error('Raw SQL verifier failed its clean inventory self-test')
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
const result = auditInventory(files, approvedOperations)

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

const reads = result.operations.filter((operation) => operation.method === '$queryRaw').length
const writes = result.operations.length - reads
console.log(
  `Verified ${result.operations.length} raw SQL operations: ${reads} reads, ${writes} writes.`,
)
