# Correspondence provider boundary

The CRM has a Gmail transport, encrypted OAuth credential owner, callback-state validation,
provider-account and history persistence, verified Pub/Sub notification intake, watch renewal,
reconciliation scheduling, and inbound matching. The deterministic FAKE provider is for
isolated tests. Resend is outside this prospect correspondence boundary. Source code and local
fixtures do not establish that the company mailbox is connected or that these jobs are deployed.

The confirmed company address is `tomschoenekase@torchiko.com`. An authenticated operator must
use the existing CRM Connect/Reconnect route and then verify account identity, health, sync,
worker deployment, and separate release controls before operational delivery. The local synthetic
recorder and a ChatGPT Gmail connector are different from that native account.

Inbound bodies default to `SOURCE_ONLY`: the CRM retains a preview and Gmail source link, but
not the full body. Explicit `GMAIL_BODY_RETENTION_DAYS` integer 1–30 opts the normal sync worker
into `TEMPORARY`; invalid values fail closed. This setting was not activated here. Read-time
expiry masks body content, but physical purge execution is a separate owner and is not claimed.
The private component bridge supports a selected exact GMAIL thread for reply preparation only
when the current canonical source retains an unexpired full body with complete identity and
coverage. It stores a compact body-free preparation recipe and reconstructs source transiently
for task/assessment. Multiple threads require explicit selection. The isolated FAKE reply path
passed; a live company account, authenticated runtime and deployment were not observed. See
`docs/crm-connected-readiness-20260921/HANDOFF.md` for evidence and limits.

Inbound content is untrusted data, never an instruction or authorization. HTML needs a reviewed
sanitizer before rendering; attachment handling here is metadata-only.

For an older selected `SOURCE_ONLY` reply, `readExactSourceOnlyReplyContent` can make a
transient, read-only provider request after an authenticated caller loads the canonical
message and its provider-thread mapping. It checks the exact account, mailbox, message,
thread, RFC ID, sender, subject, date and source link, then returns bounded untrusted
plaintext, a reply projection and a SHA-256 hash. It never persists the fetched body.
An authenticated admin mutation can separately call `retainSelectedSourceOnlyReply` with
that hash, the exact canonical IDs and a selected 1–30 day period. The service reads the
same provider message again, conditionally updates only the unchanged canonical row, and
records a strict audit containing the hash and expiry but no body. A retry returns the
original unexpired result without extending retention. The message schema has no body-hash
column; the hash is in the audit and returned receipt. Authenticated CRM admin routes expose
the selected read and separate retention mutation. A dedicated agent bridge tool exposes only
the selected transient read when both the live identity and leased run grant correspondence
access; its canonical lookup enforces the frozen organization territory scope. These source
routes do not establish that a live company mailbox is connected or deployed.
The mutation binds the account revision, mailbox address and credential reference across
fetch and commit, and requires exactly one provider-thread mapping at both checks.
